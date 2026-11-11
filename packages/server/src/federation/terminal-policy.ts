import { randomUUID } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  auditLog,
  federationCommercialAgreements as contracts,
  type PgDb,
  type PgTransaction,
  federationTerminalPolicies as policies,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  TerminalPolicyInputSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { type FederationActor, requireFederationCapability } from "./permissions";

export { TerminalPolicyInputSchema } from "@kuintessence/shared/federation/commercial";

export function assertTerminalPolicyActive(
  policy: typeof policies.$inferSelect,
  now: Date,
  outcome?: "completed" | "failed" | "cancelled",
) {
  if (policy.revokedAt || now < policy.validFrom || now >= policy.validUntil)
    throw new FederationError("AUTHORIZATION_EXPIRED");
  if (outcome && !policy.outcomes.includes(outcome)) throw new FederationError("POLICY_DENIED");
}

/** The grant belongs to the institution, not the worker or a remembered human session. */
export class FederationTerminalPolicyService {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async contract(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [row] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.siteId),
          eq(contracts.localOrgId, actor.orgId),
          eq(contracts.revisionId, revisionId),
        ),
      )
      .for("share");
    if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
    const terms = CommercialAgreementSchema.parse(row.terms);
    if (!row.counterpartyJws || terms.agreement.mode !== "ledger_coordinated")
      throw new FederationError("POLICY_DENIED");
    return row;
  }

  async list(actor: FederationActor, revisionId: string, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor, revisionId);
      return tx
        .select()
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
    raw: z.infer<typeof TerminalPolicyInputSchema>,
  ) {
    const input = TerminalPolicyInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const contract = await this.contract(tx, actor, revisionId);
      const now = this.clock(),
        validUntil = new Date(input.validUntil);
      if (validUntil <= now) throw new FederationError("AUTHORIZATION_EXPIRED");
      const [saved] = await tx
        .insert(policies)
        .values({
          id: randomUUID(),
          localSiteId: this.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          agreementDigest: contract.digest,
          outcomes: input.outcomes,
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
        action: "federation.terminal_policy.grant",
        target: saved.id,
        diff: { after: saved },
      });
      return saved;
    });
  }

  async revoke(actor: FederationActor, revisionId: string, policyId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      await this.contract(tx, actor, revisionId);
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
        action: "federation.terminal_policy.revoke",
        target: policyId,
        diff: { after: { revokedAt: saved?.revokedAt } },
      });
      return saved;
    });
  }

  async retry(actor: FederationActor, revisionId: string, reservationId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const contract = await this.contract(tx, actor, revisionId);
      const [policy] = await tx
        .select()
        .from(policies)
        .where(
          and(
            eq(policies.localSiteId, this.siteId),
            eq(policies.agreementRevisionId, revisionId),
            eq(policies.localOrgId, actor.orgId),
            isNull(policies.revokedAt),
          ),
        )
        .for("share");
      if (!policy || policy.agreementDigest !== contract.digest)
        throw new FederationError("POLICY_DENIED");
      assertTerminalPolicyActive(policy, this.clock());
      const [approval] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.localSiteId, this.siteId),
            eq(approvals.recordId, reservationId),
            eq(approvals.localOrgId, actor.orgId),
            eq(approvals.agreementRevisionId, revisionId),
          ),
        )
        .for("update");
      if (!approval || approval.payload.kind !== "commercial-reservation")
        throw new FederationError("ASSET_UNAVAILABLE");
      const [terminal] = await tx
        .select()
        .from(terminals)
        .where(
          and(eq(terminals.localSiteId, this.siteId), eq(terminals.reservationId, reservationId)),
        );
      if (terminal) throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(approvals)
        .set({
          terminalAutoState: "pending",
          terminalAutoError: null,
          terminalAutoNextAt: this.clock(),
        })
        .where(and(eq(approvals.localSiteId, this.siteId), eq(approvals.recordId, reservationId)));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.terminal_policy.retry",
        target: reservationId,
        diff: { after: { policyId: policy.id } },
      });
    });
  }
}
