import { FederationDigestSchema, federationCanonicalJson } from "@kuintessence/shared/federation";
import { ArbitrationDecisionSchema } from "@kuintessence/shared/federation/arbitration-decision";
import { CommercialEvidenceCaseInputSchema } from "@kuintessence/shared/federation/disclosure-authorization";
import { z } from "zod";
export const EvidenceCaseSchema = z
  .object({
    localSiteId: z.uuid(),
    localOrgId: z.uuid(),
    caseId: z.uuid(),
    context: CommercialEvidenceCaseInputSchema,
    createdAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (row) =>
      row.caseId === row.context.caseId && row.localSiteId === row.context.evidenceRecipientSiteId,
  );
export type EvidenceCase = z.infer<typeof EvidenceCaseSchema>;
export const DecisionViewSchema = z.object({
  payload: ArbitrationDecisionSchema,
  digest: FederationDigestSchema,
  approvedAt: z.iso.datetime(),
});
export function checkCaseBinding(
  binding: {
    caseId: string;
    domainId: string;
    agreementRevisionId: string;
    agreementDigest: string;
    sourceSiteId: string;
    targetSiteId: string;
    arbitratorSiteId: string;
  },
  row: EvidenceCase,
) {
  const { arbitratorSiteId, ...context } = binding;
  const expected = row.context;
  for (const key of [
    "caseId",
    "domainId",
    "agreementRevisionId",
    "agreementDigest",
    "sourceSiteId",
    "targetSiteId",
  ] as const)
    if (context[key] !== expected[key]) throw new Error("Arbitration case scope mismatch");
  if (arbitratorSiteId !== row.localSiteId) throw new Error("Arbitrator scope mismatch");
}
export function checkEvidenceScope(
  scope: z.infer<typeof CommercialEvidenceCaseInputSchema>,
  row: EvidenceCase,
) {
  const keys = CommercialEvidenceCaseInputSchema.keyof().options;
  if (
    federationCanonicalJson(Object.fromEntries(keys.map((key) => [key, scope[key]]))) !==
    federationCanonicalJson(row.context)
  )
    throw new Error("Evidence case scope mismatch");
}
