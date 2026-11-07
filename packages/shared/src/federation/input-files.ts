import { z } from "zod";

/** Both institutions explicitly consent; existing agreements grant no file disclosure. */
export const FederationInputPolicySchema = z.strictObject({
  scope: z.literal("workflow-input-files"),
  maxFiles: z.number().int().min(1).max(256),
  maxBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const FederationInputDescriptorSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/);
export const FederationInputPathSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (path) =>
      !path.includes("\\") &&
      Array.from(path).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a safe relative input path",
  );

/** Source-local selection only; IDs never enter the portable signed inventory. */
export const FederationInputSelectionSchema = z
  .array(
    z.strictObject({
      descriptor: FederationInputDescriptorSchema,
      type: z.enum(["File", "FileBatch"]),
      files: z
        .array(z.strictObject({ path: FederationInputPathSchema, fileId: z.uuid() }))
        .max(256),
    }),
  )
  .min(1)
  .max(256);
export type FederationInputSelection = z.infer<typeof FederationInputSelectionSchema>;

/** Portable inventory only; no file IDs, storage keys, credentials or implicit usage authorization. */
export const FederationInputFilesSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("workflow-input-files"),
    inputs: z
      .array(
        z.strictObject({
          descriptor: FederationInputDescriptorSchema,
          type: z.enum(["File", "FileBatch"]),
          files: z
            .array(
              z.strictObject({
                path: FederationInputPathSchema,
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
              }),
            )
            .max(256),
        }),
      )
      .min(1)
      .max(256),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.inputs.map((input) => input.descriptor)).size !== value.inputs.length)
      ctx.addIssue({ code: "custom", message: "Input descriptors must be unique" });
    const files = value.inputs.flatMap((input) => input.files);
    if (
      files.length > 256 ||
      !Number.isSafeInteger(files.reduce((sum, file) => sum + file.sizeBytes, 0))
    )
      ctx.addIssue({ code: "custom", message: "Input manifest exceeds file or byte limits" });
    for (const [index, input] of value.inputs.entries()) {
      const paths = new Set(input.files.map((file) => file.path));
      if (paths.size !== input.files.length || (input.type === "File" && input.files.length !== 1))
        ctx.addIssue({ code: "custom", path: ["inputs", index], message: "Invalid input members" });
      for (const path of paths) {
        const parts = path.split("/");
        if (parts.some((_, index) => index > 0 && paths.has(parts.slice(0, index).join("/"))))
          ctx.addIssue({
            code: "custom",
            path: ["inputs", index],
            message: "Overlapping input paths",
          });
      }
    }
  });
export type FederationInputFiles = z.infer<typeof FederationInputFilesSchema>;

/** Receiver-local execution snapshot; never sent as a portable input manifest. */
export interface FederationReceivedInputFiles {
  importId: string;
  manifestDigest: string;
  inputs: Array<{
    descriptor: string;
    type: "File" | "FileBatch";
    files: Array<
      FederationInputFiles["inputs"][number]["files"][number] & {
        fileId: string;
        generation: string;
        storageKey: string;
        versionId: string;
        etag: string;
      }
    >;
  }>;
}
