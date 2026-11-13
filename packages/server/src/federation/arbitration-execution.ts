import { randomUUID } from "node:crypto";
import {
  type PgDb,
  type PgTransaction,
  federationReceivedArbitrationDecisions as received,
  federationArbitrationResolutions as resolutions,
  federationSites as sites,
} from "@kuintessence/db";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  ArbitrationExecutionCommitmentSchema,
  ArbitrationExecutionQuerySchema,
  ArbitrationExecutionReceiptSchema,
  ArbitrationExecutionResponseSchema,
  ArbitrationExecutionWithdrawalQuerySchema,
  ArbitrationExecutionWithdrawalResponseSchema,
  assertArbitrationCommitment,
} from "@kuintessence/shared/federation/arbitration-execution";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { verifyArbitrationHistory } from "./arbitration-decision-history";
import { verifyBilateralArbitrationExecution } from "./arbitration-execution-proof";
import { FederationArbitrationResolutionService } from "./arbitration-resolution";
import {
  applyArbitrationWithdrawal,
  createArbitrationWithdrawal,
  receivedArbitrationResolution,
} from "./arbitration-withdrawal";
import { lockFederationDisputeTask } from "./dispute-freeze";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

const Query = z.discriminatedUnion("kind", [
  ArbitrationExecutionQuerySchema,
  ArbitrationExecutionWithdrawalQuerySchema,
]);
const Response = z.discriminatedUnion("kind", [
  ArbitrationExecutionResponseSchema,
  ArbitrationExecutionWithdrawalResponseSchema,
]);

type Execution = typeof resolutions.$inferSelect;
class LeaseLost extends Error {}
/** A sends its durable commitment. B's transaction creates the sole execution receipt and posts once. */
export class FederationArbitrationExecutionExchange {
  private readonly trust: FederationTrustRegistry;
  private readonly resolution: FederationArbitrationResolutionService;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.resolution = new FederationArbitrationResolutionService(db, signing);
  }
  private key(decisionId: string) {
    return and(
      eq(resolutions.localSiteId, this.signing.siteId),
      eq(resolutions.decisionId, decisionId),
    );
  }
  private async sign<T extends { kind: string }>(
    tx: PgTransaction,
    schema: z.ZodType<T>,
    value: T,
  ) {
    const now = new Date();
    await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
    const jws = await signFederationMessage(schema, value, this.signing);
    await verifyFederationMessage(
      schema,
      jws,
      await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx),
      now,
    );
    return jws;
  }
  private fresh(issuedAt: string) {
    if (Math.abs(Date.now() - Date.parse(issuedAt)) > 60000)
      throw new FederationError("AUTHORIZATION_EXPIRED");
  }
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const signed = await verifyFederationMessage(Query, jws, peer, new Date());
    const q = signed.payload,
      value = q.commitment.payload.resolution;
    this.fresh(q.issuedAt);
    if (
      peer.siteId !== q.sourceSiteId ||
      q.targetSiteId !== this.signing.siteId ||
      value.sourceSiteId !== peer.siteId ||
      value.targetSiteId !== this.signing.siteId
    )
      throw new FederationError("UNTRUSTED_IDENTITY");
    assertArbitrationCommitment(q.commitment.payload, value, peer.siteId);
    return this.db.transaction(async (tx) => {
      await lockFederationDisputeTask(tx, this.signing.siteId, value);
      const [row] = await tx
        .select()
        .from(resolutions)
        .where(this.key(value.decisionId))
        .for("update");
      if (row && federationCanonicalJson(row.payload) !== federationCanonicalJson(value))
        throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, new Date());
      await verifyFederationMessage(
        Query,
        jws,
        await this.trust.resolveKey(peer.siteId, peer.keyId, new Date(), tx),
        new Date(),
      );
      this.fresh(q.issuedAt);
      const [original] = await tx
        .select()
        .from(received)
        .where(
          and(
            eq(received.localSiteId, this.signing.siteId),
            eq(received.decisionId, value.decisionId),
          ),
        );
      if (
        original?.executionWithdrawal ||
        (q.kind === "arbitration-execution-withdrawal-query" && !row?.executionReceipt)
      ) {
        if (!original) throw new FederationError("DATA_WAITING");
        if (
          federationCanonicalJson(receivedArbitrationResolution(original.payload)) !==
          federationCanonicalJson(value)
        )
          throw new FederationError("OPERATION_CONFLICT");
        const source = await verifyArbitrationHistory(
          tx,
          ArbitrationExecutionCommitmentSchema,
          q.commitment.jws,
          peer.siteId,
          new Date(q.commitment.payload.committedAt),
        );
        if (
          federationCanonicalJson(source.payload) !==
            federationCanonicalJson(q.commitment.payload) ||
          Date.parse(source.payload.committedAt) > Date.now() + 60000
        )
          throw new FederationError("OPERATION_CONFLICT");
        const withdrawal = await createArbitrationWithdrawal(
          tx,
          this.signing,
          value,
          peer.siteId,
          this.trust,
        );
        return this.sign(tx, ArbitrationExecutionWithdrawalResponseSchema, {
          protocolVersion: 1,
          kind: "arbitration-execution-withdrawal-response",
          queryDigest: signed.digest,
          sourceSiteId: value.sourceSiteId,
          targetSiteId: value.targetSiteId,
          ...withdrawal,
          issuedAt: new Date().toISOString(),
        });
      }
      if (!row?.commitment || !row.commitmentJws) throw new FederationError("DATA_WAITING");
      if (row.counterpartyCommitmentJws) {
        if (
          row.counterpartyCommitmentJws !== q.commitment.jws ||
          federationCanonicalJson(row.counterpartyCommitment) !==
            federationCanonicalJson(q.commitment.payload)
        )
          throw new FederationError("OPERATION_CONFLICT");
      } else {
        // First receipt requires a currently trusted peer key. Saved commitments can later be recovered historically.
        const kid = federationMessageKeyId(q.commitment.jws);
        await this.trust.assertKey(tx, peer.siteId, kid, new Date());
        const proof = await verifyFederationMessage(
          ArbitrationExecutionCommitmentSchema,
          q.commitment.jws,
          await this.trust.resolveKey(peer.siteId, kid, new Date(), tx),
          new Date(),
        );
        if (
          federationCanonicalJson(proof.payload) !==
            federationCanonicalJson(q.commitment.payload) ||
          Date.parse(proof.payload.committedAt) > Date.now()
        )
          throw new FederationError("OPERATION_CONFLICT");
        await tx
          .update(resolutions)
          .set({
            counterpartyCommitment: proof.payload,
            counterpartyCommitmentJws: q.commitment.jws,
          })
          .where(this.key(value.decisionId));
        row.counterpartyCommitment = proof.payload;
        row.counterpartyCommitmentJws = q.commitment.jws;
      }
      if (!row.executionReceipt) {
        const own = await verifyArbitrationHistory(
          tx,
          ArbitrationExecutionCommitmentSchema,
          row.commitmentJws,
          this.signing.siteId,
          new Date(row.commitment.committedAt),
        );
        const source = await verifyArbitrationHistory(
          tx,
          ArbitrationExecutionCommitmentSchema,
          q.commitment.jws,
          value.sourceSiteId,
          new Date(q.commitment.payload.committedAt),
        );
        const receipt = ArbitrationExecutionReceiptSchema.parse({
          protocolVersion: 1,
          kind: "arbitration-execution-receipt",
          resolution: value,
          sourceCommitmentDigest: source.digest,
          targetCommitmentDigest: own.digest,
          executedAt: new Date().toISOString(),
        });
        const receiptJws = await this.sign(tx, ArbitrationExecutionReceiptSchema, receipt);
        await tx
          .update(resolutions)
          .set({ executionReceipt: receipt, executionReceiptJws: receiptJws })
          .where(this.key(value.decisionId));
        row.executionReceipt = receipt;
        row.executionReceiptJws = receiptJws;
      }
      await verifyBilateralArbitrationExecution(tx, row);
      await this.resolution.apply(tx, value.decisionId, value.decisionDigest);
      // Current transport reattests the saved proof, including after rotation or a lost response.
      return this.sign(
        tx,
        ArbitrationExecutionResponseSchema,
        ArbitrationExecutionResponseSchema.parse({
          protocolVersion: 1,
          kind: "arbitration-execution-response",
          queryDigest: signed.digest,
          sourceSiteId: value.sourceSiteId,
          targetSiteId: value.targetSiteId,
          commitment: { payload: row.commitment, jws: row.commitmentJws },
          receipt: row.executionReceipt,
          receiptJws: row.executionReceiptJws,
          issuedAt: new Date().toISOString(),
        }),
      );
    });
  }
  private async lock(tx: PgTransaction, claim: Execution) {
    if (!claim.leaseToken) throw new LeaseLost();
    const [row] = await tx
      .select()
      .from(resolutions)
      .where(
        and(
          this.key(claim.decisionId),
          isNull(resolutions.appliedAt),
          eq(resolutions.leaseToken, claim.leaseToken),
          sql`${resolutions.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new LeaseLost();
    return row;
  }
  private async advance(claim: Execution) {
    if (!this.send) return;
    const request = await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim),
        value = row.payload;
      if (!row.commitment || !row.commitmentJws || value.sourceSiteId !== this.signing.siteId)
        throw new FederationError("OPERATION_CONFLICT");
      const [peer] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, value.targetSiteId))
        .for("share");
      if (peer?.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
      const query = Query.parse({
        protocolVersion: 1,
        kind: row.withdrawalRequestedAt
          ? "arbitration-execution-withdrawal-query"
          : "arbitration-execution-query",
        queryId: randomUUID(),
        sourceSiteId: value.sourceSiteId,
        targetSiteId: value.targetSiteId,
        commitment: { payload: row.commitment, jws: row.commitmentJws },
        issuedAt: new Date().toISOString(),
      });
      const jws = await this.sign(tx, Query, query);
      const signed = await verifyFederationMessage(
        Query,
        jws,
        await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, new Date(), tx),
        new Date(),
      );
      return { endpoint: peer.endpoint, signed };
    });
    const response = await this.send(
      request.endpoint,
      request.signed.jws,
      "/federation/v1/arbitration-executions",
    );
    await this.db.transaction(async (tx) => {
      await lockFederationDisputeTask(tx, this.signing.siteId, claim.payload);
      const row = await this.lock(tx, claim),
        value = row.payload;
      const [peer] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, value.targetSiteId))
        .for("share");
      if (peer?.state !== "active" || peer.endpoint !== request.endpoint)
        throw new FederationError("UNTRUSTED_IDENTITY");
      const kid = federationMessageKeyId(response);
      await this.trust.assertKey(tx, value.targetSiteId, kid, new Date());
      const result = await verifyFederationMessage(
        Response,
        response,
        await this.trust.resolveKey(value.targetSiteId, kid, new Date(), tx),
        new Date(),
      );
      const r = result.payload;
      this.fresh(r.issuedAt);
      if (
        r.queryDigest !== request.signed.digest ||
        r.sourceSiteId !== value.sourceSiteId ||
        r.targetSiteId !== value.targetSiteId
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (r.kind === "arbitration-execution-withdrawal-response") {
        await applyArbitrationWithdrawal(tx, this.signing.siteId, value, r.receipt, r.receiptJws);
        return;
      }
      row.counterpartyCommitment = r.commitment.payload;
      row.counterpartyCommitmentJws = r.commitment.jws;
      row.executionReceipt = r.receipt;
      row.executionReceiptJws = r.receiptJws;
      await verifyBilateralArbitrationExecution(tx, row);
      await tx
        .update(resolutions)
        .set({
          counterpartyCommitment: r.commitment.payload,
          counterpartyCommitmentJws: r.commitment.jws,
          executionReceipt: r.receipt,
          executionReceiptJws: r.receiptJws,
        })
        .where(this.key(row.decisionId));
      await this.resolution.apply(tx, row.decisionId, value.decisionDigest);
      await tx
        .update(resolutions)
        .set({ leaseToken: null, leaseUntil: null, lastError: null })
        .where(this.key(row.decisionId));
    });
  }
  async advanceNext() {
    if (!this.send) return false;
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(resolutions)
        .where(
          and(
            eq(resolutions.localSiteId, this.signing.siteId),
            isNull(resolutions.appliedAt),
            sql`${resolutions.commitment} IS NOT NULL`,
            sql`NOT EXISTS (SELECT 1 FROM ${received} WHERE ${received.localSiteId} = ${resolutions.localSiteId}
              AND ${received.decisionId} = ${resolutions.decisionId} AND ${received.executionWithdrawal} IS NOT NULL)`,
            sql`${resolutions.payload}->>'sourceSiteId' = ${this.signing.siteId}`,
            sql`${resolutions.nextAttemptAt} <= clock_timestamp()`,
            sql`(${resolutions.leaseUntil} IS NULL OR ${resolutions.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(resolutions.nextAttemptAt), asc(resolutions.decisionId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return;
      return (
        await tx
          .update(resolutions)
          .set({
            leaseToken: randomUUID(),
            leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
          })
          .where(this.key(row.decisionId))
          .returning()
      )[0];
    });
    if (!claim) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof LeaseLost || !claim.leaseToken) return true;
      await this.db
        .update(resolutions)
        .set({
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
          lastError:
            error instanceof FederationError || error instanceof FederationDeliveryError
              ? error.code
              : "EXECUTION_RETRY",
        })
        .where(
          and(
            this.key(claim.decisionId),
            eq(resolutions.leaseToken, claim.leaseToken),
            sql`${resolutions.leaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }
}
