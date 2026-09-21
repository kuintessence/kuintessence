import {
  envBool,
  loadConfig,
  logLevelSchema,
  nonNegativeInt,
  positiveInt,
  registryPublisherRolesConfigSchema,
  SpackMaterialBindingSchema,
} from "@kuintessence/shared";
import { z } from "zod";

const ecosystemTrustedKeysSchema = z
  .string()
  .default("{}")
  .transform((raw, ctx) => {
    try {
      const value: unknown = JSON.parse(raw);
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.values(value).some((key) => typeof key !== "string" || key.length === 0)
      ) {
        throw new Error("must be an object of key id to base64 SPKI");
      }
      return value as Record<string, string>;
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ECOSYSTEM_RELEASE_TRUSTED_KEYS ${error instanceof Error ? error.message : "is invalid"}`,
      });
      return z.NEVER;
    }
  });

const ServerConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  DB_MAX_CONNECTIONS: positiveInt(10),
  DB_IDLE_TIMEOUT_SEC: nonNegativeInt(0),
  REDIS_URL: z.string(),
  JWT_SECRET: z.string().min(32),
  REGISTRY_PUBLISHER_ROLES: registryPublisherRolesConfigSchema,
  SPACK_MATERIAL_DELIVERY_ENABLED: envBool(false),
  SPACK_MATERIAL_EPOCH: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .length(36)
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
  ),
  SPACK_REGISTRY_ALLOW_INSECURE_HTTP: envBool(false),
  SPACK_REGISTRY_URL: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    }, "must be an HTTP(S) origin")
    .optional(),
  SPACK_REGISTRY_JWT_SECRET: z.string().min(32).optional(),
  SPACK_REGISTRY_JWT_ISSUER: z.string().min(1).optional(),
  SPACK_REGISTRY_JWT_AUDIENCE: z.string().min(1).optional(),
  SPACK_MATERIAL_TICKET_SECRET: z.string().min(32).optional(),
  SPACK_MATERIAL_RELEASES: z
    .string()
    .max(1024 * 1024)
    .default("{}")
    .transform((raw, ctx) => {
      try {
        return z
          .record(z.string().min(1).max(4096), SpackMaterialBindingSchema)
          .parse(JSON.parse(raw));
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "must map exact Spack specs to immutable release bindings",
        });
        return z.NEVER;
      }
    }),
  /** JSON map of key id to base64 DER/SPKI Ed25519 public key. */
  ECOSYSTEM_RELEASE_TRUSTED_KEYS: ecosystemTrustedKeysSchema,
  /** Short-lived access session. The browser renews it with the HttpOnly refresh cookie. */
  AUTH_ACCESS_TOKEN_TTL_SEC: positiveInt(900).refine(
    (value) => value >= 60,
    "AUTH_ACCESS_TOKEN_TTL_SEC must be >= 60",
  ),
  /** Long-lived rotating session credential; must outlive the access session. */
  AUTH_REFRESH_TOKEN_TTL_SEC: positiveInt(604800),
  /**
   * dedicated signing key for the F22.15 alias-export JWT.
   * Distinct from JWT_SECRET so each can rotate independently. Optional;
   * when absent, the alias-export endpoint refuses to issue tokens.
   */
  DESENSITIZE_EXPORT_KEY: z.string().min(32).optional(),
  SERVER_PORT: positiveInt(3000),
  SERVER_GRPC_PORT: positiveInt(3001),
  LOG_LEVEL: logLevelSchema,
  /**
   * Server mTLS for the Agent connectRPC stream.
   * Default `false` for local dev. Production deployments MUST set `true`.
   */
  MTLS_REQUIRED: envBool(false),
  /**
   * Production auth boundary selector. `MTLS_REQUIRED=true` remains supported
   * as a compatibility alias for `direct` when this is unset.
   */
  MTLS_MODE: z.enum(["off", "direct", "trusted-proxy"]).optional(),
  MTLS_TRUSTED_PROXY_CIDRS: z.string().default(""),
  MTLS_HEADER_FINGERPRINT: z.string().default("x-agent-cert-fingerprint"),
  /** HTTP proxy CIDRs whose X-Forwarded-For chain may be used for client IP audit facts. */
  HTTP_TRUSTED_PROXY_CIDRS: z.string().default(""),
  /** PEM server certificate used by the HTTP/2 Agent endpoint in direct mTLS mode. */
  SERVER_GRPC_TLS_CERT_FILE: z.string().min(1).optional(),
  /** PEM private key matching SERVER_GRPC_TLS_CERT_FILE. */
  SERVER_GRPC_TLS_KEY_FILE: z.string().min(1).optional(),
  /** Where the Server CA cert+key live on disk. Auto-generated on first start. */
  SERVER_CA_DIR: z.string().default("./server-ca"),
  /** Hint used to escalate the disabled-mTLS warning to a loud message in non-dev. */
  NODE_ENV: z.string().default("development"),
  /**
   * dedicated wrapping key for the sso_config.client_secret_encrypted
   * column. Optional; when absent, the Server falls back to JWT_SECRET so a
   * single-binary dev deployment still works. Operators are encouraged to set
   * a separate key so the JWT signing key and the OIDC secret-encryption key
   * can rotate independently.
   */
  SSO_SECRET_KEY: z.string().min(32).optional(),
  /**
   * where the OIDC callback redirects the browser after signing
   * the JWT. Default '/' lets the bundled SPA at /index.html pick up the
   * `?token=…` query parameter. Set to a full URL when the web SPA lives on
   * a different origin from the Server.
   */
  WEB_BASE_URL: z.string().default("/"),
  SSO_BOOTSTRAP_ENABLED: envBool(false),
  SSO_BOOTSTRAP_FORCE: envBool(false),
  SSO_BOOTSTRAP_ISSUER_URL: z.string().default(""),
  SSO_BOOTSTRAP_CLIENT_ID: z.string().default(""),
  SSO_BOOTSTRAP_CLIENT_SECRET: z.string().default(""),
  SSO_BOOTSTRAP_REDIRECT_URI: z.string().default(""),
  SSO_BOOTSTRAP_GROUP_MAPPING: z.string().default("{}"),
  SSO_BOOTSTRAP_AUTO_CREATE_USERS: envBool(true),
  /**
   * Optional Content-Security-Policy for deployments that serve the SPA through
   * the Server or otherwise want the API host to emit the same policy.
   */
  WEB_CSP: z.string().optional(),
  /**
   * Base directory for per-job workflow run directories. When set, the
   * runner stamps `workingDir = <WORKFLOW_RUN_BASE>/<jobId>` on each job, so
   * input staging, the job's cwd (`sbatch --chdir`), and relative output
   * collection all agree. Optional: when unset, workflow jobs keep an empty
   * workingDir. The path must be writable on the cluster
   * where the agent runs.
   */
  WORKFLOW_RUN_BASE: z.string().optional(),
  /**
   * Allows the synchronous workflow debug endpoint in production.
   * Non-production keeps the endpoint available by default at route wiring.
   */
  WORKFLOW_SYNC_ENABLED: envBool(false),
  SANDBOX_ENABLED: envBool(false),
  SANDBOX_SIGNING_KEY_ID: z.string().min(1).max(128).default("server-sandbox-v1"),
  SANDBOX_SIGNING_PRIVATE_KEY_PEM: z
    .string()
    .min(1)
    .transform((value) => value.replaceAll("\\n", "\n"))
    .optional(),
  SANDBOX_MAX_PIDS: positiveInt(256),
  SANDBOX_MAX_CPU_CORES: positiveInt(64),
  SANDBOX_MAX_MEMORY_MB: positiveInt(262_144),
  SANDBOX_MAX_WALL_TIME_SEC: positiveInt(86_400),
  SANDBOX_MAX_OUTPUT_BYTES: positiveInt(1_073_741_824),
  SANDBOX_MAX_LOG_BYTES: positiveInt(10_485_760),
  SANDBOX_IMPERSONATION_ENABLED: envBool(false),
  SANDBOX_SELF_ACCOUNT_ENABLED: envBool(false),
  SANDBOX_DEGRADED_IMPERSONATION_ALLOWED: envBool(false),
  SANDBOX_SHARED_SERVICE_ALLOWED: envBool(false),
  SANDBOX_ARTIFACT_GC_INTERVAL_SEC: nonNegativeInt(300),
  /**
   * Optional bootstrap roots for legacy cluster browsing before any persisted
   * Cluster File Root exists. Empty by default so deployments fail closed.
   */
  CLUSTER_FILE_STATIC_ROOTS: z
    .string()
    .default("")
    .transform((value, ctx) => {
      const roots = value
        .split(",")
        .map((root) => root.trim())
        .filter(Boolean);
      const invalid = roots.filter((root) => !root.startsWith("/") || root === "/");
      if (invalid.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `CLUSTER_FILE_STATIC_ROOTS must contain absolute non-root paths: ${invalid.join(", ")}`,
        });
        return z.NEVER;
      }
      return roots;
    }),
  /** master switch for the MinIO-backed NetDrive subsystem. When
   *  true, the server loads the MinIO config (NETDRIVE_*), health-checks the
   *  bucket at startup, and mounts /api/netdrive + input staging. */
  NETDRIVE_ENABLED: envBool(false),
  /** Dedicated mutable bucket for uncommitted Data Market browser uploads. */
  DATA_MARKET_STAGING_BUCKET: z.string().min(3).default("kq-data-market-staging"),
  /** Versioned Object Lock bucket that stores committed Data Market bytes. */
  DATA_MARKET_IMMUTABLE_BUCKET: z.string().min(3).default("kq-data-market-immutable"),
  /** Lifecycle expiry for abandoned staging objects. */
  DATA_MARKET_STAGING_EXPIRY_DAYS: positiveInt(1),
  /**
   * Retention applied atomically to every committed Data Market object.
   * The backing bucket must expose versioning, COMPLIANCE Object Lock, and
   * and a non-root committer IAM policy; bootstrap verifies all three before mounts.
   */
  DATA_MARKET_IMMUTABLE_RETENTION_DAYS: positiveInt(365).refine(
    (days) => days >= 1,
    "DATA_MARKET_IMMUTABLE_RETENTION_DAYS must be at least 1",
  ),
  /**
   * When true, the metering rollup cron emits a `usage.daily` summary webhook
   * for the previous UTC day to every org with an enabled `usage.daily`
   * subscription. Off by default — outbound webhooks are opt-in.
   */
  METERING_WEBHOOK_ENABLED: envBool(false),
  /** Part size (MiB) for NetDrive multipart uploads. S3 floor is 5 MiB. */
  NETDRIVE_MULTIPART_PART_SIZE_MB: positiveInt(64).refine(
    (n) => n >= 5,
    "NETDRIVE_MULTIPART_PART_SIZE_MB must be >= 5 (S3 minimum part size)",
  ),
  /**
   * Threshold (MiB) for the browser/REST upload surface to choose multipart vs
   * single-shot PUT. NOT applied to the live agent cluster→cloud path: that
   * path always uses multipart (a 1-part multipart is valid, and the agent
   * spools first so size is only known mid-transfer). See `TransferRunner`.
   */
  NETDRIVE_MULTIPART_THRESHOLD_MB: positiveInt(64),
  /** Lifetime (seconds) of a multipart upload's presigned part URLs + commit token. */
  NETDRIVE_MULTIPART_TTL_SEC: positiveInt(3600),
  /**
   * record SSH session output to object storage (asciinema cast).
   * Reuses the NetDrive MinIO backend, so it is only active when NetDrive is
   * also enabled. Opt-in: terminal transcripts are sensitive and storage-heavy.
   */
  SSH_SESSION_RECORDING: envBool(false),
  /**
   * idle timeout (seconds) for SSH sessions. A session with no
   * input/output for this long is force-closed. 0 (default) disables it.
   */
  SSH_IDLE_TIMEOUT_SEC: nonNegativeInt(0),
  /**
   * absolute maximum SSH session lifetime (seconds). A session open
   * longer than this is force-closed regardless of activity — a bastion control
   * idle timeout cannot provide. 0 (default) disables it.
   */
  SSH_MAX_SESSION_SEC: nonNegativeInt(0),
  /**
   * auto-delete SSH recordings older than this many days. 0
   * (default) keeps them forever. Only effective when recording is enabled.
   */
  SSH_RECORDING_RETENTION_DAYS: nonNegativeInt(0),
  /**
   * Reclaim a dispatched job's completion waiter after this many seconds if the
   * agent never reports terminal status (crash). 0 disables. Default 7 days —
   * safely beyond any real HPC job.
   */
  SERVER_JOB_COMPLETION_TIMEOUT_SEC: nonNegativeInt(604800),
  /**
   * Recompute per-agent historical P95 queue-wait every N seconds (feeds the
   * queue-wait scorer). 0 (default) disables the background sweep.
   */
  SCHEDULER_QUEUE_WAIT_AGG_SEC: nonNegativeInt(0),
  /**
   * Mark an online Agent offline when it has not refreshed its heartbeat within
   * this interval. Agents recover automatically on their next heartbeat.
   */
  AGENT_HEARTBEAT_TIMEOUT_SEC: positiveInt(90),
  /**
   * Cadence for reconciling stale Agent rows. 0 disables periodic checks, but
   * startup still performs one reconciliation before serving scheduling work.
   */
  AGENT_HEARTBEAT_SWEEP_INTERVAL_SEC: nonNegativeInt(30),
  /**
   * Reject legacy or unknown compute-health reports during placement. Disabled
   * by default so a Server can be rolled out before every Agent supports v1.
   */
  COMPUTE_HEALTH_ENFORCE: envBool(false),
  /**
   * A compute-health report must have been observed within this interval.
   * Samples beyond this past-age bound fail closed.
   */
  COMPUTE_HEALTH_MAX_AGE_SEC: positiveInt(120),
  /**
   * Accept this much positive Agent clock skew, then clamp the persisted
   * observation time to the Server receive time. Larger future samples fail closed.
   */
  COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC: nonNegativeInt(5),
  /**
   * Queue inventory rollout mode. `off` retains legacy placement, `shadow`
   * exposes observations without changing dispatch, and `enforce` requires a
   * fresh available HPC scheduler observation before dispatch.
   */
  QUEUE_VALIDATION_MODE: z.enum(["off", "shadow", "enforce"]).default("off"),
  /** A queue inventory observation must be newer than this bound. */
  QUEUE_INVENTORY_MAX_AGE_SEC: positiveInt(120),
  /** Permitted positive Agent clock skew before an observation is rejected. */
  QUEUE_INVENTORY_MAX_FUTURE_SKEW_SEC: nonNegativeInt(5),
  AUTHZ_MODE: z.enum(["off", "shadow", "enforce"]).default("off"),
  AUTHZ_SPICEDB_ENDPOINT: z.string().default("localhost:50051"),
  AUTHZ_SPICEDB_TOKEN: z.string().default("local-dev-authz"),
  AUTHZ_SCHEMA_PATH: z.string().default("authz/schema.zed"),
  AUTHZ_RAW_TUPLE_ADMIN_ENABLED: envBool(false),
  AUTHZ_PLATFORM_ADMIN_DEGRADE: envBool(true),
  AUTHZ_OUTBOX_BATCH_SIZE: positiveInt(100),
  AUTHZ_OUTBOX_INTERVAL_SEC: nonNegativeInt(5),
});

const ValidatedServerConfigSchema = ServerConfigSchema.superRefine((cfg, ctx) => {
  if (!cfg.SPACK_MATERIAL_DELIVERY_ENABLED) return;
  for (const key of [
    "SPACK_REGISTRY_URL",
    "SPACK_REGISTRY_JWT_SECRET",
    "SPACK_MATERIAL_TICKET_SECRET",
  ] as const) {
    if (!cfg[key])
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "required for Spack material delivery",
      });
  }
  const mode = cfg.MTLS_MODE ?? (cfg.MTLS_REQUIRED ? "direct" : "off");
  if (mode === "off") {
    ctx.addIssue({
      code: "custom",
      path: ["MTLS_MODE"],
      message: "Spack material delivery requires mTLS",
    });
  }
  if (cfg.SPACK_REGISTRY_URL && !cfg.SPACK_REGISTRY_ALLOW_INSECURE_HTTP) {
    const url = new URL(cfg.SPACK_REGISTRY_URL);
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        path: ["SPACK_REGISTRY_URL"],
        message:
          "HTTPS is required; private HTTP needs explicit SPACK_REGISTRY_ALLOW_INSECURE_HTTP",
      });
    }
  }
  if (
    cfg.SPACK_MATERIAL_TICKET_SECRET === cfg.JWT_SECRET ||
    cfg.SPACK_MATERIAL_TICKET_SECRET === cfg.SPACK_REGISTRY_JWT_SECRET
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["SPACK_MATERIAL_TICKET_SECRET"],
      message: "use a dedicated ticket signing key",
    });
  }
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return loadConfig(ValidatedServerConfigSchema, env, "Server");
}
