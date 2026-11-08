import { randomUUID } from "node:crypto";
import {
  auditLog,
  federationWorkflowBindings as bindings,
  federationCommercialAgreements as contracts,
  federationOutbound as outbound,
  type PgDb,
  type PgTransaction,
  federationClosingPolicies as policies,
  federationReservations as reservations,
  workflowRuns,
} from "@kuintessence/db";
import {
  type FederationDelegation,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  ClosingPolicyInputSchema,
  CommercialAgreementSchema,
} from "@kuintessence/shared/federation/commercial";

export { ClosingPolicyInputSchema } from "@kuintessence/shared/federation/commercial";

import { and, desc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Policy = typeof policies.$inferSelect;
export function assertClosingPolicyActive(policy: Policy, now = new Date()) {
  if (policy.revokedAt || now < policy.validFrom || now >= policy.validUntil)
    throw new FederationError("AUTHORIZATION_EXPIRED");
}

export class FederationClosingPolicyService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
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
      )
      .for("share");
    if (!row?.counterpartyJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return row;
  }
  async list(actor: FederationActor, revisionId: string, limit = 20, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, actor.orgId, revisionId);
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
    raw: z.infer<typeof ClosingPolicyInputSchema>,
  ) {
    const input = ClosingPolicyInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(
        tx,
        actor,
        input.kind === "bill" ? "billing.approve" : "settlement.approve",
      );
      const contract = await this.contract(tx, actor.orgId, revisionId);
      const terms = CommercialAgreementSchema.parse(contract.terms);
      if (input.kind === "refund" && terms.agreement.mode === "ledger_coordinated")
        throw new FederationError("POLICY_DENIED");
      const now = new Date(),
        validUntil = new Date(input.validUntil);
      if (validUntil <= now) throw new FederationError("AUTHORIZATION_EXPIRED");
      if (
        BigInt(input.maxAmount) > BigInt(terms.agreement.maxTaskAmount) ||
        BigInt(input.maxTotalAmount) > BigInt(terms.agreement.budgetLimit)
      )
        throw new FederationError("POLICY_DENIED");
      const [row] = await tx
        .insert(policies)
        .values({
          ...input,
          id: randomUUID(),
          localSiteId: this.siteId,
          localOrgId: actor.orgId,
          agreementRevisionId: revisionId,
          agreementDigest: contract.digest,
          validFrom: now,
          validUntil,
          grantedBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.closing_policy.grant",
        target: row.id,
        diff: { after: row },
      });
      return row;
    });
  }
  async revoke(actor: FederationActor, revisionId: string, policyId: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
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
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      await requireFederationCapability(
        tx,
        actor,
        row.kind === "bill" ? "billing.approve" : "settlement.approve",
      );
      if (row.revokedAt) return row;
      const [saved] = await tx
        .update(policies)
        .set({ revokedAt: new Date(), revokedBy: actor.userId })
        .where(eq(policies.id, policyId))
        .returning();
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.closing_policy.revoke",
        target: policyId,
      });
      return saved;
    });
  }
  /** Locks institutional authority for the entire signing transaction, including quota consumption. */
  async authority(tx: PgTransaction, id: string, kind: Policy["kind"]) {
    const [policy] = await tx
      .select()
      .from(policies)
      .where(
        and(eq(policies.id, id), eq(policies.localSiteId, this.siteId), eq(policies.kind, kind)),
      )
      .for("update");
    if (!policy) throw new FederationError("POLICY_DENIED");
    assertClosingPolicyActive(policy);
    const contract = await this.contract(tx, policy.localOrgId, policy.agreementRevisionId);
    if (contract.digest !== policy.agreementDigest) throw new FederationError("OPERATION_CONFLICT");
    const terms = CommercialAgreementSchema.parse(contract.terms);
    const other =
      terms.agreement.sourceSiteId === this.siteId
        ? terms.agreement.targetSiteId
        : terms.agreement.sourceSiteId;
    for (const [siteId, jws] of [
      [this.siteId, contract.approvalJws],
      [other, contract.counterpartyJws],
    ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
      if (!siteId || !jws) throw new FederationError("INVALID_MESSAGE");
      const keyId = federationMessageKeyId(jws),
        now = new Date();
      await this.trust.assertKey(tx, siteId, keyId, now);
      const signed = await verifyFederationMessage(
        CommercialAgreementSchema,
        jws,
        await this.trust.resolveKey(siteId, keyId, now, tx),
        now,
      );
      if (signed.digest !== policy.agreementDigest) throw new FederationError("OPERATION_CONFLICT");
    }
    return policy;
  }
  async consume(tx: PgTransaction, policy: Policy, amount: string, request: FederationDelegation) {
    assertClosingPolicyActive(policy);
    let outcome: string | undefined;
    if (policy.kind === "refund") {
      // RefundService proves permanent pre-execution cancellation under the same transaction locks.
      if (request.mode === "ledger_coordinated") throw new FederationError("POLICY_DENIED");
      outcome = "cancelled";
    } else if (request.recipientSiteId === this.siteId) {
      const [row] = await tx
        .select({ request: bindings.snapshot, status: workflowRuns.status })
        .from(reservations)
        .innerJoin(bindings, eq(bindings.reservationId, reservations.id))
        .innerJoin(workflowRuns, eq(workflowRuns.id, bindings.workflowRunId))
        .where(
          and(
            eq(reservations.operationId, request.operationId),
            eq(reservations.senderSiteId, request.senderSiteId),
            eq(reservations.agreementRevisionId, policy.agreementRevisionId),
          ),
        );
      if (
        row &&
        row.request.identity.orgId === policy.localOrgId &&
        federationCanonicalJson(row.request.request) === federationCanonicalJson(request)
      )
        outcome = row.status;
    } else if (request.senderSiteId === this.siteId) {
      const [row] = await tx
        .select()
        .from(outbound)
        .where(
          and(
            eq(outbound.localSiteId, this.siteId),
            eq(outbound.operationId, request.operationId),
            eq(outbound.localOrgId, policy.localOrgId),
            eq(outbound.agreementRevisionId, policy.agreementRevisionId),
          ),
        );
      if (row && federationCanonicalJson(row.request) === federationCanonicalJson(request))
        outcome = row.statusReport?.workflow?.status;
    }
    if (!outcome || !policy.outcomes.some((v) => v === outcome))
      throw new FederationError("POLICY_DENIED");
    const next = BigInt(policy.approvedAmount) + BigInt(amount);
    if (
      BigInt(amount) > BigInt(policy.maxAmount) ||
      next > BigInt(policy.maxTotalAmount) ||
      policy.approvedRecords >= policy.maxRecords
    )
      throw new FederationError("BUDGET_EXHAUSTED");
    await tx
      .update(policies)
      .set({ approvedAmount: next.toString(), approvedRecords: policy.approvedRecords + 1 })
      .where(and(eq(policies.id, policy.id), isNull(policies.revokedAt)));
  }
}
