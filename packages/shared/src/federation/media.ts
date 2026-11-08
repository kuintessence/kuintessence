import { z } from "zod";
import { FederationInputPathSchema } from "./input-files";
import { FederationAssetRefSchema, FederationDigestSchema } from "./references";

export const FEDERATION_MEDIA_MAX_BYTES = 5 * 1024 ** 4;
export const FEDERATION_MEDIA_MAX_FILES = 1000;

const TaskPackage = z.strictObject({
  kind: z.enum(["task-input", "task-result"]),
  operationId: z.uuid(),
  taskId: z.uuid(),
  attempt: z.number().int().positive().max(2_147_483_647),
  requestDigest: FederationDigestSchema,
  contentDigest: FederationDigestSchema,
});

/** Inventory and routing only. Possessing this signature never grants import or use authority. */
export const FederationMediaManifestSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("media-manifest"),
    packageId: z.uuid(),
    senderSiteId: z.uuid(),
    recipientSiteId: z.uuid(),
    agreementRevisionId: z.uuid(),
    createdAt: z.iso.datetime(),
    subject: z.union([
      z.strictObject({
        kind: z.literal("dataset"),
        asset: FederationAssetRefSchema.refine((asset) => asset.kind === "dataset"),
      }),
      TaskPackage,
    ]),
    files: z
      .array(
        z.strictObject({
          path: FederationInputPathSchema,
          sizeBytes: z.number().int().nonnegative().max(FEDERATION_MEDIA_MAX_BYTES),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          license: z.string().trim().min(1).max(256).nullable(),
          provenance: z
            .strictObject({
              source: z.string().trim().min(1).max(2048),
              revision: z.string().trim().min(1).max(256).nullable(),
            })
            .nullable(),
        }),
      )
      .min(1)
      .max(FEDERATION_MEDIA_MAX_FILES),
  })
  .superRefine((value, ctx) => {
    const paths = new Set(value.files.map((file) => file.path));
    const overlap = value.files.some((file) =>
      file.path
        .split("/")
        .some((_, index, parts) => index > 0 && paths.has(parts.slice(0, index).join("/"))),
    );
    if (
      value.senderSiteId === value.recipientSiteId ||
      paths.size !== value.files.length ||
      overlap ||
      value.files.reduce((sum, file) => sum + file.sizeBytes, 0) > FEDERATION_MEDIA_MAX_BYTES
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid media routing, paths or byte limit" });
    }
  });
export type FederationMediaManifest = z.infer<typeof FederationMediaManifestSchema>;
