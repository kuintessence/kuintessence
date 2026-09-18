import {
  InstalledSpecSchema,
  SpackMaterialDigestSchema,
  type SpackPolicy,
} from "@kuintessence/shared";
import { z } from "zod";
import type { SoftwareOperationOutcome } from "./installer";
import type { PreparedSpackMaterials, SpackMaterialPrepareInput } from "./material-client";

export const SpackDagHashSchema = z.string().regex(/^[a-z2-7]{32}$/);
export const SpackInstallPathSchema = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      /^\/[A-Za-z0-9_+./-]+$/.test(value) &&
      !value.endsWith("/") &&
      value
        .split("/")
        .slice(1)
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a canonical absolute installation path",
  );

export function isSpackInstallRoot(value: string): boolean {
  return (
    SpackInstallPathSchema.safeParse(value).success &&
    ![
      "/bin",
      "/sbin",
      "/usr",
      "/lib",
      "/lib64",
      "/etc",
      "/proc",
      "/sys",
      "/dev",
      "/run",
      "/kq",
      "/opt/spack",
    ].some((root) => value === root || value.startsWith(`${root}/`)) &&
    value.split("/").length >= 4
  );
}

export const SpackInstallSiteProfileSchema = z
  .strictObject({
    version: z.literal(1),
    storeRoot: SpackInstallPathSchema.refine(isSpackInstallRoot),
    target: z
      .string()
      .min(1)
      .max(256)
      .regex(/^linux-[A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+$/),
    runtimeSifSha256: z.string().regex(/^[a-f0-9]{64}$/),
    osReleaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    hostFiles: z
      .array(
        z.strictObject({
          path: SpackInstallPathSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .min(1)
      .max(256),
    externals: z
      .array(
        z.strictObject({
          hash: SpackDagHashSchema,
          prefix: SpackInstallPathSchema,
        }),
      )
      .max(256),
    sharedStoreConfirmed: z.literal(true),
    compatibleComputeNodesConfirmed: z.literal(true),
    trustedRecipesConfirmed: z.literal(true),
    quotaEnforcedBySite: z.literal(true),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.hostFiles.map((file) => file.path)).size !== value.hostFiles.length ||
      new Set(value.externals.map((entry) => entry.hash)).size !== value.externals.length
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate site profile bindings" });
    }
  });
export type SpackInstallSiteProfile = z.infer<typeof SpackInstallSiteProfileSchema>;

export const SpackInstallReportSchema = z
  .strictObject({
    version: z.literal(1),
    validation: z.literal("isolated-install"),
    action: z.enum(["install", "verify", "load"]),
    manifestDigest: SpackMaterialDigestSchema,
    siteProfileDigest: SpackMaterialDigestSchema,
    storePath: SpackInstallPathSchema,
    root: InstalledSpecSchema.extend({ hash: SpackDagHashSchema }).strict(),
    prefix: SpackInstallPathSchema,
    installedHashes: z.array(SpackDagHashSchema).min(1).max(10_000),
    loadShell: z
      .string()
      .max(256 * 1024)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      !value.prefix.startsWith(`${value.storePath}/`) ||
      !value.installedHashes.includes(value.root.hash) ||
      new Set(value.installedHashes).size !== value.installedHashes.length ||
      (value.action === "load") !== (value.loadShell !== undefined)
    ) {
      ctx.addIssue({ code: "custom", message: "Inconsistent install report" });
    }
  });
export type SpackInstallReport = z.infer<typeof SpackInstallReportSchema>;
export const SPACK_INSTALL_RESULT_PREFIX = "KQ_SPACK_INSTALL_RESULT:";

export const SpackInstallRecordSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  state: z.enum(["building", "verifying", "ready", "unavailable", "failed", "removing", "removed"]),
  manifestDigest: SpackMaterialDigestSchema,
  manifestSize: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 2),
  siteProfileDigest: SpackMaterialDigestSchema,
  spec: z.string().min(1).max(4096),
  rootHash: SpackDagHashSchema,
  updatedAt: z.string().datetime(),
  report: SpackInstallReportSchema.optional(),
});
export type SpackInstallRecord = z.infer<typeof SpackInstallRecordSchema>;

export interface SpackManagedInstallation {
  install(
    prepared: PreparedSpackMaterials,
    input: SpackMaterialPrepareInput,
  ): Promise<SoftwareOperationOutcome>;
  installedList(): Promise<z.infer<typeof InstalledSpecSchema>[]>;
  operation(
    action: "load" | "uninstall" | "import_preinstalled",
    spec: string,
    policy: SpackPolicy,
  ): Promise<SoftwareOperationOutcome | null>;
}
