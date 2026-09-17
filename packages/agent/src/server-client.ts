import { createClient } from "@connectrpc/connect";
import { type ConnectTransportOptions, createConnectTransport } from "@connectrpc/connect-node";
import { AgentService } from "@kuintessence/proto";

/**
 * mTLS-aware fetch builder for the connectRPC client.
 *
 * Two modes:
 *  - `enabled: false`: returns `globalThis.fetch` unchanged. Used in dev
 *    where Agent ↔ Server talks plain HTTP/2 over connectRPC.
 *  - `enabled: true`: returns a fetch that (a) presents the Agent's client
 *    cert/key in the TLS handshake via Bun's `tls: {cert, key, ca}` fetch
 *    option (when the PEMs are provided), and (b) injects the cert fingerprint
 *    via `X-Agent-Cert-Fingerprint`, which the Server maps to an agentId via the
 *    cert ledger. Bun's client-cert fetch support was verified on 1.2.8 (tbd
 *    #14); the TLS option is attached only for https:// calls. Plain http://
 *    dev streams still carry the fingerprint header but must not receive a
 *    TLS init option, otherwise Bun can stall long-lived bidi fetch calls.
 *
 * The `OutboundQueue` and `InboundAcks` are transport-agnostic — they
 * never touch fetch directly — so wrapping the fetch here is sufficient
 * to make all gRPC traffic mTLS-aware without touching queue code.
 */
export interface ClientFetchMtlsConfig {
  readonly enabled: boolean;
  readonly fingerprintSha256?: string;
  readonly certPem?: string;
  readonly keyPem?: string;
  readonly caCertPem?: string;
}

export interface BuildClientFetchInput {
  readonly mtls: ClientFetchMtlsConfig;
  /** Override for testing. Defaults to globalThis.fetch. */
  readonly baseFetch?: typeof fetch;
}

export interface ServerTransportLivenessConfig {
  readonly pingIntervalMs: number;
  readonly pingTimeoutMs: number;
}

export type ServerReachabilityProbe = (signal: AbortSignal) => Promise<void>;

const DEFAULT_SERVER_TRANSPORT_LIVENESS: ServerTransportLivenessConfig = {
  pingIntervalMs: 30_000,
  pingTimeoutMs: 10_000,
};

export function createServerReachabilityProbe(
  serverGrpcUrl: string,
  mtls: ClientFetchMtlsConfig,
  timeoutMs: number,
  baseFetch?: typeof fetch,
): ServerReachabilityProbe {
  const healthUrl = new URL("/health", serverGrpcUrl);
  const probeFetch = buildClientFetch({ mtls, ...(baseFetch ? { baseFetch } : {}) });
  return async (parentSignal) => {
    if (parentSignal.aborted) {
      throw parentSignal.reason instanceof Error
        ? parentSignal.reason
        : new Error("Server reachability probe aborted");
    }
    const controller = new AbortController();
    let rejectGuard: (reason: Error) => void = () => {};
    const guard = new Promise<never>((_resolve, reject) => {
      rejectGuard = reject;
    });
    const onParentAbort = () => {
      const reason =
        parentSignal.reason instanceof Error
          ? parentSignal.reason
          : new Error("Server reachability probe aborted");
      controller.abort(reason);
      rejectGuard(reason);
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => {
      const reason = new Error("Server reachability probe timed out");
      controller.abort(reason);
      rejectGuard(reason);
    }, timeoutMs);
    try {
      const response = await Promise.race([
        probeFetch(healthUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        }),
        guard,
      ]);
      await response.body?.cancel();
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  };
}

export function buildClientFetch(input: BuildClientFetchInput): typeof fetch {
  const base = input.baseFetch ?? globalThis.fetch;
  if (!input.mtls.enabled) return base;

  const fp = input.mtls.fingerprintSha256;
  if (!fp) {
    throw new Error("mtls.fingerprintSha256 is required when mtls.enabled=true");
  }

  const tlsInit: RequestInit | undefined =
    input.mtls.certPem && input.mtls.keyPem
      ? ({
          tls: {
            cert: input.mtls.certPem,
            key: input.mtls.keyPem,
            ...(input.mtls.caCertPem ? { ca: input.mtls.caCertPem } : {}),
          },
        } as RequestInit)
      : undefined;

  return ((input2: Request | string | URL, init?: RequestInit) => {
    const headers = new Headers(input2 instanceof Request ? input2.headers : (init?.headers ?? {}));
    headers.set("x-agent-cert-fingerprint", fp);
    const mtlsInit = tlsInit && isHttpsRequest(input2) ? tlsInit : {};
    if (input2 instanceof Request) {
      // Do not re-create the Request here: connectRPC may pass a live
      // streaming body, and cloning it can stall bidi calls under Bun.
      return base(input2, { ...init, headers, ...mtlsInit });
    }
    return base(input2, { ...init, headers, ...mtlsInit });
  }) as typeof fetch;
}

function isHttpsRequest(input: Request | string | URL): boolean {
  const url = input instanceof Request ? input.url : input.toString();
  return new URL(url).protocol === "https:";
}

/**
 * Create a connectRPC client for the AgentService.
 *
 * The Node HTTP transport has no implicit total-request timeout, so the
 * bidirectional Agent stream can remain open beyond Bun fetch's five-minute
 * request lifetime while still carrying the mTLS certificate and fingerprint.
 */
export function createServerClient(
  serverGrpcUrl: string,
  mtls: ClientFetchMtlsConfig = { enabled: false },
  liveness: ServerTransportLivenessConfig = DEFAULT_SERVER_TRANSPORT_LIVENESS,
) {
  const transport = createConnectTransport(
    buildServerTransportOptions(serverGrpcUrl, mtls, liveness),
  );
  return createClient(AgentService, transport);
}

export function buildServerTransportOptions(
  serverGrpcUrl: string,
  mtls: ClientFetchMtlsConfig = { enabled: false },
  liveness: ServerTransportLivenessConfig = DEFAULT_SERVER_TRANSPORT_LIVENESS,
): Extract<ConnectTransportOptions, { httpVersion: "2" }> {
  if (mtls.enabled && !mtls.fingerprintSha256) {
    throw new Error("mtls.fingerprintSha256 is required when mtls.enabled=true");
  }
  const isHttps = new URL(serverGrpcUrl).protocol === "https:";
  const nodeOptions = {
    ...(mtls.fingerprintSha256
      ? { headers: { "x-agent-cert-fingerprint": mtls.fingerprintSha256 } }
      : {}),
    ...(isHttps && mtls.certPem && mtls.keyPem
      ? {
          cert: mtls.certPem,
          key: mtls.keyPem,
          ...(mtls.caCertPem ? { ca: mtls.caCertPem } : {}),
        }
      : {}),
  };
  return {
    httpVersion: "2",
    baseUrl: serverGrpcUrl,
    pingIntervalMs: liveness.pingIntervalMs,
    pingTimeoutMs: liveness.pingTimeoutMs,
    nodeOptions,
    useBinaryFormat: true,
    interceptors: [],
    acceptCompression: [],
    compressMinBytes: 1024,
    readMaxBytes: 0xffffffff,
    writeMaxBytes: 0xffffffff,
  };
}

export type ServerClient = ReturnType<typeof createServerClient>;
