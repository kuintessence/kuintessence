import { randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialAgreements as contracts,
  federationSites,
  federationOutbound as outbound,
  type PgDb,
  type PgTransaction,
  federationReceivedUsage as received,
  federationUsageReports as reports,
  federationReservations as reservations,
  federationUsageSyncs as syncs,
  federationUsageTasks as tasks,
} from "@kuintessence/db";
import {
  assertFederationReportIdentity,
  assertFederationStatusQueryFresh,
  FederationError,
} from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialUsageSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  CommercialUsagePageSchema,
  CommercialUsageQuerySchema,
} from "@kuintessence/shared/federation/usage-exchange";
import { and, asc, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import type { FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Sync = typeof syncs.$inferSelect;
const key = (site: string, operation: string) =>
  and(eq(syncs.localSiteId, site), eq(syncs.operationId, operation));

const syncView = {
  operationId: syncs.operationId,
  number: syncs.number,
  lastReportId: syncs.lastReportId,
  state: syncs.state,
  providerState: syncs.providerState,
  lastError: syncs.lastError,
  nextAttemptAt: syncs.nextAttemptAt,
  verifiedAt: syncs.verifiedAt,
};

export class FederationUsageExchange {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async receive(jws: string, fingerprint: string): Promise<string> {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const { payload: query, digest } = await verifyFederationMessage(
      CommercialUsageQuerySchema,
      jws,
      peer,
      new Date(),
    );
    if (query.senderSiteId !== peer.siteId || query.recipientSiteId !== this.signing.siteId)
      throw new FederationError("POLICY_DENIED");
    const authorize = async (tx: PgTransaction) => {
      assertFederationStatusQueryFresh(query, new Date());
      for (const site of [peer.siteId, this.signing.siteId].sort()) {
        if (site === peer.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, peer.keyId, new Date());
        else await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
      }
      const [row] = await tx
        .select({ contract: contracts, reservation: reservations })
        .from(contracts)
        .innerJoin(
          reservations,
          and(
            eq(reservations.agreementRevisionId, contracts.revisionId),
            eq(reservations.id, query.reservationId),
          ),
        )
        .where(
          and(
            eq(contracts.localSiteId, this.signing.siteId),
            eq(contracts.revisionId, query.agreementRevisionId),
          ),
        )
        .for("share");
      if (
        !row?.contract.counterpartyJws ||
        row.contract.digest !== query.agreementDigest ||
        row.contract.terms.agreement.sourceSiteId !== peer.siteId ||
        row.contract.terms.agreement.targetSiteId !== this.signing.siteId ||
        row.reservation.senderSiteId !== peer.siteId ||
        row.reservation.operationId !== query.operationId ||
        row.reservation.taskId !== query.taskId ||
        row.reservation.attempt !== query.attempt ||
        row.reservation.requestDigest !== query.requestDigest
      )
        throw new FederationError("POLICY_DENIED");
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      if (!own.allowedKinds.includes("commercial-usage-page"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      return own;
    };
    const page = await this.db.transaction(async (tx) => {
      await authorize(tx);
      const [task] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.reservationId, query.reservationId),
            eq(tasks.localSiteId, this.signing.siteId),
          ),
        );
      if (query.afterNumber) {
        const [previous] = await tx
          .select({ id: reports.id })
          .from(reports)
          .where(
            and(
              eq(reports.reservationId, query.reservationId),
              eq(reports.number, query.afterNumber),
            ),
          );
        if (previous?.id !== query.afterReportId) throw new FederationError("OPERATION_CONFLICT");
      }
      const [latest] = await tx
        .select({ number: reports.number })
        .from(reports)
        .where(eq(reports.reservationId, query.reservationId))
        .orderBy(desc(reports.number))
        .limit(1);
      const [next] = await tx
        .select({
          number: reports.number,
          report: reports.report,
          reportJws: reports.reportJws,
          correctionEvidence: reports.correctionEvidence,
        })
        .from(reports)
        .where(
          and(
            eq(reports.reservationId, query.reservationId),
            gt(reports.number, query.afterNumber),
          ),
        )
        .orderBy(asc(reports.number))
        .limit(1);
      // The head can grow while reading; never claim a smaller head than the item we disclose.
      const {
        issuedAt: _issuedAt,
        expiresAt: _expiresAt,
        afterReportId: _afterReportId,
        ...identity
      } = query;
      return CommercialUsagePageSchema.parse({
        ...identity,
        kind: "commercial-usage-page",
        senderSiteId: this.signing.siteId,
        recipientSiteId: peer.siteId,
        queryDigest: digest,
        observedAt: new Date().toISOString(),
        reportingState: task?.state ?? "waiting",
        latestNumber: Math.max(latest?.number ?? 0, next?.number ?? 0),
        item: next ?? null,
      });
    });
    const signed = await signFederationMessage(CommercialUsagePageSchema, page, this.signing);
    await this.db.transaction(async (tx) => {
      const own = await authorize(tx);
      await verifyFederationMessage(CommercialUsagePageSchema, signed, own, new Date());
    });
    return signed;
  }

  async discover() {
    if (!this.send) return;
    const rows = await this.db
      .select({ localSiteId: outbound.localSiteId, operationId: outbound.operationId })
      .from(outbound)
      .innerJoin(
        contracts,
        and(
          eq(contracts.localSiteId, outbound.localSiteId),
          eq(contracts.revisionId, outbound.agreementRevisionId),
          eq(contracts.localOrgId, outbound.localOrgId),
        ),
      )
      .leftJoin(
        syncs,
        and(
          eq(syncs.localSiteId, outbound.localSiteId),
          eq(syncs.operationId, outbound.operationId),
        ),
      )
      .where(
        and(
          eq(outbound.localSiteId, this.signing.siteId),
          eq(outbound.state, "accepted"),
          isNotNull(outbound.receipt),
          isNotNull(contracts.counterpartyJws),
          isNull(syncs.operationId),
        ),
      )
      .orderBy(asc(outbound.operationId))
      .limit(8);
    if (rows.length) await this.db.insert(syncs).values(rows).onConflictDoNothing();
  }

  private async source(
    tx: PgTransaction,
    operationId: string,
    actor?: FederationActor,
    revisionId?: string,
  ) {
    if (actor) await requireFederationCapability(tx, actor, "agreement.read");
    const [saved] = await tx
      .select({ outbound, contract: contracts })
      .from(outbound)
      .innerJoin(
        contracts,
        and(
          eq(contracts.localSiteId, outbound.localSiteId),
          eq(contracts.revisionId, outbound.agreementRevisionId),
          eq(contracts.localOrgId, outbound.localOrgId),
        ),
      )
      .where(
        and(
          eq(outbound.localSiteId, this.signing.siteId),
          eq(outbound.operationId, operationId),
          actor ? eq(contracts.localOrgId, actor.orgId) : undefined,
          revisionId ? eq(contracts.revisionId, revisionId) : undefined,
        ),
      )
      .for("share");
    if (
      !saved?.contract.counterpartyJws ||
      saved.outbound.state !== "accepted" ||
      !saved.outbound.receipt
    )
      throw new FederationError("POLICY_DENIED");
    const terms = CommercialAgreementSchema.parse(saved.contract.terms);
    if (
      terms.agreement.sourceSiteId !== this.signing.siteId ||
      terms.agreement.targetSiteId !== saved.outbound.request.recipientSiteId
    )
      throw new FederationError("OPERATION_CONFLICT");
    return { ...saved, terms, receipt: saved.outbound.receipt };
  }

  private async authorizeNetwork(tx: PgTransaction, operationId: string) {
    const saved = await this.source(tx, operationId);
    for (const site of [this.signing.siteId, saved.terms.agreement.targetSiteId].sort()) {
      if (site === this.signing.siteId)
        await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
      else {
        const [peer] = await tx
          .select()
          .from(federationSites)
          .where(eq(federationSites.id, site))
          .for("share");
        if (!peer || peer.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
        if (peer.endpoint !== saved.outbound.endpoint)
          throw new FederationError("OPERATION_CONFLICT");
      }
    }
    return saved;
  }

  private async fetch(claim: Sync) {
    if (!this.send) return;
    const saved = await this.db.transaction((tx) => this.authorizeNetwork(tx, claim.operationId));
    const query = CommercialUsageQuerySchema.parse({
      protocolVersion: 1,
      kind: "commercial-usage-query",
      queryId: randomUUID(),
      senderSiteId: this.signing.siteId,
      recipientSiteId: saved.terms.agreement.targetSiteId,
      operationId: claim.operationId,
      agreementRevisionId: saved.contract.revisionId,
      agreementDigest: saved.contract.digest,
      taskId: saved.outbound.taskId,
      attempt: saved.outbound.attempt,
      reservationId: saved.receipt.reservationId,
      requestDigest: saved.outbound.requestDigest,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      afterNumber: claim.number,
      afterReportId: claim.lastReportId,
    });
    const own = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date());
    const jws = await signFederationMessage(CommercialUsageQuerySchema, query, this.signing);
    const verifiedQuery = await verifyFederationMessage(
      CommercialUsageQuerySchema,
      jws,
      own,
      new Date(),
    );
    await this.db.transaction((tx) => this.authorizeNetwork(tx, claim.operationId));
    const pageJws = await this.send(saved.outbound.endpoint, jws, "/federation/v1/usage");
    const peerKeyId = federationMessageKeyId(pageJws);
    const peer = await this.trust.resolveKey(query.recipientSiteId, peerKeyId, new Date());
    const { payload: page } = await verifyFederationMessage(
      CommercialUsagePageSchema,
      pageJws,
      peer,
      new Date(),
    );
    await this.db.transaction(async (tx) => {
      const current = await this.lockClaim(tx, claim);
      const currentSource = await this.authorizeNetwork(tx, claim.operationId);
      await this.trust.assertKey(tx, peer.siteId, peer.keyId, new Date());
      assertFederationReportIdentity(query, verifiedQuery.digest, page, new Date());
      if (
        current.number !== claim.number ||
        current.lastReportId !== claim.lastReportId ||
        currentSource.contract.digest !== saved.contract.digest ||
        page.agreementDigest !== query.agreementDigest ||
        page.afterNumber !== query.afterNumber ||
        page.latestNumber < query.afterNumber ||
        !!page.item !== page.latestNumber > query.afterNumber
      )
        throw new FederationError("INVALID_MESSAGE");
      let reportId = claim.lastReportId;
      if (page.item) {
        const item = page.item;
        const report = item.report;
        const at = new Date(report.reportedAt);
        const reportKeyId = federationMessageKeyId(item.reportJws);
        // Current authenticated page re-attests historical bytes; expired, unrevoked keys may verify at report time.
        await this.trust.assertKey(tx, peer.siteId, reportKeyId, at);
        const historical = await this.trust.resolveKey(peer.siteId, reportKeyId, at, tx);
        const verified = await verifyFederationMessage(
          CommercialUsageSchema,
          item.reportJws,
          historical,
          at,
        );
        if (
          federationMaterialDigest(verified.payload) !== federationMaterialDigest(report) ||
          item.number !== claim.number + 1 ||
          report.domainId !== saved.terms.domainId ||
          report.agreementRevisionId !== query.agreementRevisionId ||
          report.agreementDigest !== query.agreementDigest ||
          report.sourceSiteId !== query.senderSiteId ||
          report.targetSiteId !== query.recipientSiteId ||
          report.taskId !== query.taskId ||
          report.attempt !== query.attempt ||
          (report.correctionOf ?? null) !== claim.lastReportId ||
          at > new Date(page.observedAt) ||
          new Date(report.periodStart) < new Date(saved.terms.agreement.validFrom) ||
          new Date(report.periodEnd) > new Date(saved.terms.agreement.validUntil) ||
          report.measurements.length !== saved.terms.prices.length ||
          !report.measurements.every((m) =>
            saved.terms.prices.some(
              (p) => p.metric === m.metric && p.quantityUnit === m.quantityUnit,
            ),
          )
        )
          throw new FederationError("INVALID_MESSAGE");
        if (claim.number === 0) {
          if (item.correctionEvidence) throw new FederationError("INVALID_MESSAGE");
        } else {
          const [previous] = await tx
            .select()
            .from(received)
            .where(
              and(
                eq(received.localSiteId, this.signing.siteId),
                eq(received.operationId, claim.operationId),
                eq(received.number, claim.number),
              ),
            );
          const correction = item.correctionEvidence;
          if (
            !previous ||
            !correction ||
            correction.reservationId !== query.reservationId ||
            correction.previousDigest !== previous.digest ||
            correction.declaration.reportId !== report.reportId ||
            correction.declaration.correctionOf !== previous.reportId ||
            report.periodStart !== previous.report.periodStart ||
            report.periodEnd !== previous.report.periodEnd ||
            at < new Date(previous.report.reportedAt) ||
            correction.recordedAt !== report.reportedAt ||
            correction.declaration.measurements.length !== report.measurements.length ||
            !report.measurements.every(
              (m) =>
                m.evidenceDigest === federationMaterialDigest(correction) &&
                correction.declaration.measurements.some(
                  (c) =>
                    c.metric === m.metric &&
                    c.quantityUnit === m.quantityUnit &&
                    c.quantity === m.quantity,
                ),
            )
          )
            throw new FederationError("INVALID_MESSAGE");
        }
        await tx.insert(received).values({
          localSiteId: this.signing.siteId,
          operationId: claim.operationId,
          reportId: report.reportId,
          number: item.number,
          report,
          reportJws: item.reportJws,
          digest: verified.digest,
          correctionEvidence: item.correctionEvidence,
          pageJws,
        });
        reportId = report.reportId;
      }
      await tx
        .update(syncs)
        .set({
          number: page.item?.number ?? claim.number,
          lastReportId: reportId,
          providerState: page.reportingState,
          verifiedAt: sql`clock_timestamp()`,
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt:
            page.latestNumber > (page.item?.number ?? claim.number)
              ? sql`clock_timestamp()`
              : sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(key(this.signing.siteId, claim.operationId));
    });
  }

  private async lockClaim(tx: PgTransaction, claim: Sync) {
    if (!claim.leaseToken) throw new FederationError("OPERATION_CONFLICT");
    const [row] = await tx
      .select()
      .from(syncs)
      .where(
        and(
          key(this.signing.siteId, claim.operationId),
          eq(syncs.leaseToken, claim.leaseToken),
          sql`${syncs.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new FederationError("OPERATION_CONFLICT");
    return row;
  }

  async advanceNext() {
    if (!this.send) return false;
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(syncs)
        .where(
          and(
            eq(syncs.localSiteId, this.signing.siteId),
            eq(syncs.state, "pending"),
            sql`${syncs.nextAttemptAt} <= clock_timestamp()`,
            sql`(${syncs.leaseUntil} IS NULL OR ${syncs.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(syncs.nextAttemptAt), asc(syncs.operationId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return undefined;
      const [claimed] = await tx
        .update(syncs)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(key(this.signing.siteId, row.operationId))
        .returning();
      return claimed;
    });
    if (!claim?.leaseToken) return false;
    try {
      await this.fetch(claim);
    } catch (error) {
      await this.db
        .update(syncs)
        .set({
          state:
            error instanceof FederationError || error instanceof z.ZodError
              ? "needs_review"
              : "pending",
          lastError:
            error instanceof FederationError
              ? error.code
              : error instanceof z.ZodError
                ? "INVALID_MESSAGE"
                : "EXCHANGE_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(key(this.signing.siteId, claim.operationId), eq(syncs.leaseToken, claim.leaseToken)),
        );
    }
    return true;
  }

  async list(actor: FederationActor, revisionId: string, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      return tx
        .select(syncView)
        .from(syncs)
        .innerJoin(
          outbound,
          and(
            eq(outbound.localSiteId, syncs.localSiteId),
            eq(outbound.operationId, syncs.operationId),
          ),
        )
        .where(
          and(
            eq(syncs.localSiteId, this.signing.siteId),
            eq(outbound.localOrgId, actor.orgId),
            eq(outbound.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(asc(syncs.operationId))
        .limit(limit)
        .offset(offset);
    });
  }

  async get(
    actor: FederationActor,
    revisionId: string,
    operationId: string,
    limit = 50,
    offset = 0,
  ) {
    return this.db.transaction(async (tx) => {
      await this.source(tx, operationId, actor, revisionId);
      const [sync] = await tx
        .select(syncView)
        .from(syncs)
        .where(key(this.signing.siteId, operationId));
      const rows = await tx
        .select({
          reportId: received.reportId,
          number: received.number,
          report: received.report,
          reportJws: received.reportJws,
          digest: received.digest,
          correctionEvidence: received.correctionEvidence,
          receivedAt: received.receivedAt,
        })
        .from(received)
        .where(
          and(eq(received.localSiteId, this.signing.siteId), eq(received.operationId, operationId)),
        )
        .orderBy(desc(received.number))
        .limit(limit + 1)
        .offset(offset);
      return { sync: sync ?? null, reports: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }

  async retry(actor: FederationActor, revisionId: string, operationId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      await this.source(tx, operationId, actor, revisionId);
      const [sync] = await tx
        .select(syncView)
        .from(syncs)
        .where(key(this.signing.siteId, operationId))
        .for("update");
      if (!sync) throw new FederationError("ASSET_UNAVAILABLE");
      const [changed] = await tx
        .update(syncs)
        .set({ state: "pending", nextAttemptAt: sql`clock_timestamp()` })
        .where(
          and(
            key(this.signing.siteId, operationId),
            sql`(${syncs.leaseUntil} IS NULL OR ${syncs.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .returning();
      if (!changed) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.usage.refresh",
        target: operationId,
        diff: { after: { number: sync.number } },
      });
    });
  }
}
