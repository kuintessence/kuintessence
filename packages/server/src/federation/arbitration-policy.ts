import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialAgreements as contracts,
  federationSites,
  type PgDb,
  type PgTransaction,
  federationArbitrationPolicies as policies,
  federationCommercialSubmissions as submissions,
} from "@kuintessence/db";
import {
  type FederationDelegation,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  type ArbitrationRequestScope,
  assertArbitrationRequest,
  type CommercialArbitrationPolicy,
  CommercialArbitrationPolicyDraftSchema,
  CommercialArbitrationPolicySchema,
} from "@kuintessence/shared/federation/arbitration-policy";
import { CommercialArbitrationRevocationSchema } from "@kuintessence/shared/federation/arbitration-revocation";
import {
  CommercialAdapterProposalInputSchema,
  CommercialAgreementSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Independent arbitration consent; policy approval alone never authorizes a task or financial write. */
export class FederationArbitrationPolicyService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  /** Called only while creating the original workflow intent; replays keep its saved request. */
  async bindingForRequest(tx: PgTransaction, orgId: string, request: ArbitrationRequestScope) {
    if (!request.arbitration) return undefined;
    const { row } = await this.verified(
      tx,
      { orgId },
      request.agreementRevisionId,
      request.arbitration.policyId,
    );
    assertArbitrationRequest(row.payload, row.digest, request, new Date());
    if (!row.counterpartyJws) throw new FederationError("POLICY_DENIED");
    const source = this.signing.siteId === row.payload.sourceSiteId;
    return {
      policyId: row.policyId,
      policyDigest: row.digest,
      sourceJws: source ? row.approvalJws : row.counterpartyJws,
      targetJws: source ? row.counterpartyJws : row.approvalJws,
    };
  }
  /** Binding is checked inside the original admission transaction, before its request is persisted. */
  async authorizeRequest(tx: PgTransaction, orgId: string, request: FederationDelegation) {
    if (!request.arbitration) return;
    const binding = await this.bindingForRequest(tx, orgId, request);
    if (
      binding?.sourceJws !== request.arbitration.sourceJws ||
      binding?.targetJws !== request.arbitration.targetJws
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  private key(actor: Pick<FederationActor, "orgId">, revisionId: string, policyId: string) {
    return and(
      eq(policies.localSiteId, this.signing.siteId),
      eq(policies.localOrgId, actor.orgId),
      eq(policies.agreementRevisionId, revisionId),
      eq(policies.policyId, policyId),
    );
  }
  private async contract(
    tx: PgTransaction,
    actor: Pick<FederationActor, "orgId">,
    revisionId: string,
  ) {
    const [row] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.localOrgId, actor.orgId),
          eq(contracts.revisionId, revisionId),
        ),
      )
      .for("share");
    if (!row?.counterpartyJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return row;
  }
  private async verify<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
  ) {
    const keyId = federationMessageKeyId(jws),
      now = new Date();
    await this.trust.assertKey(tx, siteId, keyId, now);
    return verifyFederationMessage(
      schema,
      jws,
      await this.trust.resolveKey(siteId, keyId, now, tx),
      now,
    );
  }
  private async original(
    tx: PgTransaction,
    actor: Pick<FederationActor, "orgId">,
    revisionId: string,
  ) {
    const row = await this.contract(tx, actor, revisionId);
    const { sourceSiteId, targetSiteId } = row.terms.agreement;
    if (![sourceSiteId, targetSiteId].includes(this.signing.siteId))
      throw new FederationError("POLICY_DENIED");
    const other = sourceSiteId === this.signing.siteId ? targetSiteId : sourceSiteId;
    const originals = [
      [this.signing.siteId, row.approvalJws],
      [other, row.counterpartyJws],
    ];
    for (const [siteId, jws] of originals.sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
      if (!siteId || !jws) throw new FederationError("INVALID_MESSAGE");
      const verified = await this.verify(tx, CommercialAgreementSchema, jws, siteId);
      if (
        verified.digest !== row.digest ||
        federationCanonicalJson(verified.payload) !== federationCanonicalJson(row.terms)
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    return { row, other };
  }
  private async arbitrator(
    tx: PgTransaction,
    arbitratorSiteId: string,
    source: string,
    target: string,
  ) {
    if ([source, target].includes(arbitratorSiteId)) throw new FederationError("POLICY_DENIED");
    const [site] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, arbitratorSiteId))
      .for("share");
    if (site?.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
  }
  private check(value: CommercialArbitrationPolicy, contract: typeof contracts.$inferSelect) {
    const { sourceSiteId, targetSiteId, agreementRevisionId } = contract.terms.agreement;
    const now = Date.now();
    if (Date.parse(value.issuedAt) > now || Date.parse(value.validUntil) <= now)
      throw new FederationError("AUTHORIZATION_EXPIRED");
    if (
      value.agreementRevisionId !== agreementRevisionId ||
      value.agreementDigest !== contract.digest ||
      value.domainId !== contract.terms.domainId ||
      value.unit !== contract.terms.agreement.unit ||
      value.sourceSiteId !== sourceSiteId ||
      value.targetSiteId !== targetSiteId ||
      Date.parse(value.issuedAt) < Date.parse(contract.terms.createdAt)
    )
      throw new FederationError("POLICY_DENIED");
  }
  /** Validate existing consent without requiring the peer's approval or a started validity window. */
  async exchangeRecord(tx: PgTransaction, orgId: string, revisionId: string, policyId: string) {
    const actor = { orgId };
    const { row: contract, other } = await this.original(tx, actor, revisionId);
    const [row] = await tx
      .select()
      .from(policies)
      .where(this.key(actor, revisionId, policyId))
      .for("share");
    if (!row) return null;
    if (row.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
    this.check(row.payload, contract);
    await this.arbitrator(
      tx,
      row.arbitratorSiteId,
      row.payload.sourceSiteId,
      row.payload.targetSiteId,
    );
    const own = await this.verify(
      tx,
      CommercialArbitrationPolicySchema,
      row.approvalJws,
      this.signing.siteId,
    );
    if (
      own.digest !== row.digest ||
      federationCanonicalJson(own.payload) !== federationCanonicalJson(row.payload) ||
      (row.counterpartyJws &&
        (await this.verify(tx, CommercialArbitrationPolicySchema, row.counterpartyJws, other))
          .digest !== row.digest)
    )
      throw new FederationError("OPERATION_CONFLICT");
    await this.original(tx, actor, revisionId);
    this.check(row.payload, contract);
    return { row, other };
  }
  /** Hold current consent against revocation; callers must separately bind the original admission. */
  async verified(
    tx: PgTransaction,
    actor: Pick<FederationActor, "orgId">,
    revisionId: string,
    policyId: string,
  ) {
    const record = await this.exchangeRecord(tx, actor.orgId, revisionId, policyId);
    if (!record?.row.counterpartyJws) throw new FederationError("POLICY_DENIED");
    if (Date.parse(record.row.payload.validFrom) > Date.now())
      throw new FederationError("AUTHORIZATION_EXPIRED");
    return record;
  }
  async draft(
    actor: FederationActor,
    revisionId: string,
    raw: z.infer<typeof CommercialArbitrationPolicyDraftSchema>,
  ) {
    const input = CommercialArbitrationPolicyDraftSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const { row } = await this.original(tx, actor, revisionId);
      const { sourceSiteId, targetSiteId } = row.terms.agreement;
      await this.arbitrator(tx, input.arbitratorSiteId, sourceSiteId, targetSiteId);
      const now = new Date().toISOString();
      if (Date.parse(input.validUntil) <= Date.parse(now))
        throw new FederationError("AUTHORIZATION_EXPIRED");
      return CommercialArbitrationPolicySchema.parse({
        ...input,
        protocolVersion: 1,
        kind: "commercial-arbitration-policy",
        domainId: row.terms.domainId,
        agreementRevisionId: revisionId,
        agreementDigest: row.digest,
        sourceSiteId,
        targetSiteId,
        issuedAt: now,
        validFrom: now,
        salt: randomBytes(32).toString("hex"),
        unit: row.terms.agreement.unit,
      });
    });
  }
  async approve(actor: FederationActor, revisionId: string, raw: CommercialArbitrationPolicy) {
    const value = CommercialArbitrationPolicySchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "arbitration.approve");
      const { row: contract } = await this.original(tx, actor, revisionId);
      this.check(value, contract);
      await this.arbitrator(tx, value.arbitratorSiteId, value.sourceSiteId, value.targetSiteId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`arbitration-policy:${this.signing.siteId}:${value.policyId}`}, 0))`,
      );
      await this.original(tx, actor, revisionId);
      this.check(value, contract);
      const [prior] = await tx
        .select()
        .from(policies)
        .where(
          and(eq(policies.localSiteId, this.signing.siteId), eq(policies.policyId, value.policyId)),
        )
        .for("share");
      if (prior) {
        if (
          prior.localOrgId !== actor.orgId ||
          prior.agreementRevisionId !== revisionId ||
          federationCanonicalJson(prior.payload) !== federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
        if (prior.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
        const signed = await this.verify(
          tx,
          CommercialArbitrationPolicySchema,
          prior.approvalJws,
          this.signing.siteId,
        );
        if (signed.digest !== prior.digest) throw new FederationError("OPERATION_CONFLICT");
        return prior;
      }
      const jws = await signFederationMessage(
        CommercialArbitrationPolicySchema,
        value,
        this.signing,
      );
      const signed = await this.verify(
        tx,
        CommercialArbitrationPolicySchema,
        jws,
        this.signing.siteId,
      );
      this.check(value, contract);
      const [row] = await tx
        .insert(policies)
        .values({
          localSiteId: this.signing.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          policyId: value.policyId,
          arbitratorSiteId: value.arbitratorSiteId,
          payload: value,
          digest: signed.digest,
          approvalJws: jws,
          approvedBy: actor.userId,
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.arbitration_policy.approve",
        target: value.policyId,
        diff: { after: { digest: row.digest, arbitratorSiteId: value.arbitratorSiteId } },
      });
      return row;
    });
  }
  async attachExchanged(
    revisionId: string,
    policyId: string,
    jws: string,
    authorize: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.attach(revisionId, policyId, jws, undefined, authorize);
  }
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    policyId: string,
    jws: string,
  ) {
    return this.attach(revisionId, policyId, jws, actor);
  }
  private async attach(
    revisionId: string,
    policyId: string,
    jws: string,
    human?: FederationActor,
    authorize?: (tx: PgTransaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      if (human) await requireFederationCapability(tx, human, "arbitration.approve");
      const [scope] = await tx
        .select()
        .from(policies)
        .where(
          and(
            eq(policies.localSiteId, this.signing.siteId),
            eq(policies.policyId, policyId),
            eq(policies.agreementRevisionId, revisionId),
            human ? eq(policies.localOrgId, human.orgId) : undefined,
          ),
        );
      if (!scope) throw new FederationError("POLICY_DENIED");
      const actor = { orgId: scope.localOrgId };
      const { row: contract, other } = await this.original(tx, actor, revisionId);
      const [row] = await tx
        .select()
        .from(policies)
        .where(this.key(actor, revisionId, policyId))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.revokedAt) throw new FederationError("AUTHORIZATION_EXPIRED");
      this.check(row.payload, contract);
      await this.arbitrator(
        tx,
        row.arbitratorSiteId,
        row.payload.sourceSiteId,
        row.payload.targetSiteId,
      );
      const own = await this.verify(
        tx,
        CommercialArbitrationPolicySchema,
        row.approvalJws,
        this.signing.siteId,
      );
      const peer = await this.verify(tx, CommercialArbitrationPolicySchema, jws, other);
      if (
        own.digest !== row.digest ||
        peer.digest !== row.digest ||
        federationCanonicalJson(own.payload) !== federationCanonicalJson(row.payload)
      )
        throw new FederationError("OPERATION_CONFLICT");
      await authorize?.(tx);
      await this.original(tx, actor, revisionId);
      this.check(row.payload, contract);
      await this.verify(
        tx,
        CommercialArbitrationPolicySchema,
        row.approvalJws,
        this.signing.siteId,
      );
      await this.verify(tx, CommercialArbitrationPolicySchema, jws, other);
      if (row.counterpartyJws) {
        if (row.counterpartyJws !== jws) throw new FederationError("OPERATION_CONFLICT");
        return row;
      }
      this.check(row.payload, contract);
      const [saved] = await tx
        .update(policies)
        .set({ counterpartyJws: jws, confirmedAt: new Date() })
        .where(this.key(actor, revisionId, policyId))
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: human ? human.userId : `arbitration-exchange:${this.signing.siteId}`,
        orgId: actor.orgId,
        action: "federation.arbitration_policy.confirm",
        target: policyId,
        diff: { after: { digest: row.digest } },
      });
      return saved;
    });
  }
  async revoke(actor: FederationActor, revisionId: string, policyId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "arbitration.approve");
      const [row] = await tx
        .select()
        .from(policies)
        .where(this.key(actor, revisionId, policyId))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.revokedAt) return row;
      const [saved] = await tx
        .update(policies)
        .set({ revokedAt: new Date(), revokedBy: actor.userId })
        .where(this.key(actor, revisionId, policyId))
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.arbitration_policy.revoke",
        target: policyId,
        diff: { after: { digest: row.digest } },
      });
      return saved;
    });
  }
  /** Local revocation is independent; requesting a ledger fence requires a current withdrawal signer. */
  async submitRevocation(actor: FederationActor, revisionId: string, policyId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "arbitration.approve");
      const contract = await this.contract(tx, actor, revisionId);
      if (contract.terms.agreement.mode === "bilateral_direct")
        throw new FederationError("POLICY_DENIED");
      const [row] = await tx
        .select()
        .from(policies)
        .where(this.key(actor, revisionId, policyId))
        .for("update");
      if (
        !row?.revokedAt ||
        row.payload.agreementDigest !== contract.digest ||
        row.payload.domainId !== contract.terms.domainId ||
        row.payload.sourceSiteId !== contract.terms.agreement.sourceSiteId ||
        row.payload.targetSiteId !== contract.terms.agreement.targetSiteId ||
        ![row.payload.sourceSiteId, row.payload.targetSiteId].includes(this.signing.siteId)
      )
        throw new FederationError("POLICY_DENIED");
      const [prior] = await tx
        .select({ id: submissions.id, state: submissions.state })
        .from(submissions)
        .where(
          and(
            eq(submissions.localSiteId, this.signing.siteId),
            eq(submissions.agreementRevisionId, revisionId),
            sql`${submissions.input}->>'operation' = 'revoke-arbitration-policy'`,
            sql`${submissions.input}->>'policyId' = ${policyId}`,
          ),
        );
      if (prior) return prior;
      const payload = CommercialArbitrationRevocationSchema.parse({
        protocolVersion: 1,
        kind: "commercial-arbitration-revocation",
        revocationId: randomUUID(),
        policyId,
        policyDigest: row.digest,
        domainId: row.payload.domainId,
        agreementRevisionId: revisionId,
        agreementDigest: row.payload.agreementDigest,
        sourceSiteId: row.payload.sourceSiteId,
        targetSiteId: row.payload.targetSiteId,
        issuerSiteId: this.signing.siteId,
        issuedAt: new Date().toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      const jws = await signFederationMessage(
        CommercialArbitrationRevocationSchema,
        payload,
        this.signing,
      );
      const signed = await this.verify(
        tx,
        CommercialArbitrationRevocationSchema,
        jws,
        this.signing.siteId,
      );
      const input = CommercialAdapterProposalInputSchema.parse({
        operation: "revoke-arbitration-policy",
        domainId: payload.domainId,
        recordId: payload.revocationId,
        policyId,
        digest: signed.digest,
        envelope: { issuerSiteId: this.signing.siteId, revocationJws: jws },
      });
      const [saved] = await tx
        .insert(submissions)
        .values({
          id: randomUUID(),
          localSiteId: this.signing.siteId,
          agreementRevisionId: revisionId,
          input,
          state: "pending",
        })
        .returning({ id: submissions.id, state: submissions.state });
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.arbitration_policy.ledger_revocation",
        target: policyId,
        diff: {
          after: {
            submissionId: saved.id,
            revocationId: payload.revocationId,
            digest: signed.digest,
          },
        },
      });
      return saved;
    });
  }
  async list(
    actor: FederationActor,
    revisionId: string,
    limit = 50,
    offset = 0,
    policyId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor, revisionId);
      const rows = await tx
        .select()
        .from(policies)
        .where(
          and(
            eq(policies.localSiteId, this.signing.siteId),
            eq(policies.localOrgId, actor.orgId),
            eq(policies.agreementRevisionId, revisionId),
            policyId ? eq(policies.policyId, policyId) : undefined,
          ),
        )
        .orderBy(desc(policies.createdAt), desc(policies.policyId))
        .limit(limit + 1)
        .offset(offset);
      return { data: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }
}
