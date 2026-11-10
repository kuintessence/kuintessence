import { z } from "zod";
import { FederationCancellationReceiptSchema } from "./cancellation";
import {
  FederationAcceptanceSchema,
  FederationAmountSchema,
  FederationResourcesSchema,
} from "./index";
import { FederationAssetRefSchema, FederationDigestSchema } from "./references";
import { FederationStatusReportSchema } from "./status";

/** Personnel views deliberately omit transport signatures, endpoints and storage credentials. */
export const FederationOutboundViewSchema = z.object({
  localOrgId: z.uuid(),
  localSiteId: z.uuid(),
  targetSiteId: z.uuid(),
  operationId: z.uuid(),
  agreementRevisionId: z.uuid(),
  taskId: z.uuid(),
  attempt: z.number().int().positive(),
  template: FederationAssetRefSchema,
  resources: FederationResourcesSchema,
  maxAmount: FederationAmountSchema,
  unit: z.string(),
  state: z.enum(["queued", "sending", "accepted", "needs_review"]),
  lastError: z.string().nullable(),
  receipt: FederationAcceptanceSchema.nullable(),
  cancellation: z
    .object({
      state: z.enum(["queued", "sending", "pending", "stopped", "needs_review"]),
      lastError: z.string().nullable(),
      receipt: FederationCancellationReceiptSchema.nullable(),
    })
    .nullable(),
  remoteStatus: z.object({
    preparation: FederationStatusReportSchema.shape.preparation,
    workflow: FederationStatusReportSchema.shape.workflow,
    observedAt: z.iso.datetime().nullable(),
    verifiedAt: z.iso.datetime().nullable(),
    lastError: z.string().nullable(),
    nextAttemptAt: z.iso.datetime().nullable(),
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type FederationOutboundView = z.infer<typeof FederationOutboundViewSchema>;

export const FederationResultImportViewSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  manifestDigest: FederationDigestSchema,
  state: z.enum(["pending", "transferring", "verifying", "available", "cancelled", "needs_review"]),
  lastError: z.string().nullable(),
  delivery: z.enum(["network", "media"]),
  receipt: z
    .object({
      state: z.enum(["recorded", "pending"]),
      receivedAt: z.iso.datetime(),
      recordedAt: z.iso.datetime().nullable(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  members: z.array(
    z.object({
      id: z.uuid(),
      outputId: FederationDigestSchema,
      path: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      state: z.string(),
      fileId: z.uuid().nullable(),
    }),
  ),
});
export type FederationResultImportView = z.infer<typeof FederationResultImportViewSchema>;

export const FederationMaterialOptionSchema = z.object({
  localOrgId: z.uuid(),
  originSiteId: z.uuid(),
  digest: FederationDigestSchema,
  kind: z.enum(["inputs", "environment-lock"]),
  createdAt: z.iso.datetime(),
});
