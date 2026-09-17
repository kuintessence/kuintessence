import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateCsr, persistCertBundle } from "@kuintessence/agent/auth";
import type { Command } from "commander";
import { createAgentServer } from "../agent-serve/server";
import { ApiClient } from "../lib/api-client";
import { loadCliConfig } from "../lib/config";
import {
  detectLocalAdapter,
  localSchedulerErrorMessage,
  parseScheduler,
} from "../lib/local-scheduler";
import { expandTilde, selectBackend } from "../tui/backend/select";

interface AgentRow {
  agentId: string;
  siteName: string;
  schedulerType: string;
  schedulerVersion: string;
  status: string;
}

interface AgentRegistrationTokenResponse {
  id: string;
  agentId: string;
  siteName: string;
  providerOrgId: string;
  token: string;
  expiresAt: string;
}

interface AgentRegistrationMetadataResponse {
  agentId: string;
  siteName: string;
  providerOrgId: string;
  expiresAt: string;
}

interface AgentRegistrationCompleteResponse {
  agentId: string;
  siteName: string;
  providerOrgId: string;
  certPem: string;
  caCertPem: string;
  fingerprintSha256: string;
  expiresAt: string;
}

const DEFAULT_SERVE_PORT = 8787;
const DEFAULT_SERVE_HOST = "127.0.0.1";
const DEFAULT_AGENT_TOKEN_TTL_SEC = 24 * 60 * 60;

/** Validate a `--port` value into a TCP port. Pure + exported for testing. */
export function parseServePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port "${value}". Expected an integer in 1–65535.`);
  }
  return port;
}

/**
 * Register the `kq agent` subcommand group.
 *
 * Usage:
 *   kq agent list
 *   kq agent serve --port 8787 [--host 0.0.0.0] [--token T] [--scheduler slurm]
 */
export function registerAgentCommand(program: Command): void {
  const a = program.command("agent").description("Agent operations");

  const token = a.command("token").description("Agent registration token operations");

  token
    .command("create")
    .description("Create a one-time Agent registration token for a compute provider")
    .requiredOption("--provider-org <uuid>", "Provider organization id")
    .requiredOption("--agent-id <id>", "Pre-allocated Agent id")
    .requiredOption("--site-name <name>", "Human-readable site name")
    .option("--ttl-sec <n>", `Token lifetime in seconds (default ${DEFAULT_AGENT_TOKEN_TTL_SEC})`)
    .action(
      async (opts: { providerOrg: string; agentId: string; siteName: string; ttlSec?: string }) => {
        const config = loadCliConfig();
        const client = ApiClient.fromConfig(config);
        const expiresInSec = opts.ttlSec ? parsePositiveInt(opts.ttlSec, "--ttl-sec") : undefined;
        const r = await client.post<AgentRegistrationTokenResponse>(
          "/cp/agent-registration-tokens",
          {
            providerOrgId: opts.providerOrg,
            agentId: opts.agentId,
            siteName: opts.siteName,
            expiresInSec: expiresInSec ?? DEFAULT_AGENT_TOKEN_TTL_SEC,
          },
        );
        console.log(`Agent registration token created for ${r.agentId}`);
        console.log(`Provider: ${r.providerOrgId}`);
        console.log(`Expires: ${r.expiresAt}`);
        console.log(`Token: ${r.token}`);
      },
    );

  a.command("register")
    .description("Register this node as a Server Agent with a one-time registration token")
    .requiredOption("--url <url>", "Server HTTP URL, for example https://server.example.com")
    .requiredOption("--grpc-url <url>", "Server connectRPC URL used by the Agent runtime")
    .requiredOption("--token <token>", "One-time Agent registration token")
    .option("--output-dir <path>", "Output directory (default ~/.kuintessence/agent/<agentId>)")
    .option(
      "--scheduler <type>",
      "Force scheduler type (slurm|pbs-pro|torque|kubernetes); default auto-detect",
    )
    .action(
      async (opts: {
        url: string;
        grpcUrl: string;
        token: string;
        outputDir?: string;
        scheduler?: string;
      }) => {
        const scheduler = opts.scheduler ? parseScheduler(opts.scheduler) : undefined;
        const metadata = await registrationPost<AgentRegistrationMetadataResponse>(
          opts.url,
          "/agent-registration/metadata",
          { token: opts.token },
        );
        const adapter = await detectLocalAdapter(scheduler).catch((err) => {
          throw new Error(
            localSchedulerErrorMessage(
              "agent register",
              err,
              "or pass --scheduler when auto-detection is ambiguous",
            ),
          );
        });
        const { csrPem, privateKeyPem } = generateCsr({ agentId: metadata.agentId });
        const completed = await registrationPost<AgentRegistrationCompleteResponse>(
          opts.url,
          "/agent-registration/complete",
          {
            token: opts.token,
            csrPem,
            schedulerType: adapter.type,
            schedulerVersion: adapter.version,
          },
        );
        const outputDir = opts.outputDir
          ? expandTilde(opts.outputDir, homedir())
          : join(homedir(), ".kuintessence", "agent", completed.agentId);
        await writeAgentRegistrationFiles({
          outputDir,
          serverHttpUrl: opts.url,
          serverGrpcUrl: opts.grpcUrl,
          agentId: completed.agentId,
          siteName: completed.siteName,
          certPem: completed.certPem,
          keyPem: privateKeyPem,
          caCertPem: completed.caCertPem,
        });
        console.log(
          `Registered Agent ${completed.agentId} for provider ${completed.providerOrgId}`,
        );
        console.log(`Config: ${join(outputDir, "agent.env")}`);
        console.log(`Certs: ${join(outputDir, "certs")}`);
        console.log(`Fingerprint: ${completed.fingerprintSha256}`);
      },
    );

  a.command("list")
    .description("List registered agents")
    .action(async () => {
      const config = loadCliConfig();
      const client = ApiClient.fromConfig(config);
      const r = await client.get<{ agents: AgentRow[] }>("/agents");
      if (r.agents.length === 0) {
        console.log("No agents registered.");
        return;
      }
      console.log("AGENT_ID\tSITE\tSCHEDULER\tSTATUS");
      for (const agent of r.agents) {
        console.log(
          `${agent.agentId}\t${agent.siteName}\t${agent.schedulerType} ${agent.schedulerVersion}\t${agent.status}`,
        );
      }
    });

  a.command("serve")
    .description(
      "Serve this node's local scheduler over HTTP so a remote kq can drive it (no Server)",
    )
    .option("--port <n>", `Listen port (default ${DEFAULT_SERVE_PORT})`)
    .option(
      "--host <h>",
      `Bind address (default ${DEFAULT_SERVE_HOST}; binding 0.0.0.0 exposes this node to the network)`,
    )
    .option(
      "--token <t>",
      "Bearer token required on every route except /healthz (or set KQ_AGENT_TOKEN)",
    )
    .option(
      "--scheduler <type>",
      "Force the scheduler type (slurm|pbs-pro|torque|kubernetes); default auto-detect",
    )
    .option("--data-dir <path>", "Local SQLite store directory (default ~/.kuintessence)")
    .option("--no-db", "Don't persist jobs (ephemeral; default persists)")
    .action(
      async (opts: {
        port?: string;
        host?: string;
        token?: string;
        scheduler?: string;
        dataDir?: string;
        db?: boolean;
      }) => {
        // Arg validation runs OUTSIDE the scheduler catch (see gui serve) so a
        // bad flag surfaces its own message via the top-level formatCliError
        // handler instead of being mislabeled as a missing-scheduler failure.
        const port = opts.port ? parseServePort(opts.port) : DEFAULT_SERVE_PORT;
        const host = opts.host ?? DEFAULT_SERVE_HOST;
        const token = opts.token ?? process.env.KQ_AGENT_TOKEN;
        const noDb = opts.db === false;
        const scheduler = opts.scheduler ? parseScheduler(opts.scheduler) : undefined;
        const dbPath = opts.dataDir
          ? join(expandTilde(opts.dataDir, homedir()), "local.db")
          : undefined;

        let backend: Awaited<ReturnType<typeof selectBackend>>;
        try {
          backend = await selectBackend({ local: true, scheduler, dbPath, noDb });
        } catch (err) {
          console.error(
            localSchedulerErrorMessage(
              "agent serve",
              err,
              "or connect your kq client to a Server instead",
            ),
          );
          process.exit(1);
        }

        const server = createAgentServer(backend, token ? { token } : {});
        Bun.serve({ port, hostname: host, fetch: server.fetch });

        console.log(
          `kq agent serve: listening on http://${host}:${port} ` +
            `(scheduler: ${backend.info.target}, auth: ${token ? "on" : "off"})`,
        );
        if (host === "0.0.0.0" && !token) {
          console.warn(
            "warning: bound to 0.0.0.0 with no --token — this node's scheduler is open to the network.",
          );
        }
      },
    );
}

async function registrationPost<T>(serverUrl: string, path: string, body: unknown): Promise<T> {
  const base = serverUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: { message?: string } };
      message = parsed.error?.message ?? message;
    } catch {
      // Keep the HTTP status fallback.
    }
    throw new Error(`Agent registration failed: ${message}`);
  }
  return (await res.json()) as T;
}

export function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label} "${value}". Expected a positive integer.`);
  }
  return parsed;
}

export async function writeAgentRegistrationFiles(input: {
  outputDir: string;
  serverHttpUrl: string;
  serverGrpcUrl: string;
  agentId: string;
  siteName: string;
  certPem: string;
  keyPem: string;
  caCertPem: string;
}): Promise<void> {
  const certDir = join(input.outputDir, "certs");
  const dbPath = join(input.outputDir, "agent.db");
  await mkdir(input.outputDir, { recursive: true, mode: 0o700 });
  await chmod(input.outputDir, 0o700);
  await persistCertBundle(certDir, {
    certPem: input.certPem,
    keyPem: input.keyPem,
    caCertPem: input.caCertPem,
  });
  await chmod(certDir, 0o700);
  const env = [
    envLine("SERVER_GRPC_URL", input.serverGrpcUrl),
    envLine("SERVER_HTTP_URL", input.serverHttpUrl),
    envLine("AGENT_ID", input.agentId),
    envLine("AGENT_SITE_NAME", input.siteName),
    envLine("AGENT_MTLS_REQUIRED", "true"),
    envLine("AGENT_CERT_DIR", certDir),
    envLine("AGENT_DB_PATH", dbPath),
  ].join("\n");
  const envPath = join(input.outputDir, "agent.env");
  await writeFile(envPath, `${env}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);
}

function envLine(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}
