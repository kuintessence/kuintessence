import {
  loadConfig,
  logLevelSchema,
  nonNegativeInt,
  positiveInt,
  registryPublisherRolesConfigSchema,
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

const RegistryConfigSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    DB_MAX_CONNECTIONS: positiveInt(10),
    DB_IDLE_TIMEOUT_SEC: nonNegativeInt(0),
    REGISTRY_PORT: positiveInt(3100),
    LOG_LEVEL: logLevelSchema,
    /** Filesystem directory for the artifact blob store. When unset, an
     *  in-memory store is used (dev/test). */
    BLOB_STORE_DIR: z.string().optional(),
    /** Hard ceiling on one staged OCI upload (bytes). Default 10 GiB. */
    REGISTRY_MAX_UPLOAD_BYTES: positiveInt(10 * 1024 * 1024 * 1024),
    /** Idle seconds after which an unfinished OCI upload session is swept. Default 1 h. */
    REGISTRY_UPLOAD_IDLE_SEC: positiveInt(3600),
    REGISTRY_MAX_ACTIVE_UPLOADS: positiveInt(100),
    REGISTRY_MAX_ACTIVE_UPLOADS_PER_REPOSITORY: positiveInt(10),
    REGISTRY_MAX_INCOMPLETE_UPLOAD_BYTES: positiveInt(40 * 1024 * 1024 * 1024),
    REGISTRY_AUTH_MODE: z.enum(["dev", "jwt"]).default("dev"),
    REGISTRY_JWT_SECRET: z.string().optional(),
    REGISTRY_JWT_ISSUER: z.string().optional(),
    REGISTRY_JWT_AUDIENCE: z.string().optional(),
    REGISTRY_PUBLISHER_ROLES: registryPublisherRolesConfigSchema,
    /** JSON map of key id to base64 DER/SPKI Ed25519 public key. */
    ECOSYSTEM_RELEASE_TRUSTED_KEYS: ecosystemTrustedKeysSchema,
    /** Public OCI repository path, for example public/scientific-ecosystem. */
    ECOSYSTEM_RELEASE_OCI_REPOSITORY: z.string().min(1).optional(),
    /** Immutable OCI manifest digest synchronized at startup. */
    ECOSYSTEM_RELEASE_OCI_DIGEST: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    ECOSYSTEM_RELEASE_AUTO_ACTIVATE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.REGISTRY_AUTH_MODE === "jwt" && !cfg.REGISTRY_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REGISTRY_JWT_SECRET"],
        message: "REGISTRY_JWT_SECRET is required when REGISTRY_AUTH_MODE=jwt",
      });
    }
    if (
      (cfg.ECOSYSTEM_RELEASE_OCI_REPOSITORY === undefined) !==
      (cfg.ECOSYSTEM_RELEASE_OCI_DIGEST === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ECOSYSTEM_RELEASE_OCI_DIGEST"],
        message:
          "ECOSYSTEM_RELEASE_OCI_REPOSITORY and ECOSYSTEM_RELEASE_OCI_DIGEST must be configured together",
      });
    }
  });

export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;

export function loadRegistryConfig(env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  return loadConfig(RegistryConfigSchema, env, "Registry");
}
