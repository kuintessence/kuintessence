import { randomBytes, randomUUID } from "node:crypto";
import {
  federationAgreements as agreements,
  federationAttestationAttempts as attempts,
  auditLog,
  federationEvidenceBatches as batches,
  federationEvidence as evidence,
  federationAttestationOutbox as outbox,
  type PgDb,
  type PgTransaction,
  federationReservations as reservations,
  federationEvidenceStreams as streams,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  FabricEvidenceAdvanceResultSchema,
  FabricProposalCheckpointSchema,
  FederationEvidenceBatchSchema,
} from "@kuintessence/shared/federation/ledger";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { type AttestationClient, AttestationFailure } from "./attestation-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

type Batch = typeof batches.$inferSelect;
type Lease = { id: string; token: string };
class LeaseLost extends Error {}

export class FederationAttestationService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly client?: AttestationClient,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  /** One unresolved batch per domain/issuer preserves ordering across agreements and epochs. */
  async assemble(): Promise<string | null> {
    const [candidate] = await this.db
      .select({ revisionId: agreements.revisionId, domainId: agreements.budgetDomainId })
      .from(outbox)
      .innerJoin(evidence, eq(evidence.id, outbox.evidenceId))
      .innerJoin(reservations, eq(reservations.id, evidence.reservationId))
      .innerJoin(agreements, eq(agreements.revisionId, reservations.agreementRevisionId))
      .where(
        and(
          eq(outbox.state, "pending"),
          eq(agreements.targetSiteId, this.signingKey.siteId),
          sql`${agreements.terms}->>'mode' = 'bilateral_attested'`,
          sql`NOT EXISTS (SELECT 1 FROM ${batches} WHERE ${batches.domainId} = ${agreements.budgetDomainId} AND ${batches.issuerSiteId} = ${this.signingKey.siteId} AND ${batches.state} <> 'anchored')`,
        ),
      )
      .orderBy(asc(outbox.createdAt), asc(outbox.evidenceId))
      .limit(1);
    if (!candidate) return null;
    const domainId = candidate.domainId;
    if (!domainId) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return this.db.transaction(async (tx) => {
      await tx
        .insert(streams)
        .values({ domainId, issuerSiteId: this.signingKey.siteId })
        .onConflictDoNothing();
      const [stream] = await tx
        .select()
        .from(streams)
        .where(
          and(eq(streams.domainId, domainId), eq(streams.issuerSiteId, this.signingKey.siteId)),
        )
        .for("update");
      if (!stream) throw new Error("Evidence stream unavailable");
      const [pending] = await tx
        .select({ id: batches.id })
        .from(batches)
        .where(
          and(
            eq(batches.domainId, domainId),
            eq(batches.issuerSiteId, this.signingKey.siteId),
            ne(batches.state, "anchored"),
          ),
        )
        .limit(1);
      if (pending) return null;
      const [agreement] = await tx
        .select()
        .from(agreements)
        .where(
          and(
            eq(agreements.revisionId, candidate.revisionId),
            eq(agreements.targetSiteId, this.signingKey.siteId),
          ),
        )
        .for("share");
      if (!agreement || agreement.terms.mode !== "bilateral_attested") return null;
      const rows = await tx
        .select({ id: evidence.id, kind: evidence.kind, digest: evidence.digest })
        .from(outbox)
        .innerJoin(evidence, eq(evidence.id, outbox.evidenceId))
        .innerJoin(reservations, eq(reservations.id, evidence.reservationId))
        .where(
          and(
            eq(outbox.state, "pending"),
            eq(reservations.agreementRevisionId, agreement.revisionId),
            sql`${reservations.receipt}->>'mode' = 'bilateral_attested'`,
          ),
        )
        .orderBy(asc(outbox.createdAt), asc(outbox.evidenceId))
        .limit(100)
        .for("update", { of: [outbox] });
      if (!rows.length) return null;
      const id = randomUUID();
      const manifest = FederationEvidenceBatchSchema.parse({
        protocolVersion: 1,
        kind: "evidence-batch",
        batchId: id,
        domainId: stream.domainId,
        agreementRevisionId: agreement.revisionId,
        epoch: agreement.epoch,
        issuerSiteId: this.signingKey.siteId,
        counterpartySiteId: agreement.sourceSiteId,
        confirmation: "unilateral",
        salt: randomBytes(32).toString("hex"),
        createdAt: new Date().toISOString(),
        records: rows.map((row, i) => ({
          evidenceId: row.id,
          kind: row.kind,
          digest: row.digest,
          sequence: (BigInt(stream.nextSequence) + BigInt(i)).toString(),
        })),
      });
      await tx.insert(batches).values({
        id,
        domainId: stream.domainId,
        issuerSiteId: this.signingKey.siteId,
        localOrgId: agreement.localOrgId,
        agreementRevisionId: agreement.revisionId,
        firstSequence: stream.nextSequence,
        manifest,
      });
      for (const record of manifest.records)
        await tx
          .update(outbox)
          .set({ batchId: id, sequence: record.sequence, state: "batched" })
          .where(eq(outbox.evidenceId, record.evidenceId));
      await tx
        .update(streams)
        .set({ nextSequence: (BigInt(stream.nextSequence) + BigInt(rows.length)).toString() })
        .where(
          and(eq(streams.domainId, stream.domainId), eq(streams.issuerSiteId, stream.issuerSiteId)),
        );
      return id;
    });
  }

  private async claim(): Promise<Lease | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: batches.id })
        .from(batches)
        .where(
          and(
            eq(batches.issuerSiteId, this.signingKey.siteId),
            eq(batches.state, "pending"),
            sql`${batches.nextAttemptAt} <= clock_timestamp()`,
            sql`(${batches.leaseToken} IS NULL OR ${batches.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(batches.nextAttemptAt), asc(batches.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const token = randomUUID();
      await tx
        .update(batches)
        .set({ leaseToken: token, leaseUntil: sql`clock_timestamp() + interval '90 seconds'` })
        .where(eq(batches.id, row.id));
      return { id: row.id, token };
    });
  }

  private fenced<T>(
    lease: Lease,
    operation: (tx: PgTransaction, batch: Batch) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(batches)
        .where(
          and(
            eq(batches.id, lease.id),
            eq(batches.issuerSiteId, this.signingKey.siteId),
            eq(batches.state, "pending"),
            eq(batches.leaseToken, lease.token),
            sql`${batches.leaseUntil} > clock_timestamp()`,
          ),
        )
        .for("update");
      if (!row) throw new LeaseLost();
      const result = await operation(tx, row);
      const [valid] = await tx
        .select({ valid: sql<boolean>`${batches.leaseUntil} > clock_timestamp()` })
        .from(batches)
        .where(eq(batches.id, row.id));
      if (!valid?.valid) throw new LeaseLost();
      return result;
    });
  }

  private latest(tx: PgTransaction, id: string) {
    return tx
      .select()
      .from(attempts)
      .where(eq(attempts.batchId, id))
      .orderBy(desc(attempts.number))
      .limit(1);
  }

  /** One checkpoint per call: a transaction can never be submitted before its bytes are committed. */
  async advanceNext(): Promise<boolean> {
    if (!this.client) return false;
    let lease = await this.claim();
    if (!lease) {
      await this.assemble();
      lease = await this.claim();
    }
    if (!lease) return false;
    const claimed = lease;
    try {
      const snapshot = await this.fenced(claimed, async (tx, batch) => ({
        batch,
        attempt: (await this.latest(tx, batch.id))[0],
      }));
      const { batch, attempt } = snapshot;
      if (!batch.issuerJws || !batch.digest) {
        const now = new Date();
        const verification = await this.trust.resolveKey(
          this.signingKey.siteId,
          this.signingKey.keyId,
          now,
        );
        const manifest = FederationEvidenceBatchSchema.parse(batch.manifest);
        const jws = await signFederationMessage(
          FederationEvidenceBatchSchema,
          manifest,
          this.signingKey,
        );
        const verified = await verifyFederationMessage(
          FederationEvidenceBatchSchema,
          jws,
          verification,
          now,
        );
        await this.fenced(claimed, async (tx) => {
          await this.trust.assertKey(tx, this.signingKey.siteId, this.signingKey.keyId, new Date());
          await tx
            .update(batches)
            .set({ issuerJws: jws, digest: verified.digest })
            .where(eq(batches.id, batch.id));
          await this.schedule(tx, batch.id);
        });
      } else if (!attempt || attempt.stage === "invalid" || attempt.stage === "abandoned") {
        const result = FabricProposalCheckpointSchema.parse(
          await this.client.prepare({
            domainId: batch.domainId,
            batchId: batch.id,
            digest: batch.digest,
            envelope: { issuerJws: batch.issuerJws },
          }),
        );
        await this.fenced(claimed, async (tx) => {
          await tx.insert(attempts).values({
            id: randomUUID(),
            batchId: batch.id,
            number: (attempt?.number ?? 0) + 1,
            transactionId: result.transactionId,
            recovery: result.recovery,
          });
          await this.schedule(tx, batch.id);
        });
      } else {
        const result = FabricEvidenceAdvanceResultSchema.parse(
          await this.client.advance(attempt.recovery),
        );
        if (
          result.transactionId !== attempt.transactionId ||
          (attempt.stage === "proposal" && result.state !== "prepared") ||
          (attempt.stage === "transaction" && result.state === "prepared") ||
          (result.state === "pending" && result.recovery !== attempt.recovery)
        )
          throw new AttestationFailure("INVALID_ADAPTER_RESPONSE", true);
        await this.fenced(claimed, async (tx) => {
          if (result.state === "prepared") {
            await tx
              .update(attempts)
              .set({
                stage: "transaction",
                recovery: result.recovery,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(attempts.id, attempt.id));
            await this.schedule(tx, batch.id);
          } else if (result.state === "pending") {
            await this.schedule(tx, batch.id, "LEDGER_PENDING");
          } else {
            await tx
              .update(attempts)
              .set({
                stage: result.state,
                validationCode: result.state === "anchored" ? 0 : result.validationCode,
                blockNumber: result.blockNumber,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(attempts.id, attempt.id));
            await tx
              .update(batches)
              .set({
                state: result.state === "anchored" ? "anchored" : "needs_review",
                lastError: result.state === "anchored" ? null : "LEDGER_INVALID",
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(batches.id, batch.id));
            if (result.state === "anchored")
              await tx
                .update(outbox)
                .set({ state: "anchored" })
                .where(eq(outbox.batchId, batch.id));
          }
        });
      }
    } catch (error) {
      if (!(error instanceof LeaseLost)) {
        const failure =
          error instanceof AttestationFailure
            ? error
            : error instanceof FederationError
              ? new AttestationFailure(error.code, true)
              : error instanceof z.ZodError
                ? new AttestationFailure("INVALID_ADAPTER_RESPONSE", true)
                : new AttestationFailure("ATTESTATION_RETRY");
        try {
          await this.fenced(claimed, async (tx) => {
            await this.schedule(tx, claimed.id, failure.code);
            if (failure.needsReview)
              await tx
                .update(batches)
                .set({ state: "needs_review" })
                .where(eq(batches.id, claimed.id));
          });
        } catch (saveError) {
          if (!(saveError instanceof LeaseLost)) throw saveError;
        }
      }
    } finally {
      await this.db
        .update(batches)
        .set({ leaseToken: null, leaseUntil: null })
        .where(and(eq(batches.id, claimed.id), eq(batches.leaseToken, claimed.token)));
    }
    return true;
  }

  private async schedule(tx: PgTransaction, id: string, error: string | null = null) {
    await tx
      .update(batches)
      .set({
        lastError: error,
        nextAttemptAt: error
          ? sql`clock_timestamp() + interval '30 seconds'`
          : sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(batches.id, id));
  }

  async list(actor: FederationActor, revisionId: string, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.authorizeAgreement(tx, actor, revisionId);
      const rows = await tx
        .select({
          id: batches.id,
          state: batches.state,
          firstSequence: batches.firstSequence,
          recordCount: sql<number>`jsonb_array_length(${batches.manifest}->'records')`,
          digest: batches.digest,
          lastError: batches.lastError,
          createdAt: batches.createdAt,
          updatedAt: batches.updatedAt,
        })
        .from(batches)
        .where(eq(batches.agreementRevisionId, revisionId))
        .orderBy(desc(batches.createdAt), desc(batches.id))
        .limit(limit)
        .offset(offset);
      const [pending] = await tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(outbox)
        .innerJoin(evidence, eq(evidence.id, outbox.evidenceId))
        .innerJoin(reservations, eq(reservations.id, evidence.reservationId))
        .where(and(eq(reservations.agreementRevisionId, revisionId), eq(outbox.state, "pending")));
      return {
        enabled: Boolean(this.client),
        unbatchedEvidenceCount: pending?.count ?? 0,
        batches: rows,
      };
    });
  }

  async retry(actor: FederationActor, revisionId: string, batchId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      await this.authorizeAgreement(tx, actor, revisionId);
      const [batch] = await tx
        .select()
        .from(batches)
        .where(
          and(
            eq(batches.id, batchId),
            eq(batches.agreementRevisionId, revisionId),
            eq(batches.localOrgId, actor.orgId),
            eq(batches.issuerSiteId, this.signingKey.siteId),
          ),
        )
        .for("update");
      if (!batch || batch.state !== "needs_review") throw new FederationError("OPERATION_CONFLICT");
      const [attempt] = await this.latest(tx, batch.id);
      if (attempt?.stage === "proposal")
        await tx
          .update(attempts)
          .set({ stage: "abandoned", updatedAt: sql`clock_timestamp()` })
          .where(eq(attempts.id, attempt.id));
      await tx
        .update(batches)
        .set({
          state: "pending",
          lastError: null,
          nextAttemptAt: sql`clock_timestamp()`,
          leaseToken: null,
          leaseUntil: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(batches.id, batch.id));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        action: "federation.attestation.retry",
        target: batch.id,
        orgId: actor.orgId,
        diff: { after: { previousError: batch.lastError } },
      });
    });
  }

  private async authorizeAgreement(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [agreement] = await tx
      .select({ id: agreements.revisionId })
      .from(agreements)
      .where(
        and(
          eq(agreements.revisionId, revisionId),
          eq(agreements.localOrgId, actor.orgId),
          eq(agreements.targetSiteId, this.signingKey.siteId),
        ),
      );
    if (!agreement) throw new FederationError("AGREEMENT_UNAVAILABLE");
  }
}
