import { z } from "zod";
import { FederationDigestSchema } from "./references";

const Id = z.uuid();
const Sequence = z.string().regex(/^[1-9][0-9]{0,19}$/);
const KeyId = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);

/** The complete manifest is private. Sequence numbers are scoped to domain + issuer. */
export const FederationEvidenceBatchSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("evidence-batch"),
    batchId: Id,
    domainId: Id,
    agreementRevisionId: Id,
    epoch: Id,
    issuerSiteId: Id,
    counterpartySiteId: Id,
    confirmation: z.enum(["unilateral", "bilateral"]),
    salt: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    records: z
      .array(
        z.strictObject({
          evidenceId: Id,
          sequence: Sequence,
          kind: z.enum(["delegation", "acceptance"]),
          digest: FederationDigestSchema,
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((value, ctx) => {
    if (value.issuerSiteId === value.counterpartySiteId)
      ctx.addIssue({ code: "custom", message: "Different sites required" });
    if (new Set(value.records.map((r) => r.evidenceId)).size !== value.records.length)
      ctx.addIssue({ code: "custom", message: "Duplicate evidence" });
    for (let i = 1; i < value.records.length; i++) {
      const prior = value.records[i - 1];
      const current = value.records[i];
      if (prior && current && BigInt(current.sequence) !== BigInt(prior.sequence) + 1n)
        ctx.addIssue({ code: "custom", message: "Non-contiguous sequence" });
    }
  });
export type FederationEvidenceBatch = z.infer<typeof FederationEvidenceBatchSchema>;

export const FederationEvidenceEnvelopeSchema = z.strictObject({
  issuerJws: z.string().min(1).max(524288),
  counterpartyJws: z.string().min(1).max(524288).optional(),
});
export type FederationEvidenceEnvelope = z.infer<typeof FederationEvidenceEnvelopeSchema>;

const SigningKey = z
  .strictObject({
    keyId: KeyId,
    publicKeyPem: z.string().min(1).max(16384),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime(),
  })
  .refine((v) => Date.parse(v.validFrom) < Date.parse(v.validUntil), "Invalid key interval");

/** Public, deployment-approved metadata only; no agreement terms, usage or prices. */
export const FabricEvidenceTrustSchema = z
  .strictObject({
    version: z.literal(1),
    generationId: Id,
    organizations: z
      .array(
        z.strictObject({
          siteId: Id,
          mspId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
          keys: z.array(SigningKey).min(1).max(20),
        }),
      )
      .min(2)
      .max(50),
    domains: z
      .array(
        z.strictObject({
          domainId: Id,
          collection: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
          siteIds: z.tuple([Id, Id]),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((value, ctx) => {
    const sites = value.organizations.map((o) => o.siteId);
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (!unique(sites) || !unique(value.organizations.map((o) => o.mspId)))
      ctx.addIssue({ code: "custom", message: "Duplicate organization" });
    for (const org of value.organizations)
      if (!unique(org.keys.map((k) => k.keyId)))
        ctx.addIssue({ code: "custom", message: "Duplicate signing key" });
    if (
      !unique(value.domains.map((d) => d.domainId)) ||
      !unique(value.domains.map((d) => d.collection))
    )
      ctx.addIssue({ code: "custom", message: "Duplicate domain or collection" });
    for (const domain of value.domains)
      if (
        domain.siteIds[0] === domain.siteIds[1] ||
        domain.siteIds.some((id) => !sites.includes(id))
      )
        ctx.addIssue({ code: "custom", message: "Invalid domain membership" });
  });
export type FabricEvidenceTrust = z.infer<typeof FabricEvidenceTrustSchema>;

/** Read and endorsement policies are separate: only members receive data; both endorse writes. */
export function fabricEvidenceCollections(trust: FabricEvidenceTrust) {
  const config = FabricEvidenceTrustSchema.parse(trust);
  return config.domains.map((domain) => {
    const msps = domain.siteIds.map((id) => {
      const org = config.organizations.find((o) => o.siteId === id);
      if (!org) throw new Error("Invalid domain membership");
      return org.mspId;
    });
    return {
      name: domain.collection,
      policy: `OR(${msps.map((msp) => `'${msp}.member'`).join(",")})`,
      requiredPeerCount: 1,
      maxPeerCount: 3,
      blockToLive: 0,
      memberOnlyRead: true,
      memberOnlyWrite: true,
      endorsementPolicy: {
        signaturePolicy: `AND(${msps.map((msp) => `'${msp}.peer'`).join(",")})`,
      },
    };
  });
}

export const FabricAnchorReceiptSchema = z.strictObject({
  batchId: Id,
  digest: FederationDigestSchema,
});

/** No pricing, terms, record identities, counts or private signatures in transaction responses. */
export type FabricAnchorReceipt = z.infer<typeof FabricAnchorReceiptSchema>;
