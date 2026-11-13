import type { PgDb, PgTransaction } from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  ArbitrationReviewInputSchema,
  ArbitrationReviewSchema,
} from "@kuintessence/shared/federation/arbitration-context";
import type { z } from "zod";
import type { FederationArbitrationContextService } from "./arbitration-context";
import type { FederationEvidenceService } from "./disclosure-delivery";
import type { FederationActor } from "./permissions";

/** A current review of prerequisites. No award, debit, case closure or implicit material import. */
export class FederationArbitrationReviewService {
  constructor(
    private readonly db: PgDb,
    private readonly contexts: FederationArbitrationContextService,
    private readonly evidence: FederationEvidenceService,
  ) {}
  async review(
    actor: FederationActor,
    caseId: string,
    raw: z.infer<typeof ArbitrationReviewInputSchema>,
  ) {
    const proof = await this.prepare(actor, caseId, raw);
    return this.db.transaction((tx) => this.verify(tx, actor, caseId, proof));
  }
  async prepare(
    actor: FederationActor,
    caseId: string,
    raw: z.infer<typeof ArbitrationReviewInputSchema>,
  ) {
    const input = ArbitrationReviewInputSchema.parse(raw);
    const contextProof = await this.contexts.prepare(actor, caseId);
    // Refuse unconfirmed freezes before asking either institution for evidence access.
    const initial = await this.db.transaction((tx) =>
      this.contexts.verify(tx, actor, caseId, contextProof),
    );
    if (!initial.financial) throw new FederationError("DATA_WAITING");
    const results = await Promise.allSettled(
      input.grantIds.map((id) => this.evidence.prepareRead(actor, caseId, id)),
    );
    const proofs = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    return { contextProof, proofs };
  }
  async verify(
    tx: PgTransaction,
    actor: FederationActor,
    caseId: string,
    prepared: Awaited<ReturnType<FederationArbitrationReviewService["prepare"]>>,
  ) {
    const { contextProof, proofs } = prepared;
    const context = await this.contexts.verify(tx, actor, caseId, contextProof);
    if (!context.financial) throw new FederationError("DATA_WAITING");
    const verified = [];
    for (const proof of proofs)
      verified.push(await this.evidence.verifyRead(tx, actor, caseId, proof));
    const groups = new Map<string, { recordType: string; fields: Map<string, string> }>();
    for (const entry of verified) {
      const { grant, evidence } = entry.payload,
        b = context.binding;
      if (
        grant.caseId !== b.caseId ||
        grant.agreementRevisionId !== b.agreementRevisionId ||
        grant.domainId !== b.domainId ||
        grant.sourceSiteId !== b.sourceSiteId ||
        grant.targetSiteId !== b.targetSiteId ||
        grant.recipientSiteId !== b.arbitratorSiteId ||
        !context.financial.evidenceReferences.some(
          (ref) =>
            ref.recordType === grant.recordType &&
            ref.recordId === grant.recordId &&
            ref.recordDigest === grant.recordDigest,
        )
      )
        throw new FederationError("POLICY_DENIED");
      const allowed = context.policy.disclosures.find((s) => s.recordType === grant.recordType);
      if (
        !allowed ||
        !grant.fields.every((field) => (allowed.fields as readonly string[]).includes(field))
      )
        throw new FederationError("POLICY_DENIED");
      const key = `${grant.recordType}:${grant.recordId}:${grant.recordDigest}`;
      const group = groups.get(key) ?? {
        recordType: grant.recordType,
        fields: new Map<string, string>(),
      };
      for (const [field, value] of Object.entries(evidence.values)) {
        const encoded = federationCanonicalJson(value);
        if (group.fields.has(field) && group.fields.get(field) !== encoded)
          throw new FederationError("OPERATION_CONFLICT");
        group.fields.set(field, encoded);
      }
      groups.set(key, group);
    }
    for (const required of context.policy.requiredEvidence)
      if (
        ![...groups.values()].some(
          (g) =>
            g.recordType === required.recordType &&
            required.fields.every((field) => g.fields.has(field)),
        )
      )
        throw new FederationError("DATA_WAITING");
    const until = Math.min(
      Date.parse(context.expiresAt),
      ...verified.map((v) => Date.parse(v.expiresAt)),
    );
    if (until <= Date.now()) throw new FederationError("AUTHORIZATION_EXPIRED");
    return ArbitrationReviewSchema.parse({
      context,
      expiresAt: new Date(until).toISOString(),
      evidence: verified.map((v) => ({
        grantId: v.payload.grant.grantId,
        disclosureDigest: v.digest,
        recordType: v.payload.grant.recordType,
        recordId: v.payload.grant.recordId,
        recordDigest: v.payload.grant.recordDigest,
        fields: v.payload.grant.fields,
      })),
    });
  }
}
