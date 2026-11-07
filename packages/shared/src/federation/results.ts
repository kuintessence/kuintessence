import { z } from "zod";
import { FederationAssetRefSchema, FederationDigestSchema } from "./references";
import {
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
  hasFederationQueryWindow,
} from "./status";

/** Explicit bilateral release scope; absence never enables result export. */
export const FederationResultPolicySchema = z.strictObject({
  scope: z.literal("persistent-files"),
  maxFiles: z.number().int().min(1).max(256),
  maxBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  availableUntil: z.iso.datetime(),
});

const RelativePath = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes("\\") &&
      Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a safe relative result path",
  );
const File = z.strictObject({
  path: RelativePath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const Output = z
  .strictObject({
    outputId: FederationDigestSchema,
    nodeId: z.string().min(1).max(255),
    descriptor: z.string().min(1).max(255),
    type: z.enum(["File", "FileBatch"]),
    contentDigest: FederationDigestSchema,
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    files: z.array(File).max(256),
  })
  .superRefine((value, ctx) => {
    const paths = new Set(value.files.map((file) => file.path));
    const bytes = value.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (
      paths.size !== value.files.length ||
      !Number.isSafeInteger(bytes) ||
      bytes !== value.sizeBytes
    )
      ctx.addIssue({
        code: "custom",
        message: "Result members must be unique and match total bytes",
      });
    for (const path of paths) {
      const parts = path.split("/");
      if (parts.some((_, i) => i > 0 && paths.has(parts.slice(0, i).join("/"))))
        ctx.addIssue({ code: "custom", message: "Overlapping result paths" });
    }
    if (
      value.type === "File" &&
      (value.files.length !== 1 || value.contentDigest !== `sha256:${value.files[0]?.sha256}`)
    )
      ctx.addIssue({ code: "custom", message: "File output requires its one verified member" });
  });

export const FederationResultManifestSchema = z
  .strictObject({
    template: FederationAssetRefSchema,
    inputManifestDigest: FederationDigestSchema,
    environmentLockDigest: FederationDigestSchema,
    completedAt: z.iso.datetime(),
    availableUntil: z.iso.datetime(),
    outputs: z.array(Output).max(256),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.outputs.map((output) => output.outputId)).size !== value.outputs.length)
      ctx.addIssue({ code: "custom", message: "Result output IDs must be unique" });
    if (value.outputs.reduce((sum, output) => sum + output.files.length, 0) > 256)
      ctx.addIssue({ code: "custom", message: "Result manifest exceeds 256 files" });
  });
export type FederationResultManifest = z.infer<typeof FederationResultManifestSchema>;

export const FederationResultQuerySchema = z
  .strictObject({
    ...FederationStatusQuerySchema.shape,
    kind: z.literal("result-query"),
  })
  .refine(
    hasFederationQueryWindow,
    "Queries require distinct sites and a lifetime of at most one minute",
  );
export type FederationResultQuery = z.infer<typeof FederationResultQuerySchema>;

export const FederationResultReportSchema = FederationStatusReportSchema.omit({
  preparation: true,
  workflow: true,
}).extend({
  kind: z.literal("result-report"),
  manifestDigest: FederationDigestSchema,
  manifest: FederationResultManifestSchema,
});
export type FederationResultReport = z.infer<typeof FederationResultReportSchema>;
