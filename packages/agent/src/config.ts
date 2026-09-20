import {
  envBool,
  loadConfig,
  logLevelSchema,
  nonNegativeInt,
  positiveInt,
} from "@kuintessence/shared";
import { z } from "zod";
import { SandboxRuntimeCacheConfigSchema } from "./sandbox/runtime-reference";
import { isSpackAuditPath } from "./spack/audit-runtime";
import { isSpackCacheDir } from "./spack/material-cache";

const dedicatedAbsolutePath = (name: string) =>
  z
    .string()
    .refine(
      (value) => value.startsWith("/") && value !== "/" && !value.split("/").includes(".."),
      `${name} must be a dedicated absolute path without parent traversal`,
    );

const canonicalRelativePath = (name: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !value.split("/").some((part) => part === "" || part === "." || part === ".."),
      `${name} must be a canonical relative path`,
    );

const LicensedMaterialRegistryConfigSchema = z.record(
  z.string().min(1).max(255),
  z.strictObject({
    localRelativePath: z
      .string()
      .min(1)
      .refine(
        (value) => !value.startsWith("/") && !value.split("/").includes(".."),
        "licensed material path must be relative and must not contain '..'",
      ),
  }),
);

const DatasetRootsConfigSchema = z.record(
  z.string().uuid(),
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        value === "." ||
        (!value.startsWith("/") &&
          !value.includes("\\") &&
          !value.split("/").some((part) => part === "" || part === "." || part === "..")),
      "dataset managed root path must be canonical and relative",
    ),
);

const boundedPositiveInt = (defaultValue: number, maximum: number) =>
  z.coerce.number().int().positive().max(maximum).default(defaultValue);

function jsonConfig<T extends z.ZodType>(schema: T, fallback: string) {
  return z
    .string()
    .default(fallback)
    .transform((value, ctx): z.infer<T> => {
      try {
        return schema.parse(JSON.parse(value));
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "invalid JSON configuration",
        });
        return z.NEVER;
      }
    });
}

const AgentConfigSchema = z
  .object({
    SERVER_GRPC_URL: z.string().url(),
    AGENT_ID: z.string().min(1),
    AGENT_SITE_NAME: z.string().min(1),
    AGENT_DB_PATH: z.string().default("./agent.db"),
    HEARTBEAT_INTERVAL_SEC: positiveInt(30),
    AGENT_GRPC_PING_INTERVAL_SEC: boundedPositiveInt(30, 7_200),
    AGENT_GRPC_PING_TIMEOUT_SEC: boundedPositiveInt(10, 300),
    AGENT_REGISTRATION_TIMEOUT_SEC: boundedPositiveInt(30, 600),
    AGENT_HEARTBEAT_ACK_TIMEOUT_SEC: boundedPositiveInt(30, 300),
    AGENT_REACHABILITY_PROBE_ENABLED: envBool(false),
    AGENT_SCHEDULER_METRICS_INTERVAL_SEC: positiveInt(120),
    AGENT_QUEUE_INVENTORY_INTERVAL_SEC: positiveInt(30),
    AGENT_SCHEDULER_CLI_TIMEOUT_SEC: positiveInt(5),
    /**
     * Maximum number of heartbeat snapshots retained in the offline outbound
     * queue. After this many entries, the oldest are discarded on each new
     * `enqueueHeartbeat`, keeping the SQLite table bounded during long
     * disconnects so the eventual replay does not flood the Server with stale
     * CPU samples.
     */
    AGENT_MAX_QUEUED_HEARTBEATS: nonNegativeInt(50),
    LOG_LEVEL: logLevelSchema,
    AGENT_SPAWNER_BACKEND: z.enum(["host", "container"]).default("host"),
    AGENT_SLURM_CONTAINER_ID: z.string().optional(),
    AGENT_K8S_DEFAULT_IMAGE: z.string().min(1).default("busybox:latest"),
    /**
     * Agent mTLS. Default false for parity with the Server
     * default; production deployments MUST set true.
     */
    AGENT_MTLS_REQUIRED: envBool(false),
    /** Where the Agent persists `{client.crt, client.key, ca.crt}`. */
    AGENT_CERT_DIR: z.string().default("./agent-certs"),
    /** One-time enrollment token (a platform_admin JWT) used to bootstrap. */
    AGENT_ENROLL_TOKEN: z.string().optional(),
    /** Server HTTP base URL for the cert issuance admin endpoint. */
    SERVER_HTTP_URL: z.string().url().optional(),
    /**
     * Spack module master switch. Default false so Agents
     * running in Spack-less environments (CI, k8s, edge) don't probe a
     * missing binary at boot. Production HPC sites set this to true.
     */
    AGENT_SPACK_ENABLED: envBool(false),
    /**
     * Path to the Spack binary. Defaults to `spack` (PATH lookup), but
     * can be overridden when CPs install Spack into a non-standard
     * prefix (e.g. `/opt/spack/bin/spack`).
     */
    AGENT_SPACK_PATH: z.string().default("spack"),
    AGENT_SPACK_CACHE_DIR: z
      .string()
      .refine(isSpackCacheDir, "AGENT_SPACK_CACHE_DIR must be a dedicated absolute canonical path")
      .default("/var/lib/kuintessence/spack-materials"),
    AGENT_SPACK_AUDIT_ENABLED: envBool(false),
    AGENT_SPACK_AUDIT_APPTAINER_PATH: z
      .string()
      .refine(isSpackAuditPath)
      .default("/usr/bin/apptainer"),
    AGENT_SPACK_AUDIT_APPTAINER_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    AGENT_SPACK_AUDIT_SIF_PATH: z.string().refine(isSpackAuditPath).optional(),
    AGENT_SPACK_AUDIT_SIF_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    AGENT_SPACK_INSTALL_ENABLED: envBool(false),
    AGENT_SPACK_INSTALL_SITE_PROFILE_PATH: z.string().refine(isSpackAuditPath).optional(),
    AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * SSH relay master switch. Default true: the relay needs no
     * agent-side setup (credentials are resolved Server-side and SSH access is
     * RBAC-gated to org_admin+ at the gateway). Set false on locked-down
     * nodes (e.g. edge agents) that must never relay an interactive shell.
     */
    AGENT_SSH_ENABLED: envBool(true),
    /**
     * restrict the SSH relay handshake to a modern algorithm
     * allowlist (disables legacy KEX/ciphers/MACs). Default false to preserve
     * compatibility with pre-7.x OpenSSH; enable on fleets that are all modern.
     */
    AGENT_SSH_STRICT_ALGORITHMS: envBool(false),
    /**
     * SSH keepalive interval (seconds) for the relay; the agent
     * drops a login-node connection after 3 unanswered keepalives. 0 (default)
     * disables it.
     */
    AGENT_SSH_KEEPALIVE_SEC: nonNegativeInt(0),
    /**
     * Cloud→cluster download — max consecutive curl attempts before the
     * transfer gives up and lets the Server re-dispatch. `curl -C -` resumes a
     * partial file between attempts, so a network blip mid-download no longer
     * restarts from zero.
     */
    AGENT_FILE_TRANSFER_MAX_RETRIES: positiveInt(3),
    /** Seconds slept between failed cloud→cluster download attempts. */
    AGENT_FILE_TRANSFER_RETRY_BACKOFF_SEC: nonNegativeInt(2),
    /**
     * Optional curl `--connect-to` mapping for presigned object-store URLs.
     * Local Docker stacks commonly sign URLs for a browser-facing localhost
     * port while the transfer curl runs inside a scheduler container.
     */
    AGENT_FILE_TRANSFER_CONNECT_TO: z.string().default("localhost:9000:host.docker.internal:9000"),
    /**
     * Optional override for transfer commands executed inside a scheduler
     * container. When omitted, the host mapping above remains the compatible
     * fallback for existing deployments.
     */
    AGENT_CONTAINER_FILE_TRANSFER_CONNECT_TO: z.string().optional(),
    AGENT_TEST_FAIL_OUTPUT_COLLECTION_DESCRIPTOR: z.string().optional(),
    AGENT_SANDBOX_ENABLED: envBool(false),
    AGENT_SANDBOX_ROOT: dedicatedAbsolutePath("AGENT_SANDBOX_ROOT").default(
      "/var/lib/kuintessence/sandbox",
    ),
    AGENT_SANDBOX_EXECUTION_MODE: z
      .enum(["disabled", "self-account", "root-impersonation"])
      .default("disabled"),
    AGENT_SANDBOX_ROOT_IMPERSONATION: envBool(false),
    AGENT_SANDBOX_SHARED_SERVICE_ALLOWED: envBool(false),
    AGENT_SANDBOX_PUBLIC_KEYS_JSON: jsonConfig(
      z.record(z.string().min(1), z.string().min(1)),
      "{}",
    ),
    AGENT_SANDBOX_RUNTIME_CACHE_JSON: jsonConfig(SandboxRuntimeCacheConfigSchema, "{}"),
    AGENT_SANDBOX_K8S_ARTIFACT_PVC: z.string().min(1).optional(),
    AGENT_SANDBOX_K8S_SECCOMP_ROOT: dedicatedAbsolutePath("AGENT_SANDBOX_K8S_SECCOMP_ROOT").default(
      "/var/lib/kubelet/seccomp",
    ),
    AGENT_SANDBOX_K8S_SECCOMP_PROFILE: canonicalRelativePath(
      "AGENT_SANDBOX_K8S_SECCOMP_PROFILE",
    ).optional(),
    AGENT_SANDBOX_K8S_SECCOMP_PROFILE_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    AGENT_SANDBOX_K8S_SECCOMP_NODE_NAME: z
      .string()
      .regex(/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/)
      .optional(),
    AGENT_SANDBOX_NETWORK_ISOLATION: envBool(false),
    AGENT_SANDBOX_CGROUPS: envBool(false),
    AGENT_SANDBOX_SECCOMP: envBool(false),
    AGENT_SANDBOX_SIF_SIGNATURE_VERIFICATION: envBool(false),
    AGENT_SANDBOX_ECL: envBool(false),
    AGENT_SANDBOX_APPTAINER_PATH: dedicatedAbsolutePath("AGENT_SANDBOX_APPTAINER_PATH").default(
      "/usr/bin/apptainer",
    ),
    AGENT_SANDBOX_SIF_PUBLIC_KEY_PATH: dedicatedAbsolutePath(
      "AGENT_SANDBOX_SIF_PUBLIC_KEY_PATH",
    ).optional(),
    AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    AGENT_SANDBOX_SECCOMP_PROFILE_PATH: dedicatedAbsolutePath(
      "AGENT_SANDBOX_SECCOMP_PROFILE_PATH",
    ).optional(),
    AGENT_SANDBOX_SECCOMP_PROFILE_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_PATH: dedicatedAbsolutePath(
      "AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_PATH",
    ).optional(),
    AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    AGENT_SANDBOX_ECL_PATH:
      dedicatedAbsolutePath("AGENT_SANDBOX_ECL_PATH").default("/etc/apptainer/ecl.toml"),
    AGENT_SANDBOX_ECL_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    AGENT_SANDBOX_ECL_NEGATIVE_PROBE_SIF_PATH: dedicatedAbsolutePath(
      "AGENT_SANDBOX_ECL_NEGATIVE_PROBE_SIF_PATH",
    ).optional(),
    AGENT_SANDBOX_ATTESTATION_TTL_SEC: boundedPositiveInt(3_600, 86_400),
    AGENT_SANDBOX_ATTESTATION_QUEUE: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,128}$/)
      .optional(),
    AGENT_LICENSED_MATERIAL_ROOT: dedicatedAbsolutePath("AGENT_LICENSED_MATERIAL_ROOT").default(
      "/var/lib/kuintessence/licensed-materials",
    ),
    AGENT_LICENSED_MATERIAL_REGISTRY_JSON: jsonConfig(LicensedMaterialRegistryConfigSchema, "{}"),
    AGENT_DATASET_ROOT: dedicatedAbsolutePath("AGENT_DATASET_ROOT").default(
      "/var/lib/kuintessence/datasets",
    ),
    AGENT_DATASET_ROOTS_JSON: jsonConfig(DatasetRootsConfigSchema, "{}"),
    AGENT_JOB_WORK_ROOT: dedicatedAbsolutePath("AGENT_JOB_WORK_ROOT").default(
      "/var/lib/kuintessence/jobs",
    ),
    AGENT_DATA_READONLY_MOUNT_DRIVER: z.enum(["disabled", "linux-bind"]).default("disabled"),
    AGENT_RESTRICTED_DATA_ISOLATION: envBool(false),
    /**
     * Restricted Data Market execution is accepted only through this pinned,
     * locally verified SIF. It is deliberately separate from the generic
     * Sandbox cache so a signed but unapproved runtime cannot become a data
     * exfiltration boundary by merely appearing in that cache.
     */
    AGENT_RESTRICTED_EXECUTION_SIF_DIGEST: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    AGENT_RESTRICTED_EXECUTION_APPTAINER_PATH: z
      .string()
      .regex(
        /^\/[^\0\r\n ]+$/,
        "AGENT_RESTRICTED_EXECUTION_APPTAINER_PATH must be an absolute canonical executable path",
      )
      .default("/usr/bin/apptainer"),
    AGENT_RESTRICTED_EXECUTION_PROFILE_ID: z.string().uuid().optional(),
    AGENT_RESTRICTED_EXECUTION_WRAPPER_PATH: z
      .string()
      .regex(
        /^\/[^\0\r\n ]+$/,
        "AGENT_RESTRICTED_EXECUTION_WRAPPER_PATH must be an absolute canonical executable path",
      )
      .default("/usr/libexec/kuintessence/kq-sandbox-wrapper"),
    AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine(
    (v) =>
      !v.AGENT_SPACK_AUDIT_ENABLED ||
      (v.AGENT_SPACK_ENABLED &&
        v.AGENT_SPACK_AUDIT_APPTAINER_SHA256 &&
        v.AGENT_SPACK_AUDIT_SIF_PATH &&
        v.AGENT_SPACK_AUDIT_SIF_SHA256 &&
        v.AGENT_SPACK_AUDIT_SIF_PATH !== v.AGENT_SPACK_AUDIT_APPTAINER_PATH),
    {
      message:
        "Spack source auditing requires AGENT_SPACK_ENABLED and a complete pinned runtime profile",
      path: ["AGENT_SPACK_AUDIT_ENABLED"],
    },
  )
  .refine(
    (v) =>
      !v.AGENT_SPACK_INSTALL_ENABLED ||
      (v.AGENT_SPACK_ENABLED &&
        v.AGENT_SPACK_AUDIT_ENABLED &&
        v.AGENT_SPAWNER_BACKEND === "host" &&
        v.AGENT_SPACK_INSTALL_SITE_PROFILE_PATH &&
        v.AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256),
    {
      message:
        "Managed Spack installation requires source auditing, a host backend and a pinned site profile",
      path: ["AGENT_SPACK_INSTALL_ENABLED"],
    },
  )
  .refine(
    (v) =>
      v.AGENT_SPAWNER_BACKEND !== "container" ||
      (v.AGENT_SLURM_CONTAINER_ID && v.AGENT_SLURM_CONTAINER_ID.length > 0),
    {
      message: "AGENT_SLURM_CONTAINER_ID is required when AGENT_SPAWNER_BACKEND=container",
      path: ["AGENT_SLURM_CONTAINER_ID"],
    },
  )
  .refine(
    (v) =>
      !v.AGENT_REACHABILITY_PROBE_ENABLED ||
      (v.AGENT_MTLS_REQUIRED && new URL(v.SERVER_GRPC_URL).protocol === "https:"),
    {
      message: "AGENT_REACHABILITY_PROBE_ENABLED requires HTTPS and Agent mTLS",
      path: ["AGENT_REACHABILITY_PROBE_ENABLED"],
    },
  )
  .refine((v) => !v.AGENT_RESTRICTED_DATA_ISOLATION || !!v.AGENT_RESTRICTED_EXECUTION_SIF_DIGEST, {
    message: "AGENT_RESTRICTED_DATA_ISOLATION=true requires AGENT_RESTRICTED_EXECUTION_SIF_DIGEST",
    path: ["AGENT_RESTRICTED_EXECUTION_SIF_DIGEST"],
  })
  .refine((v) => !v.AGENT_RESTRICTED_DATA_ISOLATION || !!v.AGENT_RESTRICTED_EXECUTION_PROFILE_ID, {
    message: "AGENT_RESTRICTED_DATA_ISOLATION=true requires AGENT_RESTRICTED_EXECUTION_PROFILE_ID",
    path: ["AGENT_RESTRICTED_EXECUTION_PROFILE_ID"],
  })
  .refine(
    (v) => !v.AGENT_RESTRICTED_DATA_ISOLATION || !!v.AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256,
    {
      message:
        "AGENT_RESTRICTED_DATA_ISOLATION=true requires AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256",
      path: ["AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256"],
    },
  )
  .refine(
    (v) => {
      const values = [
        v.AGENT_SANDBOX_K8S_SECCOMP_PROFILE,
        v.AGENT_SANDBOX_K8S_SECCOMP_PROFILE_SHA256,
        v.AGENT_SANDBOX_K8S_SECCOMP_NODE_NAME,
      ];
      return (
        values.every((value) => value === undefined) || values.every((value) => value !== undefined)
      );
    },
    {
      message:
        "Kubernetes Sandbox seccomp profile, SHA-256, and node name must be configured together",
      path: ["AGENT_SANDBOX_K8S_SECCOMP_PROFILE_SHA256"],
    },
  )
  .refine(
    (v) =>
      (v.AGENT_SANDBOX_SIF_PUBLIC_KEY_PATH === undefined) ===
      (v.AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256 === undefined),
    {
      message: "Sandbox SIF public key path and SHA-256 must be configured together",
      path: ["AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256"],
    },
  )
  .refine(
    (v) =>
      (v.AGENT_SANDBOX_SECCOMP_PROFILE_PATH === undefined) ===
      (v.AGENT_SANDBOX_SECCOMP_PROFILE_SHA256 === undefined),
    {
      message: "Sandbox seccomp profile path and SHA-256 must be configured together",
      path: ["AGENT_SANDBOX_SECCOMP_PROFILE_SHA256"],
    },
  )
  .refine(
    (v) =>
      (v.AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_PATH === undefined) ===
      (v.AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_SHA256 === undefined),
    {
      message: "Sandbox seccomp probe profile path and SHA-256 must be configured together",
      path: ["AGENT_SANDBOX_SECCOMP_PROBE_PROFILE_SHA256"],
    },
  )
  .refine(
    (v) => v.AGENT_SANDBOX_EXECUTION_MODE !== "self-account" || !v.AGENT_SANDBOX_ROOT_IMPERSONATION,
    {
      message: "Self-account Sandbox cannot enable root impersonation",
      path: ["AGENT_SANDBOX_ROOT_IMPERSONATION"],
    },
  );

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return loadConfig(AgentConfigSchema, env, "Agent");
}
