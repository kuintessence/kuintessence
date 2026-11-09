import { z } from "zod";
import { federationCanonicalJson } from "./assets";
import {
  FEDERATION_MEDIA_MAX_BYTES,
  FEDERATION_MEDIA_MAX_FILES,
  FederationMediaImportApprovalSchema,
  FederationMediaManifestSchema,
  FederationTaskMediaExportApprovalSchema,
} from "./media";
import { FederationMediaReceiptAckSchema, FederationMediaReceiptSchema } from "./media-receipts";
import { FederationDigestSchema } from "./references";

export const MediaOptionsQuerySchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("agreements") }),
    z.object({ kind: z.literal("agents") }),
    z.object({ kind: z.literal("roots"), agentId: z.string().min(1).max(255) }),
  ])
  .and(
    z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().nonnegative().default(0),
    }),
  );
const OptionsPage = {
  localSiteId: z.uuid(),
  localOrgId: z.uuid(),
  hasMore: z.boolean(),
};
export const MediaOptionsSchema = z.discriminatedUnion("kind", [
  z.object({
    ...OptionsPage,
    kind: z.literal("agreements"),
    data: z
      .array(
        z.object({
          revisionId: z.uuid(),
          peerSiteId: z.uuid(),
          peerName: z.string(),
          validFrom: z.iso.datetime(),
          validUntil: z.iso.datetime(),
          resultAvailableUntil: z.iso.datetime().nullable(),
        }),
      )
      .max(100),
  }),
  z.object({
    ...OptionsPage,
    kind: z.literal("agents"),
    data: z
      .array(
        z.object({
          agentId: z.string().min(1),
          name: z.string(),
          status: z.string(),
        }),
      )
      .max(100),
  }),
  z.object({
    ...OptionsPage,
    kind: z.literal("roots"),
    agentId: z.string().min(1),
    data: z.array(z.object({ id: z.uuid(), label: z.string() })).max(100),
  }),
]);

const Revocation = {
  revokedAt: z.iso.datetime().nullable(),
  revocationReason: z.string().nullable(),
};
const TaskSelection = FederationTaskMediaExportApprovalSchema.pick({
  kind: true,
  operationId: true,
  agentId: true,
});
/** Public API views deliberately strip unrecognized internal fields. */
export const MediaExportSummarySchema = z.object({
  packageId: z.uuid(),
  recipientSiteId: z.uuid(),
  agreementRevisionId: z.uuid(),
  versionId: z.uuid().nullable(),
  locationId: z.uuid().nullable(),
  taskSelection: TaskSelection.nullable(),
  manifestDigest: FederationDigestSchema,
  approvedAt: z.iso.datetime(),
  approvedBy: z.uuid(),
  expiresAt: z.iso.datetime(),
  ...Revocation,
});
export const MediaExportDetailSchema = MediaExportSummarySchema.extend({
  manifest: FederationMediaManifestSchema,
  signedManifest: z.string().min(1).max(524_288),
}).refine((row) => {
  const m = row.manifest;
  return (
    row.packageId === m.packageId &&
    row.recipientSiteId === m.recipientSiteId &&
    row.agreementRevisionId === m.agreementRevisionId &&
    (row.taskSelection
      ? m.subject.kind === row.taskSelection.kind &&
        m.subject.operationId === row.taskSelection.operationId &&
        row.versionId === null &&
        row.locationId === null
      : m.subject.kind === "dataset" && row.versionId !== null && row.locationId !== null)
  );
}, "Mismatched media export");
export const MediaPackageSummarySchema = z.object({
  packageId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  agreementRevisionId: z.uuid(),
  manifestDigest: FederationDigestSchema,
  subject: FederationMediaManifestSchema.shape.subject,
  fileCount: z.number().int().min(1).max(FEDERATION_MEDIA_MAX_FILES),
  sizeBytes: z.number().int().nonnegative().max(FEDERATION_MEDIA_MAX_BYTES),
  registeredAt: z.iso.datetime(),
  registeredBy: z.uuid(),
  ...Revocation,
});
export const MediaImportAuthorizationSchema = FederationMediaImportApprovalSchema.extend({
  localSiteId: z.uuid(),
  packageId: z.uuid(),
  approvedBy: z.uuid(),
  approvedAt: z.iso.datetime(),
  ...Revocation,
}).strip();
export const MediaPackageDetailSchema = MediaPackageSummarySchema.extend({
  manifest: FederationMediaManifestSchema,
  signedManifest: z.string().min(1).max(524_288),
  authorizations: z.array(MediaImportAuthorizationSchema).max(100),
  hasMoreAuthorizations: z.boolean(),
}).refine(
  (row) =>
    row.packageId === row.manifest.packageId &&
    row.senderSiteId === row.manifest.senderSiteId &&
    row.recipientSiteId === row.manifest.recipientSiteId &&
    row.agreementRevisionId === row.manifest.agreementRevisionId &&
    federationCanonicalJson(row.subject) === federationCanonicalJson(row.manifest.subject) &&
    row.fileCount === row.manifest.files.length &&
    row.sizeBytes === row.manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) &&
    row.authorizations.every(
      (a) => a.packageId === row.packageId && a.localSiteId === row.recipientSiteId,
    ),
  "Mismatched received package",
);
export const MediaExportOperationSchema = z
  .object({
    localSiteId: z.uuid(),
    packageId: z.uuid(),
    generation: z.uuid(),
    requestedBy: z.uuid(),
    state: z.enum(["queued", "exported", "failed"]),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    updatedAt: z.iso.datetime(),
  })
  .refine((row) =>
    row.state === "exported"
      ? row.sha256 !== null && row.sizeBytes !== null
      : row.sha256 === null && row.sizeBytes === null,
  );
export const MediaImportOperationSchema = z
  .object({
    authorizationId: z.uuid(),
    generation: z.uuid(),
    requestedBy: z.uuid(),
    state: z.enum(["queued", "verified", "failed"]),
    verifiedBytes: z.number().int().nonnegative().max(FEDERATION_MEDIA_MAX_BYTES).nullable(),
    verifiedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .refine((row) =>
    row.state === "verified"
      ? row.verifiedBytes !== null && row.verifiedAt !== null
      : row.verifiedBytes === null && row.verifiedAt === null,
  );
export const MediaImportReceiptViewSchema = z
  .object({
    state: z.enum(["awaiting-import", "pending", "recorded"]),
    receipt: FederationMediaReceiptSchema.nullable(),
    signedReceipt: z.string().nullable(),
    acknowledgement: FederationMediaReceiptAckSchema.nullable(),
    signedAcknowledgement: z.string().nullable(),
    lastError: z.string().nullable(),
    nextAttemptAt: z.iso.datetime(),
  })
  .refine((row) => {
    if (
      row.state === "recorded" &&
      (!row.receipt || !row.acknowledgement || !row.signedReceipt || !row.signedAcknowledgement)
    )
      return false;
    if (
      row.acknowledgement &&
      (!row.receipt ||
        row.receipt.receiptId !== row.acknowledgement.receiptId ||
        row.receipt.packageId !== row.acknowledgement.packageId ||
        row.receipt.senderSiteId !== row.acknowledgement.recipientSiteId ||
        row.receipt.recipientSiteId !== row.acknowledgement.senderSiteId)
    )
      return false;
    return true;
  }, "Incomplete or mismatched media receipt");

export const MediaRecordedReceiptSchema = z
  .object({
    receipt: FederationMediaReceiptSchema,
    signedReceipt: z.string().min(1),
    acknowledgement: FederationMediaReceiptAckSchema,
    signedAcknowledgement: z.string().min(1),
  })
  .refine(
    ({ receipt, acknowledgement: ack }) =>
      receipt.receiptId === ack.receiptId &&
      receipt.packageId === ack.packageId &&
      receipt.senderSiteId === ack.recipientSiteId &&
      receipt.recipientSiteId === ack.senderSiteId,
    "Mismatched media receipt acknowledgement",
  );
