import { randomUUID } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  auditLog,
  federationCommercialAgreements as contracts,
  federationMarketRequests as marketRequests,
  type PgDb,
  type PgTransaction,
  federationReservationPolicies as policies,
} from "@kuintessence/db";
import {
  assertDelegationTerms,
  FederationAmountSchema,
  FederationError,
  federationExecutionDeadline,
} from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  type CommercialReservation,
  CommercialReservationSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireCoordinatedCommercialAgreement } from "./commercial-execution-policy";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { FederationTrustRegistry } from "./trust-registry";

export const ReservationPolicyInputSchema = z
  .strictObject({
    allowMarketPublish: z.boolean().default(false),
    allowMarketClaim: z.boolean().default(false),
    allowActivation: z.boolean().default(false),
    allowExecutionConfirmation: z.boolean().default(false),
    maxTaskAmount: FederationAmountSchema,
    maxTotalAmount: FederationAmountSchema,
    maxTasks: z.number().int().min(1).max(100_000),
    validUntil: z.iso.datetime({ offset: true }),
  })
  .refine((value) => BigInt(value.maxTaskAmount) <= BigInt(value.maxTotalAmount));

type ReservationPolicy = typeof policies.$inferSelect;
export function assertReservationPolicyActive(policy: ReservationPolicy, now: Date) {
  if (policy.revokedAt || now < policy.validFrom || now >= policy.validUntil)
    throw new FederationError("AUTHORIZATION_EXPIRED");
}

/** A policy grants institution-owned signing authority; execution and settlement remain separate. */
export class FederationReservationPolicyService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  private async contract(tx: PgTransaction, orgId: string, revisionId: string) {
    const [row] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.siteId),
          eq(contracts.localOrgId, orgId),
          eq(contracts.revisionId, revisionId),
        ),
      );
    if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return row;
  }

  async list(actor: FederationActor, revisionId: string, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor.orgId, revisionId);
      return tx
        .select({
          ...getTableColumns(policies),
          marketAuthorizedTasks: sql<number>`(select count(*)::int from ${marketRequests} where ${marketRequests.policyId} = ${policies.id})`,
          marketAuthorizedAmount: sql<string>`(select coalesce(sum((${marketRequests.payload}->'proposal'->'request'->>'maxAmount')::numeric),0)::text from ${marketRequests} where ${marketRequests.policyId} = ${policies.id})`,
        })
        .from(policies)
        .where(
          and(
            eq(policies.localSiteId, this.siteId),
            eq(policies.localOrgId, actor.orgId),
            eq(policies.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(desc(policies.validFrom), desc(policies.id))
        .limit(limit)
        .offset(offset);
    });
  }

  async grant(
    actor: FederationActor,
    revisionId: string,
    raw: z.input<typeof ReservationPolicyInputSchema>,
  ) {
    const input = ReservationPolicyInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const contract = await this.contract(tx, actor.orgId, revisionId);
      const terms = CommercialAgreementSchema.parse(contract.terms);
      if (terms.agreement.mode !== "ledger_coordinated") throw new FederationError("POLICY_DENIED");
      if (input.allowActivation || input.allowMarketPublish) {
        if (terms.agreement.sourceSiteId !== this.siteId)
          throw new FederationError("POLICY_DENIED");
        await requireFederationCapability(tx, actor, "market.publish");
      }

      if (input.allowMarketClaim) {
        if (terms.agreement.targetSiteId !== this.siteId)
          throw new FederationError("POLICY_DENIED");
        await requireFederationCapability(tx, actor, "market.claim");
      }

      await requireCoordinatedCommercialAgreement(
        tx,
        this.trust,
        this.siteId,
        actor.orgId,
        terms.agreement,
        this.clock,
      );
      const now = this.clock(),
        validUntil = new Date(input.validUntil);
      if (
        now < new Date(terms.agreement.validFrom) ||
        validUntil <= now ||
        validUntil > new Date(terms.agreement.validUntil)
      )
        throw new FederationError("AUTHORIZATION_EXPIRED");
      if (
        BigInt(input.maxTaskAmount) > BigInt(terms.agreement.maxTaskAmount) ||
        BigInt(input.maxTotalAmount) > BigInt(terms.agreement.budgetLimit) ||
        (terms.consideration === "charity" && input.maxTotalAmount !== "0")
      )
        throw new FederationError("POLICY_DENIED");
      const [saved] = await tx
        .insert(policies)
        .values({
          id: randomUUID(),
          localSiteId: this.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          agreementDigest: contract.digest,
          ...input,
          validFrom: now,
          validUntil,
          grantedBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.reservation_policy.grant",
        target: saved.id,
        diff: { after: saved },
      });
      return saved;
    });
  }

  async revoke(actor: FederationActor, revisionId: string, policyId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const [policy] = await tx
        .select()
        .from(policies)
        .where(
          and(
            eq(policies.id, policyId),
            eq(policies.localSiteId, this.siteId),
            eq(policies.localOrgId, actor.orgId),
            eq(policies.agreementRevisionId, revisionId),
          ),
        )
        .for("update");
      if (!policy) throw new FederationError("ASSET_UNAVAILABLE");
      if (policy.revokedAt) return policy;
      const [saved] = await tx
        .update(policies)
        .set({ revokedAt: this.clock(), revokedBy: actor.userId })
        .where(eq(policies.id, policyId))
        .returning();
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.reservation_policy.revoke",
        target: policyId,
        diff: { after: { revokedAt: saved?.revokedAt } },
      });
      return saved;
    });
  }

  /** Internal callers still need a committed local market intent and, at the provider, the source signature. */
  async authorize(
    tx: PgTransaction,
    policyId: string,
    orgId: string,
    payload: CommercialReservation,
  ) {
    const revisionId = payload.request.agreementRevisionId;
    const contract = await this.contract(tx, orgId, revisionId);
    const terms = CommercialAgreementSchema.parse(contract.terms);
    await requireCoordinatedCommercialAgreement(
      tx,
      this.trust,
      this.siteId,
      orgId,
      terms.agreement,
      this.clock,
    );
    const [policy] = await tx
      .select()
      .from(policies)
      .where(
        and(
          eq(policies.id, policyId),
          eq(policies.localSiteId, this.siteId),
          eq(policies.localOrgId, orgId),
          eq(policies.agreementRevisionId, revisionId),
          isNull(policies.revokedAt),
        ),
      )
      .for("update");
    if (!policy) throw new FederationError("POLICY_DENIED");
    assertReservationPolicyActive(policy, this.clock());
    if (
      policy.agreementDigest !== contract.digest ||
      payload.agreementDigest !== policy.agreementDigest ||
      BigInt(payload.request.maxAmount) > BigInt(policy.maxTaskAmount)
    )
      throw new FederationError("POLICY_DENIED");
    if (federationExecutionDeadline(payload.request) > policy.validUntil.getTime())
      throw new FederationError("AUTHORIZATION_EXPIRED");
    return policy;
  }

  async authorizeMarket(
    tx: PgTransaction,
    policyId: string,
    orgId: string,
    payload: CommercialReservation,
  ) {
    const policy = await this.authorize(tx, policyId, orgId, payload);
    const contract = await this.contract(tx, orgId, payload.request.agreementRevisionId);
    const terms = CommercialAgreementSchema.parse(contract.terms);
    const source = payload.request.senderSiteId === this.siteId;
    if (
      (source ? !policy.allowMarketPublish : !policy.allowMarketClaim) ||
      (!source && payload.request.recipientSiteId !== this.siteId) ||
      payload.domainId !== terms.domainId ||
      terms.agreement.mode !== "ledger_coordinated" ||
      (terms.consideration === "charity" && payload.request.maxAmount !== "0")
    )
      throw new FederationError("POLICY_DENIED");
    assertDelegationTerms(terms.agreement, payload.request, this.clock());
    return policy;
  }

  async authorizeOperation(
    tx: PgTransaction,
    policyId: string,
    recordId: string,
    operation: "activate" | "confirm",
  ) {
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.localSiteId, this.siteId),
          eq(approvals.recordId, recordId),
          eq(approvals.authorizationPolicyId, policyId),
        ),
      );
    if (!approval?.counterpartyJws || approval.payload.kind !== "commercial-reservation")
      throw new FederationError("POLICY_DENIED");
    if (approval.stopId) throw new FederationError("CANCELLATION_REQUESTED");
    const payload = CommercialReservationSchema.parse(approval.payload);
    const policy = await this.authorize(tx, policyId, approval.localOrgId, payload);
    if (
      operation === "activate"
        ? !policy.allowActivation || payload.request.senderSiteId !== this.siteId
        : !policy.allowExecutionConfirmation
    )
      throw new FederationError("POLICY_DENIED");
    return { policy, approval, payload };
  }

  async consume(tx: PgTransaction, policy: ReservationPolicy, payload: CommercialReservation) {
    // authorize holds the row lock through signature, counter update and audit commit.
    assertReservationPolicyActive(policy, this.clock());
    const amount = BigInt(policy.authorizedAmount) + BigInt(payload.request.maxAmount);
    if (policy.authorizedTasks >= policy.maxTasks || amount > BigInt(policy.maxTotalAmount))
      throw new FederationError("POLICY_DENIED");
    await tx
      .update(policies)
      .set({ authorizedTasks: policy.authorizedTasks + 1, authorizedAmount: amount.toString() })
      .where(eq(policies.id, policy.id));
  }
}
