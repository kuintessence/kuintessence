import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadConfig,
  logLevelSchema,
  nonNegativeInt,
  positiveInt,
  registryPublisherRolesConfigSchema,
} from "@kuintessence/shared";
import { z } from "zod";
import { spackUpstreamConfigFields } from "./spack-upstream-config";

const optionalAbsolutePath = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().refine(isAbsolute, "must be absolute").optional(),
);

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
    ...spackUpstreamConfigFields,
    DATABASE_URL: z.string().url(),
    DB_MAX_CONNECTIONS: positiveInt(10),
    DB_IDLE_TIMEOUT_SEC: nonNegativeInt(0),
    REGISTRY_PORT: positiveInt(3100),
    LOG_LEVEL: logLevelSchema,
    /** Filesystem directory for the artifact blob store. When unset, an
     *  in-memory store is used (dev/test). */
    BLOB_STORE_DIR: z.string().optional(),
    SPACK_RECIPE_STORE_DIR: optionalAbsolutePath,
    SPACK_RECIPE_BOOTSTRAP_MANIFEST: optionalAbsolutePath,
    SPACK_RECIPE_MAX_BUNDLE_BYTES: positiveInt(128 * 1024 * 1024),
    SPACK_RECIPE_MAX_EXPANDED_BYTES: positiveInt(512 * 1024 * 1024),
    SPACK_RECIPE_MAX_FILES: positiveInt(100_000),
    SPACK_MATERIAL_STORE_DIR: optionalAbsolutePath,
    SPACK_MATERIAL_BOOTSTRAP_MANIFEST: optionalAbsolutePath,
    SPACK_MATERIAL_MAX_BLOB_BYTES: positiveInt(16 * 1024 ** 3).pipe(z.number().max(16 * 1024 ** 3)),
    SPACK_MATERIAL_UPLOAD_TOTAL_TIMEOUT_MS: positiveInt(30 * 60_000),
    SPACK_MATERIAL_UPLOAD_IDLE_TIMEOUT_MS: positiveInt(30_000),
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
    if (cfg.SPACK_UPSTREAM_ENABLED) {
      for (const key of ["SPACK_UPSTREAM_PROXY_URL", "SPACK_RECIPE_STORE_DIR"] as const) {
        if (!cfg[key]) {
          ctx.addIssue({ code: "custom", path: [key], message: "Required for upstream imports" });
        }
      }
      if (cfg.SPACK_UPSTREAM_ALLOWED_ORIGINS.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["SPACK_UPSTREAM_ALLOWED_ORIGINS"],
          message: "At least one trusted upstream origin is required",
        });
      }
    }
    if (cfg.SPACK_UPSTREAM_IDLE_TIMEOUT_MS > cfg.SPACK_UPSTREAM_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["SPACK_UPSTREAM_IDLE_TIMEOUT_MS"],
        message: "Must not exceed the total transfer timeout",
      });
    }
    const materialDirectory = cfg.SPACK_MATERIAL_STORE_DIR;
    if (materialDirectory) {
      for (const key of ["BLOB_STORE_DIR", "SPACK_RECIPE_STORE_DIR"] as const) {
        const directory = cfg[key];
        if (!directory) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required for material storage`,
          });
        } else if (
          key === "BLOB_STORE_DIR"
            ? containsDirectory(materialDirectory, directory) ||
              ["sha256", "_uploads"].some((name) =>
                directoriesOverlap(materialDirectory, join(directory, name)),
              )
            : directoriesOverlap(materialDirectory, directory)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["SPACK_MATERIAL_STORE_DIR"],
            message:
              key === "BLOB_STORE_DIR"
                ? "Material storage must not overlap OCI data directories or contain BLOB_STORE_DIR"
                : `Material storage must be separate from ${key}`,
          });
        }
      }
    }
    if (cfg.SPACK_RECIPE_BOOTSTRAP_MANIFEST && !cfg.SPACK_RECIPE_STORE_DIR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SPACK_RECIPE_BOOTSTRAP_MANIFEST"],
        message: "SPACK_RECIPE_STORE_DIR is required for recipe bootstrap",
      });
    }
    if (cfg.SPACK_MATERIAL_BOOTSTRAP_MANIFEST && !materialDirectory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SPACK_MATERIAL_BOOTSTRAP_MANIFEST"],
        message: "SPACK_MATERIAL_STORE_DIR is required for material bootstrap",
      });
    }
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

function directoriesOverlap(left: string, right: string): boolean {
  return containsDirectory(left, right) || containsDirectory(right, left);
}

function containsDirectory(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
