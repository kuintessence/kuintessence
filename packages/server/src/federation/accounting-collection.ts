import { randomUUID } from "node:crypto";
import {
  federationAccountingCollections as collections,
  federationCommercialAgreements as contracts,
  federationTerminalEvidence as evidence,
  jobs,
  type PgDb,
  federationUsageTasks as tasks,
} from "@kuintessence/db";
import {
  type FederationAccountingRequest,
  FederationAccountingRequestSchema,
  FederationAccountingResponseSchema,
  type FederationTerminalEvidence,
} from "@kuintessence/shared/federation";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { aggregateCommercialUsage, type UsageEvidence } from "./usage-report";

function scope(value: FederationTerminalEvidence) {
  return {
    reservationId: value.reservationId,
    runId: value.runId,
    taskId: value.taskId,
    attempt: value.attempt,
    requestDigest: value.requestDigest,
    executionSnapshotDigest: value.executionSnapshotDigest,
  };
}

/** Server owns durable retries; Agent only answers read-only, identity-bound queries. */
export class FederationAccountingCollection {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly send: (agentId: string, request: FederationAccountingRequest) => boolean,
  ) {}

  async discover() {
    const rows = await this.db
      .select({ original: evidence, terms: contracts.terms })
      .from(evidence)
      .innerJoin(tasks, eq(tasks.reservationId, evidence.reservationId))
      .innerJoin(
        contracts,
        and(
          eq(contracts.localSiteId, tasks.localSiteId),
          eq(contracts.revisionId, tasks.agreementRevisionId),
        ),
      )
      .leftJoin(collections, eq(collections.jobId, evidence.jobId))
      .where(
        and(
          eq(tasks.localSiteId, this.siteId),
          eq(tasks.state, "missing_data"),
          isNull(collections.jobId),
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements(${contracts.terms}->'prices') AS price
            WHERE (price->>'metric' = 'cpu.time' AND price->>'quantityUnit' = 'cpu-millisecond' AND ${evidence.evidence}->'accounting'->>'cpuTimeMilliseconds' IS NULL)
               OR (price->>'metric' = 'job.elapsed' AND price->>'quantityUnit' = 'job-millisecond' AND ${evidence.evidence}->'accounting'->>'elapsedMilliseconds' IS NULL)
               OR (price->>'metric' = 'cpu.allocated' AND price->>'quantityUnit' = 'core-millisecond' AND (${evidence.evidence}->'accounting'->>'elapsedMilliseconds' IS NULL OR ${evidence.evidence}->'accounting'->>'allocatedCpus' IS NULL))
          )`,
        ),
      )
      .orderBy(asc(evidence.jobId))
      .limit(64);
    for (const row of rows) {
      const result = aggregateCommercialUsage(row.terms, scope(row.original.evidence), [
        row.original,
      ]);
      if (result.state === "needs_review") {
        await this.db
          .insert(collections)
          .values({ jobId: row.original.jobId, state: "needs_review", lastError: result.reason })
          .onConflictDoNothing();
        continue;
      }
      if (
        result.state !== "missing_data" ||
        !result.gaps.some((g) => g.reason === "MISSING_ACCOUNTING")
      )
        continue;
      await this.db.insert(collections).values({ jobId: row.original.jobId }).onConflictDoNothing();
    }
  }

  async advanceNext(): Promise<boolean> {
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ work: collections, original: evidence, job: jobs })
        .from(collections)
        .innerJoin(evidence, eq(evidence.jobId, collections.jobId))
        .innerJoin(tasks, eq(tasks.reservationId, evidence.reservationId))
        .innerJoin(jobs, eq(jobs.id, evidence.jobId))
        .where(
          and(
            eq(tasks.localSiteId, this.siteId),
            eq(collections.state, "pending"),
            sql`${collections.nextAttemptAt} <= clock_timestamp()`,
            sql`(${collections.leaseUntil} IS NULL OR ${collections.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(collections.nextAttemptAt), asc(collections.jobId))
        .limit(1)
        .for("update", { of: collections, skipLocked: true });
      if (!row) return;
      const original = row.original.evidence;
      if (
        !original.scheduler.agentId ||
        !original.scheduler.jobId ||
        row.job.agentId !== original.scheduler.agentId ||
        row.job.schedulerJobId !== original.scheduler.jobId ||
        row.job.dispatchEpoch !== original.dispatchEpoch ||
        !["completed", "failed", "cancelled"].includes(row.job.status) ||
        !["slurm", "pbs-pro"].includes(original.scheduler.type ?? "")
      ) {
        await tx
          .update(collections)
          .set({ state: "needs_review", lastError: "ACCOUNTING_IDENTITY_UNAVAILABLE" })
          .where(eq(collections.jobId, row.job.id));
        return { skipped: true as const };
      }
      const [time] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(collections)
        .where(eq(collections.jobId, row.job.id));
      const issued = new Date(time?.now ?? NaN),
        expires = new Date(issued.getTime() + 60000);
      const request = FederationAccountingRequestSchema.parse({
        version: 1,
        requestId: randomUUID(),
        jobId: row.job.id,
        dispatchEpoch: original.dispatchEpoch,
        schedulerJobId: original.scheduler.jobId,
        originalEvidenceDigest: row.original.digest,
        issuedAt: issued.toISOString(),
        expiresAt: expires.toISOString(),
      });
      await tx
        .update(collections)
        .set({
          requestId: request.requestId,
          issuedAt: issued,
          leaseUntil: expires,
          nextAttemptAt: expires,
          lastError: "ACCOUNTING_PENDING",
        })
        .where(eq(collections.jobId, row.job.id));
      return { skipped: false as const, request, agentId: original.scheduler.agentId };
    });
    if (!claim) return false;
    if (claim.skipped) return true;
    let sent = false;
    try {
      sent = this.send(claim.agentId, claim.request);
    } finally {
      if (!sent)
        await this.db
          .update(collections)
          .set({ leaseUntil: null, lastError: "AGENT_UNAVAILABLE" })
          .where(
            and(
              eq(collections.jobId, claim.request.jobId),
              eq(collections.requestId, claim.request.requestId),
              eq(collections.state, "pending"),
            ),
          );
    }
    return true;
  }

  async receive(agentId: string, body: string): Promise<void> {
    if (body.length > 32768) throw new Error("Accounting response too large");
    const response = FederationAccountingResponseSchema.parse(JSON.parse(body));
    const request = response.request;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          work: collections,
          original: evidence,
          job: jobs,
          task: tasks,
          terms: contracts.terms,
        })
        .from(collections)
        .innerJoin(evidence, eq(evidence.jobId, collections.jobId))
        .innerJoin(tasks, eq(tasks.reservationId, evidence.reservationId))
        .innerJoin(
          contracts,
          and(
            eq(contracts.localSiteId, tasks.localSiteId),
            eq(contracts.revisionId, tasks.agreementRevisionId),
          ),
        )
        .innerJoin(jobs, eq(jobs.id, evidence.jobId))
        .where(and(eq(collections.jobId, request.jobId), eq(tasks.localSiteId, this.siteId)))
        .for("update", { of: [collections, jobs] });
      if (!row || row.work.state !== "pending" || row.work.requestId !== request.requestId) return;
      const original = row.original.evidence;
      if (
        row.job.agentId !== agentId ||
        original.scheduler.agentId !== agentId ||
        row.job.schedulerJobId !== request.schedulerJobId ||
        original.scheduler.jobId !== request.schedulerJobId ||
        !["completed", "failed", "cancelled"].includes(row.job.status) ||
        row.job.dispatchEpoch !== request.dispatchEpoch ||
        original.dispatchEpoch !== request.dispatchEpoch ||
        row.original.digest !== request.originalEvidenceDigest ||
        row.work.issuedAt?.toISOString() !== request.issuedAt ||
        row.work.leaseUntil?.toISOString() !== request.expiresAt
      )
        throw new Error("Accounting response identity mismatch");
      const [time] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(collections)
        .where(eq(collections.jobId, request.jobId));
      const now = new Date(time?.now ?? NaN);
      if (!row.work.leaseUntil || row.work.leaseUntil <= now) return;
      const defer = async (reason: string, review = false) => {
        await tx
          .update(collections)
          .set({
            state: review ? "needs_review" : "pending",
            lastError: reason,
            leaseUntil: null,
            nextAttemptAt: new Date(now.getTime() + 60000),
          })
          .where(eq(collections.jobId, request.jobId));
      };
      if (response.state !== "observed") {
        await defer(
          response.state === "identity_mismatch"
            ? "ACCOUNTING_IDENTITY_MISMATCH"
            : "ACCOUNTING_UNAVAILABLE",
          response.state === "identity_mismatch",
        );
        return;
      }
      const sample = response.observation;
      if (
        sample.requestId !== request.requestId ||
        sample.jobId !== request.jobId ||
        sample.dispatchEpoch !== request.dispatchEpoch ||
        sample.originalEvidenceDigest !== request.originalEvidenceDigest ||
        Date.parse(sample.accounting.observedAt) < Date.parse(request.issuedAt) - 60000 ||
        Date.parse(sample.accounting.observedAt) > now.getTime() + 60000
      )
        throw new Error("Accounting observation binding mismatch");
      const digest = federationMaterialDigest(sample);
      const candidate: UsageEvidence = {
        ...row.original,
        accountingObservation: { observation: sample, digest },
      };
      const result = aggregateCommercialUsage(row.terms, scope(original), [candidate]);
      if (result.state !== "ready") {
        await defer(
          result.state === "needs_review" ? result.reason : "ACCOUNTING_INCOMPLETE",
          result.state === "needs_review",
        );
        return;
      }
      await tx
        .update(collections)
        .set({ state: "collected", observation: sample, digest, leaseUntil: null, lastError: null })
        .where(eq(collections.jobId, request.jobId));
      await tx
        .update(tasks)
        .set({ nextAttemptAt: now })
        .where(
          and(eq(tasks.reservationId, row.original.reservationId), eq(tasks.state, "missing_data")),
        );
    });
  }
}
