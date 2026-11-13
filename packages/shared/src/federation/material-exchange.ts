import { z } from "zod";
import { FederationDigestSchema } from "./references";
import {
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
  hasFederationQueryWindow,
} from "./status";

export const FEDERATION_MATERIAL_CHUNK_BYTES = 65_536;
export const FEDERATION_MATERIAL_MAX_BYTES = 1_048_576;
const Selection = {
  materialDigest: FederationDigestSchema,
  offset: z
    .number()
    .int()
    .min(0)
    .max(FEDERATION_MATERIAL_MAX_BYTES - 1)
    .refine((value) => value % FEDERATION_MATERIAL_CHUNK_BYTES === 0),
};

export const FederationMaterialQuerySchema = z
  .strictObject({
    ...FederationStatusQuerySchema.shape,
    ...Selection,
    kind: z.literal("material-query"),
  })
  .refine(hasFederationQueryWindow);
export type FederationMaterialQuery = z.infer<typeof FederationMaterialQuerySchema>;

export const FederationMaterialChunkSchema = z.strictObject({
  ...FederationStatusReportSchema.omit({ preparation: true, workflow: true }).shape,
  ...Selection,
  kind: z.literal("material-chunk"),
  totalBytes: z.number().int().min(1).max(FEDERATION_MATERIAL_MAX_BYTES),
  bytes: z
    .string()
    .min(4)
    .max(87_384)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
