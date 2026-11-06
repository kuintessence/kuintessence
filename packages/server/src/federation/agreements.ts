import {
  auditLog,
  federationAgreementApprovals,
  federationAgreements,
  federationPreparations,
  federationReservations,
  type PgDb,
} from "@kuintessence/db";
import {
  type FederationAgreement,
  FederationAgreementSchema,
  FederationError,
} from "@kuintessence/shared/federation";
import { and, desc, eq } from "drizzle-orm";
import { FederationAdmission } from "./admission";
import { requireExecutionIdentity } from "./execution-identity";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";

type Approval = typeof federationAgreementApprovals.$inferSelect;

/** Human authorization and institutional signature are independent checks. */
export class FederationAgreementService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async list(actor: FederationActor, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      return tx
        .select()
        .from(federationAgreementApprovals)
        .where(
          and(
            eq(federationAgreementApprovals.localSiteId, this.signingKey.siteId),
            eq(federationAgreementApprovals.localOrgId, actor.orgId),
          ),
        )
        .orderBy(
          desc(federationAgreementApprovals.createdAt),
          desc(federationAgreementApprovals.revisionId),
        )
        .limit(limit)
        .offset(offset);
    });
  }

  async listReservations(actor: FederationActor, revisionId: string, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const [agreement] = await tx
        .select({ id: federationAgreements.revisionId })
        .from(federationAgreements)
        .where(
          and(
            eq(federationAgreements.revisionId, revisionId),
            eq(federationAgreements.localOrgId, actor.orgId),
            eq(federationAgreements.targetSiteId, this.signingKey.siteId),
          ),
        );
      if (!agreement) throw new FederationError("AGREEMENT_UNAVAILABLE");
      return tx
        .select({
          id: federationReservations.id,
          taskId: federationReservations.taskId,
          attempt: federationReservations.attempt,
          receiptState: federationReservations.state,
          reservedAmount: federationReservations.amount,
          createdAt: federationReservations.createdAt,
          preparation: {
            state: federationPreparations.state,
            blocker: federationPreparations.blocker,
            updatedAt: federationPreparations.updatedAt,
          },
        })
        .from(federationReservations)
        .leftJoin(
          federationPreparations,
          eq(federationPreparations.reservationId, federationReservations.id),
        )
        .where(eq(federationReservations.agreementRevisionId, revisionId))
        .orderBy(desc(federationReservations.createdAt), desc(federationReservations.id))
        .limit(limit)
        .offset(offset);
    });
  }

  async get(actor: FederationActor, revisionId: string): Promise<Approval> {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      return this.localApproval(tx, actor, revisionId);
    });
  }

  async approve(
    actor: FederationActor,
    input: { terms: FederationAgreement; executionUserId?: string },
  ) {
    const terms = FederationAgreementSchema.parse(input.terms);
    const local = this.signingKey.siteId;
    if (terms.sourceSiteId !== local && terms.targetSiteId !== local)
      throw new FederationError("POLICY_DENIED");
    if (terms.mode === "ledger_coordinated") throw new FederationError("LEDGER_REQUIRED");
    if ((terms.targetSiteId === local) !== Boolean(input.executionUserId))
      throw new FederationError("POLICY_DENIED");
    // Check the business grant before using a machine's institutional signing key.
    await this.db.transaction((tx) => requireFederationCapability(tx, actor, "agreement.approve"));
    const now = this.clock();
    this.requireUnexpired(terms, now);
    const key = await this.trust.resolveKey(local, this.signingKey.keyId, now);
    if (!key.allowedKinds.includes("agreement")) throw new FederationError("UNTRUSTED_IDENTITY");
    const jws = await signFederationMessage(FederationAgreementSchema, terms, this.signingKey);
    const verified = await verifyFederationMessage(FederationAgreementSchema, jws, key, now);
    return this.db.transaction(async (tx) => {
      await this.trust.assertKey(tx, local, key.keyId, this.clock());
      await requireFederationCapability(tx, actor, "agreement.approve");
      if (input.executionUserId)
        await requireExecutionIdentity(tx, { orgId: actor.orgId, userId: input.executionUserId });
      await this.trust.assertKey(tx, local, key.keyId, this.clock());
      this.requireUnexpired(terms, this.clock());
      const [created] = await tx
        .insert(federationAgreementApprovals)
        .values({
          localSiteId: local,
          revisionId: terms.agreementRevisionId,
          localOrgId: actor.orgId,
          executionUserId: input.executionUserId ?? null,
          terms,
          termsDigest: verified.digest,
          approvalJws: jws,
          approvedBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const existing = await this.localApproval(tx, actor, terms.agreementRevisionId);
        if (
          existing.termsDigest !== verified.digest ||
          existing.executionUserId !== (input.executionUserId ?? null)
        )
          throw new FederationError("OPERATION_CONFLICT");
        if (existing.state !== "active") throw new FederationError("AGREEMENT_UNAVAILABLE");
        return existing;
      }
      await this.audit(tx, actor, "approve", terms.agreementRevisionId, {
        termsDigest: verified.digest,
      });
      return created;
    });
  }

  /** Attaches the other institution's signature; the receiving site activates its budget atomically. */
  async attachCounterparty(
    actor: FederationActor,
    revisionId: string,
    counterpartyApprovalJws: string,
  ) {
    const local = await this.get(actor, revisionId);
    const terms = FederationAgreementSchema.parse(local.terms);
    const otherSite =
      terms.sourceSiteId === this.signingKey.siteId ? terms.targetSiteId : terms.sourceSiteId;
    const now = this.clock();
    const ownKey = await this.trust.resolveKey(
      this.signingKey.siteId,
      federationMessageKeyId(local.approvalJws),
      now,
    );
    const otherKey = await this.trust.resolveKey(
      otherSite,
      federationMessageKeyId(counterpartyApprovalJws),
      now,
    );
    const verified = await verifyFederationMessage(
      FederationAgreementSchema,
      counterpartyApprovalJws,
      otherKey,
      now,
    );
    if (verified.digest !== local.termsDigest) throw new FederationError("OPERATION_CONFLICT");
    const authorize = async (tx: FederationTransaction) => {
      for (const key of [ownKey, otherKey].sort((a, b) => a.siteId.localeCompare(b.siteId)))
        await this.trust.assertKey(tx, key.siteId, key.keyId, this.clock());
      await requireFederationCapability(tx, actor, "agreement.approve");
      const current = await this.localApproval(tx, actor, revisionId);
      if (current.state !== "active") throw new FederationError("AGREEMENT_UNAVAILABLE");
      for (const key of [ownKey, otherKey])
        await this.trust.assertKey(tx, key.siteId, key.keyId, this.clock());
      this.requireUnexpired(terms, this.clock());
      if (current.counterpartyApprovalJws) {
        // Same terms signed by a new key do not silently replace the original approval evidence.
        if (current.counterpartyApprovalJws !== counterpartyApprovalJws)
          throw new FederationError("OPERATION_CONFLICT");
        return;
      }
      await tx
        .update(federationAgreementApprovals)
        .set({ counterpartyApprovalJws })
        .where(this.key(revisionId));
      await this.audit(tx, actor, "activate", revisionId, { termsDigest: local.termsDigest });
    };
    if (terms.targetSiteId === this.signingKey.siteId) {
      if (!local.executionUserId) throw new FederationError("POLICY_DENIED");
      const receiptKey = await this.trust.resolveKey(
        this.signingKey.siteId,
        this.signingKey.keyId,
        now,
      );
      await new FederationAdmission(
        this.db,
        this.signingKey,
        receiptKey,
        this.clock,
      ).installApprovedAgreement({
        sourceApprovalJws: counterpartyApprovalJws,
        targetApprovalJws: local.approvalJws,
        sourceKey: otherKey,
        targetKey: ownKey,
        identity: { orgId: local.localOrgId, userId: local.executionUserId },
        authorize,
      });
    } else {
      // Source-side signatures are verified too, even though this site never creates the recipient's budget.
      await verifyFederationMessage(FederationAgreementSchema, local.approvalJws, ownKey, now);
      await this.db.transaction(authorize);
    }
    return this.get(actor, revisionId);
  }

  async setState(
    actor: FederationActor,
    revisionId: string,
    state: "active" | "suspended" | "revoked",
  ) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const approval = await this.localApproval(tx, actor, revisionId);
      if (approval.state === "revoked" && state !== "revoked")
        throw new FederationError("AGREEMENT_UNAVAILABLE");
      if (state === "active") this.requireUnexpired(approval.terms, this.clock());
      await tx.update(federationAgreementApprovals).set({ state }).where(this.key(revisionId));
      if (approval.terms.targetSiteId === this.signingKey.siteId)
        await tx
          .update(federationAgreements)
          .set({ state })
          .where(
            and(
              eq(federationAgreements.revisionId, revisionId),
              eq(federationAgreements.localOrgId, actor.orgId),
              eq(federationAgreements.targetSiteId, this.signingKey.siteId),
            ),
          );
      await this.audit(tx, actor, "state", revisionId, { state });
    });
  }

  private key(revisionId: string) {
    return and(
      eq(federationAgreementApprovals.localSiteId, this.signingKey.siteId),
      eq(federationAgreementApprovals.revisionId, revisionId),
    );
  }

  private async localApproval(
    tx: FederationTransaction,
    actor: FederationActor,
    revisionId: string,
  ) {
    const [row] = await tx
      .select()
      .from(federationAgreementApprovals)
      .where(and(this.key(revisionId), eq(federationAgreementApprovals.localOrgId, actor.orgId)))
      .for("update");
    if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return row;
  }

  private requireUnexpired(terms: FederationAgreement, now: Date) {
    if (Date.parse(terms.validUntil) <= now.getTime())
      throw new FederationError("AUTHORIZATION_EXPIRED");
  }

  private async audit(
    tx: FederationTransaction,
    actor: FederationActor,
    action: string,
    revisionId: string,
    after: unknown,
  ) {
    await tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: `federation.agreement.${action}`,
      target: revisionId,
      diff: { after },
    });
  }
}
