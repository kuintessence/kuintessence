import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { Logger } from "pino";
import { runWithMtlsContext } from "../auth/mtls-context";
import { type MtlsHeaderGuardConfig, mtlsHeaderGuard } from "../auth/mtls-wire";
import { isTrustedProxyAddress, parseTrustedProxyCidrs } from "../auth/trusted-proxy";
import type { AgentManager } from "../services/agent-manager";
import type { DataDeliveryRevocationOutbox } from "../services/data-delivery-revocations";
import type { JobLogsService } from "../services/job-logs-service";
import type { JobService } from "../services/job-service";
import type { QueueInventoryService } from "../services/queue-inventory";
import type { QueueObservabilityService } from "../services/queue-observability";
import type { SandboxArtifactReleaseService } from "../services/sandbox-artifact-release";
import type { ShellExecRegistry } from "../services/shell-exec-registry";
import type { SshGateway } from "../services/ssh-gateway";
import type { TransferRegistry } from "../services/transfer-registry";
import type { InstalledRegistry } from "../software-governance/installed-registry";
import type { SoftwareOperationService } from "../software-governance/operation-service";
import type { PolicyPusher } from "../software-governance/policy-pusher";
import type { PolicyStore } from "../software-governance/policy-store";
import type { JobCompletionRegistry } from "../workflow/job-completion-registry";
import { type AgentMetricsRecorder, registerAgentHandler } from "./agent-handler";
import type {
  AgentDispatcher,
  JobCancellationOutbox,
  JobWorkRootReleaseOutbox,
} from "./dispatcher";

export type GrpcNodeHttpHandler = ReturnType<typeof connectNodeAdapter>;
type GrpcServerRequest = Parameters<GrpcNodeHttpHandler>[0];
type GrpcServerResponse = Parameters<GrpcNodeHttpHandler>[1];

export interface CreateGrpcHandlerDeps {
  agentManager: AgentManager;
  jobService: JobService;
  logger: Logger;
  dispatcher: AgentDispatcher;
  installedRegistry?: InstalledRegistry;
  softwareOperations?: SoftwareOperationService;
  policyStore?: PolicyStore;
  policyPusher?: PolicyPusher;
  metricsRecorder?: AgentMetricsRecorder;
  queueInventory?: QueueInventoryService;
  queueObservability?: Pick<QueueObservabilityService, "recordEvent">;
  sshGateway?: SshGateway;
  shellExecRegistry?: ShellExecRegistry;
  jobLogsService?: JobLogsService;
  transferRegistry?: TransferRegistry;
  jobCompletionRegistry?: JobCompletionRegistry;
  partUrlMinter?: {
    mintPartUrlsFor(
      requestId: string,
      partNumbers: number[],
    ): Promise<{ partNumber: number; url: string }[]>;
  };
  sandboxArtifactRelease?: Pick<SandboxArtifactReleaseService, "resolve">;
  dataDeliveryRevocations?: Pick<DataDeliveryRevocationOutbox, "acknowledge" | "redeliver">;
  jobCancellations?: Pick<JobCancellationOutbox, "acknowledge" | "redeliver">;
  jobWorkRootReleases?: Pick<JobWorkRootReleaseOutbox, "acknowledge" | "redeliver">;
}

export interface GrpcTransportTrustConfig extends MtlsHeaderGuardConfig {
  readonly trustedProxyCidrs?: string;
  readonly useVerifiedPeerCertificate?: boolean;
}

/**
 * Build the production Node HTTP handler used for the Agent bidi stream.
 * connectNodeAdapter writes response frames independently of the still-open
 * request stream, which is required for register acknowledgements and Server
 * dispatches to reach the Agent.
 */
export function createGrpcConnectNodeHandler(
  deps: CreateGrpcHandlerDeps,
  mtlsConfig: GrpcTransportTrustConfig,
): GrpcNodeHttpHandler {
  const connectHandler = connectNodeAdapter({
    routes(router) {
      registerAgentHandler(router, deps);
    },
    acceptCompression: [],
    readMaxBytes: 0xffffffff,
    writeMaxBytes: 0xffffffff,
  });
  const guard = mtlsHeaderGuard(mtlsConfig);
  const trustedProxyCidrs =
    mtlsConfig.trustedProxyCidrs === undefined
      ? null
      : parseTrustedProxyCidrs(mtlsConfig.trustedProxyCidrs);

  return (req, res) => {
    void (async () => {
      if (
        trustedProxyCidrs &&
        !isTrustedProxyAddress(req.socket.remoteAddress, trustedProxyCidrs)
      ) {
        await writeFetchResponse(
          res,
          new Response(
            JSON.stringify({
              error: {
                code: "MTLS_REJECTED",
                message: "request did not originate from a trusted mTLS proxy",
              },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
        );
        return;
      }
      const headers = nodeHeadersToWebHeaders(req);
      if (mtlsConfig.useVerifiedPeerCertificate) {
        const fingerprint = verifiedPeerFingerprint(req);
        if (fingerprint) {
          headers.set(mtlsConfig.fingerprintHeader ?? "x-agent-cert-fingerprint", fingerprint);
        }
      }
      const verdict = await guard(
        new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
          headers,
        }),
      );
      if (!verdict.ok) {
        await writeFetchResponse(res, verdict.response);
        return;
      }
      await runWithMtlsContext(
        {
          agentId: verdict.agentId,
          fingerprintSha256: verdict.fingerprintSha256,
        },
        async () => connectHandler(req, res),
      );
    })().catch((error) => {
      if (res.destroyed) return;
      deps.logger.error({ err: error }, "Agent gRPC request failed before Connect dispatch");
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
}

function verifiedPeerFingerprint(req: GrpcServerRequest): string | null {
  const socket = req.socket as typeof req.socket & {
    getPeerCertificate?: () => { readonly fingerprint256?: string };
  };
  const fingerprint = socket.getPeerCertificate?.().fingerprint256;
  return fingerprint ? fingerprint.replaceAll(":", "").toLowerCase() : null;
}

function nodeHeadersToWebHeaders(req: GrpcServerRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

/**
 * Build a fetch-compatible handler for the connectRPC Agent service.
 *
 * The returned function signature is `(req: Request) => Promise<Response>`,
 * which Bun.serve accepts directly as its `fetch` option.
 *
 * Routing: connectRPC uses HTTP POST with paths like
 *   `/kuintessence.v1.AgentService/Connect`
 * Each UniversalHandler registered on the router carries a `requestPath`
 * property. We iterate the handlers array to find a matching one, then
 * delegate to a per-handler fetch adapter created by `createFetchHandler`.
 */
export function createGrpcFetchHandler(
  deps: CreateGrpcHandlerDeps,
): (req: Request) => Promise<Response> {
  const router = createConnectRouter();
  registerAgentHandler(router, deps);

  // Build a map from requestPath → fetch handler for O(1) dispatch.
  const handlersByPath = new Map<string, (req: Request) => Promise<Response>>();
  for (const universalHandler of router.handlers) {
    const fetchHandler = createFetchHandler(universalHandler);
    handlersByPath.set(universalHandler.requestPath, fetchHandler);
  }

  return async function grpcFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const handler = handlersByPath.get(url.pathname);

    if (!handler) {
      return new Response("Not found", { status: 404 });
    }

    return handler(req);
  };
}

async function writeFetchResponse(res: GrpcServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}
