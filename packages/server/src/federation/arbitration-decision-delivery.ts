import { randomUUID } from "node:crypto";
import {
  auditLog,
  federationDisputes as cases,
  federationArbitrationDecisionDeliveries as deliveries,
  federationArbitrationDecisions as originals,
  type PgDb,
  type PgTransaction,
  federationReceivedArbitrationDecisions as received,
  federationSites as sites,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  ArbitrationDecisionBasisSchema,
  ArbitrationDecisionSchema,
} from "@kuintessence/shared/federation/arbitration-decision";
import {
  ArbitrationDecisionDeliverySchema,
  ArbitrationDecisionReceiptSchema,
  arbitrationDecisionDeliveryPayload,
} from "@kuintessence/shared/federation/arbitration-decision-delivery";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  verifyArbitrationHistory,
  verifyReceivedArbitrationDecision,
} from "./arbitration-decision-history";
import { federationMaterialDigest } from "./assets";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Delivery = typeof deliveries.$inferSelect;
class LeaseLost extends Error {}
export class FederationArbitrationDecisionDelivery {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(row: Pick<Delivery, "decisionId" | "receivingSiteId">) {
    return and(
      eq(deliveries.localSiteId, this.signing.siteId),
      eq(deliveries.decisionId, row.decisionId),
      eq(deliveries.receivingSiteId, row.receivingSiteId),
    );
  }
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const signed = await verifyFederationMessage(
        ArbitrationDecisionDeliverySchema,
        jws,
        peer,
        new Date(),
      ),
      value = signed.payload;
    if (value.issuerSiteId !== peer.siteId || value.receivingSiteId !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    if (Math.abs(Date.now() - Date.parse(value.issuedAt)) > 60000)
      throw new FederationError("AUTHORIZATION_EXPIRED");
    return this.db.transaction(async (tx) => {
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`arbitration-decision-receive:${this.signing.siteId}:${value.caseId}`},0))`,
      );
      const [prior] = await tx
        .select()
        .from(received)
        .where(
          and(eq(received.localSiteId, this.signing.siteId), eq(received.caseId, value.caseId)),
        )
        .for("share");
      if (
        prior &&
        federationCanonicalJson({ ...prior.payload, issuedAt: "" }) !==
          federationCanonicalJson({ ...value, issuedAt: "" })
      )
        throw new FederationError("OPERATION_CONFLICT");
      const localOrgId =
        prior?.localOrgId ??
        (await verifyReceivedArbitrationDecision(tx, value, this.signing.siteId)).localOrgId;
      const receipt =
        prior?.receipt ??
        ArbitrationDecisionReceiptSchema.parse({
          protocolVersion: 1,
          kind: "arbitration-decision-receipt",
          deliveryId: value.deliveryId,
          issuerSiteId: value.issuerSiteId,
          receivingSiteId: this.signing.siteId,
          decisionId: value.decisionId,
          caseId: value.caseId,
          decisionDigest: value.decisionDigest,
          recordedAt: new Date().toISOString(),
        });
      // The receipt statement is immutable; its current transport signature can survive key rotation.
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
      const response = await signFederationMessage(
        ArbitrationDecisionReceiptSchema,
        receipt,
        this.signing,
      );
      await verifyFederationMessage(
        ArbitrationDecisionReceiptSchema,
        response,
        await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date(), tx),
        new Date(),
      );
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
      await verifyFederationMessage(
        ArbitrationDecisionDeliverySchema,
        jws,
        await this.trust.resolveKey(peer.siteId, peer.keyId, new Date(), tx),
        new Date(),
      );
      if (Math.abs(Date.now() - Date.parse(value.issuedAt)) > 60000)
        throw new FederationError("AUTHORIZATION_EXPIRED");
      if (!prior) {
        const [saved] = await tx
          .insert(received)
          .values({
            localSiteId: this.signing.siteId,
            decisionId: value.decisionId,
            caseId: value.caseId,
            localOrgId,
            payload: value,
            deliveryJws: jws,
            receipt,
          })
          .onConflictDoNothing()
          .returning();
        if (!saved) throw new FederationError("OPERATION_CONFLICT");
        await tx.insert(auditLog).values({
          actor: `arbitration-decision:${this.signing.siteId}`,
          orgId: localOrgId,
          action: "federation.arbitration_decision.receive",
          target: value.decisionId,
          diff: {
            after: {
              caseId: value.caseId,
              digest: value.decisionDigest,
              issuerSiteId: value.issuerSiteId,
            },
          },
        });
      }
      return response;
    });
  }
  async discover() {
    if (!this.send) return;
    for (const member of ["sourceSiteId", "targetSiteId"] as const) {
      const target = sql<string>`${originals.payload}->'intent'->'binding'->>${member}`;
      const pending = await this.db
        .select({ decisionId: originals.decisionId, receivingSiteId: target })
        .from(originals)
        .leftJoin(
          deliveries,
          and(
            eq(deliveries.localSiteId, originals.localSiteId),
            eq(deliveries.decisionId, originals.decisionId),
            sql`${deliveries.receivingSiteId}::text = ${target}`,
          ),
        )
        .where(and(eq(originals.localSiteId, this.signing.siteId), isNull(deliveries.decisionId)))
        .orderBy(asc(originals.approvedAt), asc(originals.decisionId))
        .limit(8);
      if (pending.length)
        await this.db
          .insert(deliveries)
          .values(
            pending.map((row) => ({
              ...row,
              localSiteId: this.signing.siteId,
              deliveryId: randomUUID(),
            })),
          )
          .onConflictDoNothing();
    }
  }
  private async lock(tx: PgTransaction, claim: Delivery) {
    if (!claim.leaseToken) throw new LeaseLost();
    const [row] = await tx
      .select()
      .from(deliveries)
      .where(
        and(
          this.key(claim),
          eq(deliveries.state, "pending"),
          eq(deliveries.leaseToken, claim.leaseToken),
          sql`${deliveries.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new LeaseLost();
    return row;
  }
  private async source(tx: PgTransaction, claim: Delivery, endpoint?: string) {
    await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
    const [record] = await tx
      .select()
      .from(originals)
      .where(
        and(
          eq(originals.localSiteId, this.signing.siteId),
          eq(originals.decisionId, claim.decisionId),
        ),
      )
      .for("share");
    if (!record) throw new FederationError("POLICY_DENIED");
    const original = await verifyArbitrationHistory(
      tx,
      ArbitrationDecisionSchema,
      record.approvalJws,
      this.signing.siteId,
      new Date(record.payload.issuedAt),
    );
    if (
      original.digest !== record.digest ||
      federationCanonicalJson(original.payload) !== federationCanonicalJson(record.payload) ||
      federationMaterialDigest(ArbitrationDecisionBasisSchema.parse(record.basis)) !==
        record.payload.basisDigest
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [peer] = await tx
      .select()
      .from(sites)
      .where(eq(sites.id, claim.receivingSiteId))
      .for("share");
    if (peer?.state !== "active" || (endpoint && endpoint !== peer.endpoint))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const value = arbitrationDecisionDeliveryPayload(
      record,
      claim.deliveryId,
      claim.receivingSiteId,
      new Date().toISOString(),
    );
    const jws = await signFederationMessage(ArbitrationDecisionDeliverySchema, value, this.signing);
    await verifyFederationMessage(
      ArbitrationDecisionDeliverySchema,
      jws,
      await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date(), tx),
      new Date(),
    );
    return { record, value, jws, endpoint: peer.endpoint };
  }
  private async advance(claim: Delivery) {
    if (!this.send) return;
    const source = await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim);
      return this.source(tx, row);
    });
    const response = await this.send(
      source.endpoint,
      source.jws,
      "/federation/v1/arbitration-decisions",
    );
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim),
        current = await this.source(tx, row, source.endpoint);
      if (
        current.record.digest !== source.record.digest ||
        current.record.approvalJws !== source.record.approvalJws
      )
        throw new FederationError("OPERATION_CONFLICT");
      const kid = federationMessageKeyId(response);
      await this.trust.assertKey(tx, claim.receivingSiteId, kid, new Date());
      const { payload: receipt } = await verifyFederationMessage(
        ArbitrationDecisionReceiptSchema,
        response,
        await this.trust.resolveKey(claim.receivingSiteId, kid, new Date(), tx),
        new Date(),
      );
      if (
        receipt.deliveryId !== claim.deliveryId ||
        receipt.decisionId !== claim.decisionId ||
        receipt.caseId !== source.record.caseId ||
        receipt.decisionDigest !== source.record.digest ||
        receipt.issuerSiteId !== this.signing.siteId ||
        receipt.receivingSiteId !== claim.receivingSiteId ||
        Date.parse(receipt.recordedAt) < Date.parse(source.record.payload.issuedAt) - 60000 ||
        Date.parse(receipt.recordedAt) > Date.now() + 60000
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.lock(tx, claim);
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
        .where(this.key(claim));
      await tx.insert(auditLog).values({
        actor: `arbitration-decision:${this.signing.siteId}`,
        orgId: source.record.localOrgId,
        action: "federation.arbitration_decision.delivered",
        target: claim.decisionId,
        diff: { after: { receivingSiteId: claim.receivingSiteId, deliveryId: claim.deliveryId } },
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
        .orderBy(
          asc(deliveries.nextAttemptAt),
          asc(deliveries.decisionId),
          asc(deliveries.receivingSiteId),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return;
      return (
        await tx
          .update(deliveries)
          .set({
            leaseToken: randomUUID(),
            leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
          })
          .where(this.key(row))
          .returning()
      )[0];
    });
    if (!claim) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof LeaseLost || !claim.leaseToken) return true;
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
                : "DECISION_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim),
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
    caseId: string,
    retry = false,
  ) {
    await requireFederationCapability(tx, actor, "arbitration.read");
    if (retry) await requireFederationCapability(tx, actor, "arbitration.decide");
    const [row] = await tx
      .select()
      .from(originals)
      .where(
        and(
          eq(originals.localSiteId, this.signing.siteId),
          eq(originals.localOrgId, actor.orgId),
          eq(originals.caseId, caseId),
        ),
      )
      .for("share");
    if (!row) throw new FederationError("POLICY_DENIED");
    return row;
  }
  async status(actor: FederationActor, caseId: string) {
    return this.db.transaction(async (tx) => {
      const record = await this.authorize(tx, actor, caseId);
      const data = await tx
        .select({
          receivingSiteId: deliveries.receivingSiteId,
          deliveryId: deliveries.deliveryId,
          state: deliveries.state,
          lastError: deliveries.lastError,
          acknowledgedAt: deliveries.acknowledgedAt,
        })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.localSiteId, this.signing.siteId),
            eq(deliveries.decisionId, record.decisionId),
          ),
        )
        .orderBy(asc(deliveries.receivingSiteId));
      return { enabled: !!this.send, data };
    });
  }
  async retry(actor: FederationActor, caseId: string, receivingSiteId: string) {
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    await this.db.transaction(async (tx) => {
      const original = await this.authorize(tx, actor, caseId, true);
      const [row] = await tx
        .select()
        .from(deliveries)
        .where(this.key({ decisionId: original.decisionId, receivingSiteId }))
        .for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      const [valid] = await tx
        .select({
          ok: sql<boolean>`(${deliveries.leaseUntil} IS NULL OR ${deliveries.leaseUntil} <= clock_timestamp())`,
        })
        .from(deliveries)
        .where(this.key(row));
      if (row.state === "received" || !valid?.ok) throw new FederationError("OPERATION_CONFLICT");
      await this.source(tx, row);
      await tx
        .update(deliveries)
        .set({
          state: "pending",
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp()`,
        })
        .where(this.key(row));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.arbitration_decision.retry",
        target: original.decisionId,
        diff: { after: { receivingSiteId } },
      });
    });
  }
  async receivedDecision(actor: FederationActor, revisionId: string, caseId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "dispute.read");
      await requireFederationCapability(tx, actor, "arbitration.approve");
      const [record] = await tx
        .select()
        .from(cases)
        .where(
          and(
            eq(cases.localSiteId, this.signing.siteId),
            eq(cases.localOrgId, actor.orgId),
            eq(cases.agreementRevisionId, revisionId),
            eq(cases.caseId, caseId),
          ),
        )
        .for("share");
      if (!record) throw new FederationError("POLICY_DENIED");
      const [row] = await tx
        .select()
        .from(received)
        .where(
          and(
            eq(received.localSiteId, this.signing.siteId),
            eq(received.caseId, caseId),
            eq(received.localOrgId, actor.orgId),
          ),
        );
      return row
        ? {
            payload: row.payload.decision,
            digest: row.payload.decisionDigest,
            receivedAt: row.receivedAt.toISOString(),
          }
        : null;
    });
  }
}
