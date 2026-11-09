import { randomUUID } from "node:crypto";
import {
  auditLog,
  federationDisputes as cases,
  federationDisputeDeliveries as deliveries,
  type PgDb,
  type PgTransaction,
  federationSites as sites,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { CommercialDisputeReceiptSchema } from "@kuintessence/shared/federation/disputes";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { FederationDisputeService } from "./disputes";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Delivery = typeof deliveries.$inferSelect;
class DisputeLeaseLost extends Error {}

export class FederationDisputeDelivery {
  private readonly trust: FederationTrustRegistry;
  private readonly disputes: FederationDisputeService;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.disputes = new FederationDisputeService(db, signing);
  }
  private key(caseId: string) {
    return and(eq(deliveries.localSiteId, this.signing.siteId), eq(deliveries.caseId, caseId));
  }
  async discover() {
    if (!this.send) return;
    const rows = await this.db
      .select({ localSiteId: cases.localSiteId, caseId: cases.caseId })
      .from(cases)
      .leftJoin(
        deliveries,
        and(eq(deliveries.localSiteId, cases.localSiteId), eq(deliveries.caseId, cases.caseId)),
      )
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.state, "FREEZE_PENDING"),
          isNotNull(cases.openedBy),
          sql`${cases.payload}->>'openingSiteId' = ${this.signing.siteId}`,
          isNull(deliveries.caseId),
        ),
      )
      .orderBy(asc(cases.createdAt), asc(cases.caseId))
      .limit(8);
    if (rows.length) await this.db.insert(deliveries).values(rows).onConflictDoNothing();
  }
  private async lock(tx: PgTransaction, claim: Delivery) {
    if (!claim.leaseToken) throw new DisputeLeaseLost();
    const [row] = await tx
      .select()
      .from(deliveries)
      .where(
        and(
          this.key(claim.caseId),
          eq(deliveries.state, "pending"),
          eq(deliveries.leaseToken, claim.leaseToken),
          sql`${deliveries.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new DisputeLeaseLost();
  }
  private async source(tx: PgTransaction, caseId: string, endpoint?: string) {
    const record = await this.disputes.deliveryOriginal(tx, caseId);
    const [peer] = await tx.select().from(sites).where(eq(sites.id, record.other)).for("share");
    if (peer?.state !== "active" || (endpoint && endpoint !== peer.endpoint))
      throw new FederationError("UNTRUSTED_IDENTITY");
    return { ...record, endpoint: peer.endpoint };
  }
  private async advance(claim: Delivery) {
    if (!this.send) return;
    const scope = await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      return this.source(tx, claim.caseId);
    });
    const response = await this.send(scope.endpoint, scope.openingJws, "/federation/v1/disputes");
    await this.db.transaction(async (tx) => {
      await this.lock(tx, claim);
      const current = await this.source(tx, claim.caseId, scope.endpoint);
      if (
        current.digest !== scope.digest ||
        current.openingJws !== scope.openingJws ||
        current.localOrgId !== scope.localOrgId
      )
        throw new FederationError("OPERATION_CONFLICT");
      const kid = federationMessageKeyId(response);
      await this.trust.assertKey(tx, scope.other, kid, new Date());
      const key = await this.trust.resolveKey(scope.other, kid, new Date(), tx);
      const { payload: receipt } = await verifyFederationMessage(
        CommercialDisputeReceiptSchema,
        response,
        key,
        new Date(),
      );
      if (
        receipt.caseId !== claim.caseId ||
        receipt.caseDigest !== scope.digest ||
        receipt.openingSiteId !== this.signing.siteId ||
        receipt.receivingSiteId !== scope.other ||
        Date.parse(receipt.recordedAt) < Date.parse(scope.payload.issuedAt) ||
        Date.parse(receipt.recordedAt) > Date.now() + 60000
      )
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(deliveries)
        .set({
          state: "received",
          receiptJws: response,
          acknowledgedAt: new Date(),
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(this.key(claim.caseId));
      await tx.insert(auditLog).values({
        actor: `dispute-delivery:${this.signing.siteId}`,
        orgId: scope.localOrgId,
        action: "federation.dispute.delivered",
        target: claim.caseId,
        diff: { after: { digest: scope.digest, receivingSiteId: scope.other } },
      });
    });
  }
  async advanceNext() {
    if (!this.send) return false;
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.localSiteId, this.signing.siteId),
            eq(deliveries.state, "pending"),
            sql`${deliveries.nextAttemptAt} <= clock_timestamp()`,
            sql`(${deliveries.leaseUntil} IS NULL OR ${deliveries.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(deliveries.nextAttemptAt), asc(deliveries.caseId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [saved] = await tx
        .update(deliveries)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(row.caseId))
        .returning();
      return saved;
    });
    if (!claim) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof DisputeLeaseLost || !claim.leaseToken) return true;
      const review =
        (error instanceof FederationError && error.code !== "DATA_WAITING") ||
        error instanceof z.ZodError ||
        (error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE");
      await this.db
        .update(deliveries)
        .set({
          state: review ? "needs_review" : "pending",
          lastError:
            error instanceof FederationError || error instanceof FederationDeliveryError
              ? error.code
              : error instanceof z.ZodError
                ? "INVALID_MESSAGE"
                : "DELIVERY_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim.caseId),
            eq(deliveries.state, "pending"),
            eq(deliveries.leaseToken, claim.leaseToken),
            sql`${deliveries.leaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }
  private async authorize(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    caseId: string,
    capability: "dispute.read" | "dispute.open",
  ) {
    await requireFederationCapability(tx, actor, capability);
    const [record] = await tx
      .select({ openedBy: cases.openedBy })
      .from(cases)
      .where(
        and(
          eq(cases.localSiteId, this.signing.siteId),
          eq(cases.caseId, caseId),
          eq(cases.localOrgId, actor.orgId),
          eq(cases.agreementRevisionId, revisionId),
        ),
      );
    if (!record?.openedBy) throw new FederationError("POLICY_DENIED");
  }
  async status(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, revisionId, caseId, "dispute.read");
      const [sync] = await tx
        .select({
          state: deliveries.state,
          lastError: deliveries.lastError,
          nextAttemptAt: deliveries.nextAttemptAt,
          acknowledgedAt: deliveries.acknowledgedAt,
        })
        .from(deliveries)
        .where(this.key(caseId));
      return { enabled: !!this.send, sync: sync ?? null };
    });
  }
  async retry(actor: FederationActor, revisionId: string, caseId: string) {
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, revisionId, caseId, "dispute.open");
      const [row] = await tx.select().from(deliveries).where(this.key(caseId)).for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      if (row.state === "received" || (row.leaseUntil && row.leaseUntil > new Date()))
        throw new FederationError("OPERATION_CONFLICT");
      await this.source(tx, caseId);
      await tx
        .update(deliveries)
        .set({
          state: "pending",
          lastError: null,
          nextAttemptAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        })
        .where(this.key(caseId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.dispute.delivery_retry",
        target: caseId,
      });
    });
  }
}
