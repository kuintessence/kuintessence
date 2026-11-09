import { z } from "zod";
import { CommercialArbitrationPolicySchema } from "./arbitration-policy";
import { FederationDigestSchema } from "./references";

/** The new withdrawal authenticates the original policy bytes, even after its approval purpose expires. */
export const ArbitrationRevocationNoticeSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("arbitration-revocation-notice"),
    noticeId: z.uuid(),
    issuerSiteId: z.uuid(),
    receivingSiteId: z.uuid(),
    policy: CommercialArbitrationPolicySchema,
    policyJws: z.string().min(1).max(524288),
    revocationJws: z.string().min(1).max(524288),
    issuedAt: z.iso.datetime(),
  })
  .refine((value) => value.issuerSiteId !== value.receivingSiteId);
export type ArbitrationRevocationNotice = z.infer<typeof ArbitrationRevocationNoticeSchema>;
export const ArbitrationRevocationReceiptSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("arbitration-revocation-receipt"),
    noticeId: z.uuid(),
    noticeDigest: FederationDigestSchema,
    policyId: z.uuid(),
    policyDigest: FederationDigestSchema,
    revocationId: z.uuid(),
    revocationDigest: FederationDigestSchema,
    issuerSiteId: z.uuid(),
    receivingSiteId: z.uuid(),
    recordedAt: z.iso.datetime(),
  })
  .refine((value) => value.issuerSiteId !== value.receivingSiteId);
