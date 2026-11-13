import { randomUUID } from "node:crypto";
import {
  auditLog,
  federationCaseRevocationDeliveries as deliveries,
  federationCaseRevocationNotices as notices,
  type PgDb,
  type PgTransaction,
  federationCasePublications as publications,
  federationSites as sites,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  CaseRevocationNoticeSchema,
  CaseRevocationReceiptSchema,
} from "@kuintessence/shared/federation/case-revocation";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { FederationCasePublicationService } from "./case-publications";
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
export class FederationCaseRevocationDelivery {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly cases: FederationCasePublicationService,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private key(row: Pick<Delivery, "publicationId" | "receivingSiteId">) {
    return and(
      eq(deliveries.localSiteId, this.signing.siteId),
      eq(deliveries.publicationId, row.publicationId),
      eq(deliveries.receivingSiteId, row.receivingSiteId),
    );
  }
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const signed = await verifyFederationMessage(CaseRevocationNoticeSchema, jws, peer, new Date()),
      value = signed.payload;
    if (value.issuerSiteId !== peer.siteId || value.receivingSiteId !== this.signing.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    return this.db.transaction(async (tx) => {
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
      const withdrawal = await this.cases.verifyWithdrawal(tx, value);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`case-publication:${this.signing.siteId}:${value.publication.publicationId}`}, 0))`,
      );
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
      await verifyFederationMessage(
        CaseRevocationNoticeSchema,
        jws,
        await this.trust.resolveKey(peer.siteId, peer.keyId, new Date(), tx),
        new Date(),
      );
      await this.cases.verifyWithdrawal(tx, value);
      const existing = await tx
        .select()
        .from(notices)
        .where(
          and(
            eq(notices.localSiteId, this.signing.siteId),
            eq(notices.publicationId, value.publication.publicationId),
          ),
        );
      if (existing.some((row) => row.publicationDigest !== withdrawal.payload.publicationDigest))
        throw new FederationError("OPERATION_CONFLICT");
      const prior = existing.find((row) => row.issuerSiteId === value.issuerSiteId);
      if (prior) {
        if (
          prior.noticeDigest !== signed.digest ||
          prior.noticeJws !== jws ||
          prior.revocationDigest !== withdrawal.digest
        )
          throw new FederationError("OPERATION_CONFLICT");
        return prior.receiptJws;
      }
      const [local] = await tx
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.localSiteId, this.signing.siteId),
            eq(publications.publicationId, value.publication.publicationId),
          ),
        );
      if (
        local &&
        (local.digest !== withdrawal.payload.publicationDigest ||
          federationCanonicalJson(local.payload) !== federationCanonicalJson(value.publication))
      )
        throw new FederationError("OPERATION_CONFLICT");
      const receipt = CaseRevocationReceiptSchema.parse({
        protocolVersion: 1,
        kind: "case-revocation-receipt",
        noticeId: value.noticeId,
        noticeDigest: signed.digest,
        publicationId: value.publication.publicationId,
        publicationDigest: withdrawal.payload.publicationDigest,
        revocationId: withdrawal.payload.revocationId,
        revocationDigest: withdrawal.digest,
        issuerSiteId: value.issuerSiteId,
        receivingSiteId: this.signing.siteId,
        recordedAt: new Date().toISOString(),
      });
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
      const response = await signFederationMessage(
        CaseRevocationReceiptSchema,
        receipt,
        this.signing,
      );
      await verifyFederationMessage(
        CaseRevocationReceiptSchema,
        response,
        await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date(), tx),
        new Date(),
      );
      await tx.insert(notices).values({
        localSiteId: this.signing.siteId,
        publicationId: receipt.publicationId,
        issuerSiteId: value.issuerSiteId,
        noticeId: value.noticeId,
        publicationDigest: receipt.publicationDigest,
        noticeDigest: signed.digest,
        revocationDigest: withdrawal.digest,
        payload: value,
        noticeJws: jws,
        receiptJws: response,
      });
      await tx.insert(auditLog).values({
        actor: `case-revocation:${this.signing.siteId}`,
        orgId: local?.localOrgId,
        action: "federation.case_revocation.receive",
        target: receipt.publicationId,
        diff: {
          after: {
            issuerSiteId: value.issuerSiteId,
            noticeId: value.noticeId,
            revocationDigest: withdrawal.digest,
          },
        },
      });
      return response;
    });
  }
  async discover() {
    if (!this.send) return;
    for (const member of ["sourceSiteId", "targetSiteId", "evidenceRecipientSiteId"] as const) {
      const target = sql<string>`${publications.payload}->'scope'->>${member}`;
      const pending = await this.db
        .select({ publicationId: publications.publicationId, receivingSiteId: target })
        .from(publications)
        .leftJoin(
          deliveries,
          and(
            eq(deliveries.localSiteId, publications.localSiteId),
            eq(deliveries.publicationId, publications.publicationId),
            sql`${deliveries.receivingSiteId}::text = ${target}`,
          ),
        )
        .where(
          and(
            eq(publications.localSiteId, this.signing.siteId),
            sql`${publications.revocationJws} IS NOT NULL`,
            sql`${target} <> ${this.signing.siteId}`,
            isNull(deliveries.publicationId),
          ),
        )
        .orderBy(asc(publications.createdAt), asc(publications.publicationId))
        .limit(8);
      if (pending.length)
        await this.db
          .insert(deliveries)
          .values(pending.map((row) => ({ ...row, localSiteId: this.signing.siteId })))
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
    const [row] = await tx
      .select()
      .from(publications)
      .where(
        and(
          eq(publications.localSiteId, this.signing.siteId),
          eq(publications.publicationId, claim.publicationId),
        ),
      );
    if (!row?.revocationJws || !row.revocationPayload) throw new FederationError("POLICY_DENIED");
    const value =
      claim.payload ??
      CaseRevocationNoticeSchema.parse({
        protocolVersion: 1,
        kind: "case-revocation-notice",
        noticeId: randomUUID(),
        issuerSiteId: this.signing.siteId,
        receivingSiteId: claim.receivingSiteId,
        publication: row.payload,
        publicationJws: row.approvalJws,
        revocationJws: row.revocationJws,
        issuedAt: new Date().toISOString(),
      });
    if (
      value.revocationJws !== row.revocationJws ||
      value.publicationJws !== row.approvalJws ||
      federationCanonicalJson(value.publication) !== federationCanonicalJson(row.payload) ||
      value.receivingSiteId !== claim.receivingSiteId ||
      value.issuerSiteId !== this.signing.siteId
    )
      throw new FederationError("OPERATION_CONFLICT");
    const withdrawal = await this.cases.verifyWithdrawal(tx, value);
    const [peer] = await tx
      .select()
      .from(sites)
      .where(eq(sites.id, claim.receivingSiteId))
      .for("share");
    if (peer?.state !== "active" || (endpoint && peer.endpoint !== endpoint))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const noticeJws =
      claim.noticeJws ??
      (await signFederationMessage(CaseRevocationNoticeSchema, value, this.signing));
    const keyId = federationMessageKeyId(noticeJws);
    await this.trust.assertKey(tx, this.signing.siteId, keyId, new Date());
    const verified = await verifyFederationMessage(
      CaseRevocationNoticeSchema,
      noticeJws,
      await this.trust.resolveKey(this.signing.siteId, keyId, new Date(), tx),
      new Date(),
    );
    if (federationCanonicalJson(verified.payload) !== federationCanonicalJson(value))
      throw new FederationError("OPERATION_CONFLICT");
    return {
      value,
      noticeJws,
      digest: verified.digest,
      withdrawal,
      orgId: row.localOrgId,
      endpoint: peer.endpoint,
    };
  }
  private async advance(claim: Delivery) {
    if (!this.send) return;
    const source = await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim),
        value = await this.source(tx, row);
      await this.lock(tx, claim);
      if (!row.noticeJws)
        await tx
          .update(deliveries)
          .set({ payload: value.value, noticeJws: value.noticeJws })
          .where(this.key(claim));
      return value;
    });
    const response = await this.send(
      source.endpoint,
      source.noticeJws,
      "/federation/v1/case-revocations",
    );
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim),
        current = await this.source(tx, row, source.endpoint);
      if (current.noticeJws !== source.noticeJws || current.digest !== source.digest)
        throw new FederationError("OPERATION_CONFLICT");
      const keyId = federationMessageKeyId(response);
      await this.trust.assertKey(tx, claim.receivingSiteId, keyId, new Date());
      const { payload: receipt } = await verifyFederationMessage(
        CaseRevocationReceiptSchema,
        response,
        await this.trust.resolveKey(claim.receivingSiteId, keyId, new Date(), tx),
        new Date(),
      );
      if (
        receipt.noticeId !== source.value.noticeId ||
        receipt.noticeDigest !== source.digest ||
        receipt.publicationId !== claim.publicationId ||
        receipt.publicationDigest !== source.withdrawal.payload.publicationDigest ||
        receipt.revocationId !== source.withdrawal.payload.revocationId ||
        receipt.revocationDigest !== source.withdrawal.digest ||
        receipt.issuerSiteId !== this.signing.siteId ||
        receipt.receivingSiteId !== claim.receivingSiteId ||
        Date.parse(receipt.recordedAt) < Date.parse(source.value.issuedAt) ||
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
        actor: `case-revocation:${this.signing.siteId}`,
        orgId: source.orgId,
        action: "federation.case_revocation.delivered",
        target: claim.publicationId,
        diff: {
          after: { receivingSiteId: claim.receivingSiteId, noticeId: source.value.noticeId },
        },
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
          asc(deliveries.publicationId),
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
        error instanceof FederationError ||
        error instanceof z.ZodError ||
        (error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE");
      await this.db
        .update(deliveries)
        .set({
          state: review ? "needs_review" : "pending",
          lastError:
            error instanceof FederationError || error instanceof FederationDeliveryError
              ? error.code
              : "REVOCATION_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim),
            eq(deliveries.leaseToken, claim.leaseToken),
            sql`${deliveries.leaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }
  async status(actor: FederationActor, revisionId: string, publicationId: string) {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, revisionId, publicationId);
      const sent = await tx
        .select({
          receivingSiteId: deliveries.receivingSiteId,
          state: deliveries.state,
          lastError: deliveries.lastError,
          acknowledgedAt: deliveries.acknowledgedAt,
        })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.localSiteId, this.signing.siteId),
            eq(deliveries.publicationId, publicationId),
          ),
        );
      const received = await tx
        .select({ issuerSiteId: notices.issuerSiteId, receivedAt: notices.receivedAt })
        .from(notices)
        .where(
          and(
            eq(notices.localSiteId, this.signing.siteId),
            eq(notices.publicationId, publicationId),
          ),
        );
      return { enabled: !!this.send, sent, received };
    });
  }
  private async authorize(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    publicationId: string,
  ) {
    await requireFederationCapability(tx, actor, "case.publish");
    const [row] = await tx
      .select()
      .from(publications)
      .where(
        and(
          eq(publications.localSiteId, this.signing.siteId),
          eq(publications.publicationId, publicationId),
          eq(publications.localOrgId, actor.orgId),
          eq(publications.agreementRevisionId, revisionId),
        ),
      );
    if (!row) throw new FederationError("POLICY_DENIED");
  }
  async retry(
    actor: FederationActor,
    revisionId: string,
    publicationId: string,
    receivingSiteId: string,
  ) {
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    await this.db.transaction(async (tx) => {
      await this.authorize(tx, actor, revisionId, publicationId);
      const [row] = await tx
        .select()
        .from(deliveries)
        .where(this.key({ publicationId, receivingSiteId }))
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
        action: "federation.case_revocation.retry",
        target: publicationId,
        diff: { after: { receivingSiteId } },
      });
    });
  }
}
