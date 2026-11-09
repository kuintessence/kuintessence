import { z } from "zod";
import { CasePublicationSchema } from "./case-ledger";
import { FederationDigestSchema } from "./references";

/** The publication body is bound by the signed withdrawal digest; no original commercial fields. */
export const CaseRevocationNoticeSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("case-revocation-notice"),
    noticeId: z.uuid(),
    issuerSiteId: z.uuid(),
    receivingSiteId: z.uuid(),
    publication: CasePublicationSchema,
    publicationJws: z.string().min(1).max(524288),
    revocationJws: z.string().min(1).max(524288),
    issuedAt: z.iso.datetime(),
  })
  .refine((value) => value.issuerSiteId !== value.receivingSiteId);
export type CaseRevocationNotice = z.infer<typeof CaseRevocationNoticeSchema>;
export const CaseRevocationReceiptSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("case-revocation-receipt"),
    noticeId: z.uuid(),
    noticeDigest: FederationDigestSchema,
    publicationId: z.uuid(),
    publicationDigest: FederationDigestSchema,
    revocationId: z.uuid(),
    revocationDigest: FederationDigestSchema,
    issuerSiteId: z.uuid(),
    receivingSiteId: z.uuid(),
    recordedAt: z.iso.datetime(),
  })
  .refine((value) => value.issuerSiteId !== value.receivingSiteId);
