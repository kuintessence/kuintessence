import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialAgreements as contracts,
  federationAgreements,
  federationReservations,
  federationTerminalEvidence,
  federationWorkflowBindings,
  jobs,
  type PgDb,
  type PgTransaction,
  federationUsageReports as reports,
  federationCommercialSubmissions as submissions,
  federationUsageTasks as tasks,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialProposalInputSchema,
  type CommercialUsageGap,
  CommercialUsageSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  type FederationVerificationKey,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";
import { aggregateCommercialUsage } from "./usage-report";

type Task = typeof tasks.$inferSelect;
const terminalStates = ["completed", "failed", "cancelled"];

export class FederationUsageService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  /** Discovery only records work; no computation, signature, or network request occurs here. */
  async discover(): Promise<void> {
    const rows = await this.db
      .select({
        reservationId: federationReservations.id,
        localSiteId: contracts.localSiteId,
        localOrgId: contracts.localOrgId,
        agreementRevisionId: contracts.revisionId,
      })
      .from(federationWorkflowBindings)
      .innerJoin(
        federationReservations,
        eq(federationReservations.id, federationWorkflowBindings.reservationId),
      )
      .innerJoin(
        federationAgreements,
        eq(federationAgreements.revisionId, federationReservations.agreementRevisionId),
      )
      .innerJoin(
        contracts,
        and(
          eq(contracts.revisionId, federationReservations.agreementRevisionId),
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.localOrgId, federationAgreements.localOrgId),
        ),
      )
      .innerJoin(workflowRuns, eq(workflowRuns.id, federationWorkflowBindings.workflowRunId))
      .leftJoin(tasks, eq(tasks.reservationId, federationReservations.id))
      .where(
        and(
          isNull(tasks.reservationId),
          isNotNull(contracts.counterpartyJws),
          eq(federationAgreements.targetSiteId, this.signing.siteId),
          inArray(workflowRuns.status, terminalStates),
        ),
      )
      .orderBy(asc(federationReservations.id))
      .limit(8);
    if (rows.length) await this.db.insert(tasks).values(rows).onConflictDoNothing();
  }

  /** The report and optional ledger intent commit together; no remote I/O while holding locks. */
  async advanceNext(): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.localSiteId, this.signing.siteId),
            inArray(tasks.state, ["pending", "missing_data"]),
            sql`${tasks.nextAttemptAt} <= clock_timestamp()`,
          ),
        )
        .orderBy(asc(tasks.nextAttemptAt), asc(tasks.reservationId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!task) return false;
      await this.generate(tx, task);
      return true;
    });
  }

  private async review(
    tx: PgTransaction,
    task: Task,
    reason: string,
    gaps: CommercialUsageGap[] = [],
  ) {
    await tx
      .update(tasks)
      .set({
        state: gaps.length ? "missing_data" : "needs_review",
        lastError: reason,
        gaps,
        nextAttemptAt: sql`clock_timestamp() + interval '60 seconds'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(tasks.reservationId, task.reservationId));
  }

  private async generate(tx: PgTransaction, task: Task) {
    const [saved] = await tx
      .select({
        contract: contracts,
        reservation: federationReservations,
        agreement: federationAgreements,
        binding: federationWorkflowBindings,
        run: workflowRuns,
      })
      .from(contracts)
      .innerJoin(federationReservations, eq(federationReservations.id, task.reservationId))
      .innerJoin(
        federationAgreements,
        eq(federationAgreements.revisionId, federationReservations.agreementRevisionId),
      )
      .innerJoin(
        federationWorkflowBindings,
        eq(federationWorkflowBindings.reservationId, federationReservations.id),
      )
      .innerJoin(workflowRuns, eq(workflowRuns.id, federationWorkflowBindings.workflowRunId))
      .where(
        and(
          eq(contracts.localSiteId, task.localSiteId),
          eq(contracts.revisionId, task.agreementRevisionId),
        ),
      )
      .for("share", { of: [workflowRuns, contracts] });
    if (!saved) return this.review(tx, task, "EVIDENCE_CONFLICT");
    const { contract, reservation, agreement, binding, run } = saved;
    const parsedTerms = CommercialAgreementSchema.safeParse(contract.terms);
    if (!parsedTerms.success) return this.review(tx, task, "CONTRACT_INVALID");
    const terms = parsedTerms.data;
    if (
      !contract.counterpartyJws ||
      contract.localOrgId !== task.localOrgId ||
      agreement.localOrgId !== task.localOrgId ||
      agreement.targetSiteId !== this.signing.siteId ||
      terms.agreement.targetSiteId !== this.signing.siteId ||
      federationMaterialDigest(terms.agreement) !== federationMaterialDigest(agreement.terms) ||
      federationMaterialDigest(binding.snapshot) !== binding.snapshotDigest ||
      binding.snapshot.requestDigest !== reservation.requestDigest ||
      run.input?.federationReservationId !== reservation.id ||
      run.submittedBy !== binding.snapshot.identity.userId
    )
      return this.review(tx, task, "EVIDENCE_CONFLICT");
    if (!terminalStates.includes(run.status) || !run.completedAt)
      return this.review(tx, task, "EXECUTION_NOT_TERMINAL");
    const rows = await tx
      .select({
        jobId: workflowExecutionJobs.jobId,
        status: jobs.status,
        evidence: federationTerminalEvidence,
      })
      .from(workflowExecutionJobs)
      .innerJoin(jobs, eq(jobs.id, workflowExecutionJobs.jobId))
      .leftJoin(federationTerminalEvidence, eq(federationTerminalEvidence.jobId, jobs.id))
      .where(eq(workflowExecutionJobs.runId, run.id))
      .orderBy(asc(workflowExecutionJobs.jobId))
      .limit(4097);
    if (rows.length > 4096) return this.review(tx, task, "EVIDENCE_LIMIT");
    if (rows.some((row) => !terminalStates.includes(row.status)))
      return this.review(tx, task, "EXECUTION_NOT_TERMINAL");
    const absent = rows.filter((row) => !row.evidence);
    if (absent.length)
      return this.review(tx, task, "MISSING_EVIDENCE", [
        {
          metric: "report",
          jobId: absent[0]?.jobId,
          missingJobs: absent.length,
          reason: "NO_JOB_EVIDENCE",
        },
      ]);
    const aggregate = aggregateCommercialUsage(
      terms,
      {
        reservationId: reservation.id,
        runId: run.id,
        taskId: reservation.taskId,
        attempt: reservation.attempt,
        requestDigest: reservation.requestDigest,
        executionSnapshotDigest: binding.snapshotDigest,
      },
      rows.flatMap((row) => (row.evidence ? [row.evidence] : [])),
    );
    if (aggregate.state === "missing_data")
      return this.review(tx, task, "MISSING_ACCOUNTING", aggregate.gaps);
    if (aggregate.state === "needs_review") return this.review(tx, task, aggregate.reason);
    const [time] = await tx
      .select({ now: sql<Date>`clock_timestamp()` })
      .from(tasks)
      .where(eq(tasks.reservationId, task.reservationId));
    const now = new Date(time?.now ?? NaN);
    const periodStart = run.createdAt,
      periodEnd = run.completedAt;
    if (
      !Number.isFinite(now.getTime()) ||
      periodStart >= periodEnd ||
      periodEnd > now ||
      periodStart < new Date(terms.agreement.validFrom) ||
      periodEnd > new Date(terms.agreement.validUntil)
    )
      return this.review(tx, task, "REPORTING_INTERVAL_INVALID");
    const report = CommercialUsageSchema.parse({
      protocolVersion: 1,
      kind: "commercial-usage",
      reportId: randomUUID(),
      domainId: terms.domainId,
      agreementRevisionId: task.agreementRevisionId,
      agreementDigest: contract.digest,
      sourceSiteId: terms.agreement.sourceSiteId,
      targetSiteId: this.signing.siteId,
      taskId: reservation.taskId,
      attempt: reservation.attempt,
      salt: randomBytes(32).toString("hex"),
      reportedAt: now.toISOString(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      measurements: aggregate.measurements,
    });
    let key: FederationVerificationKey;
    try {
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
      key = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx);
      if (!key.allowedKinds.includes("commercial-usage"))
        throw new FederationError("UNTRUSTED_IDENTITY");
    } catch (error) {
      if (error instanceof FederationError) return this.review(tx, task, error.code);
      throw error;
    }
    const reportJws = await signFederationMessage(CommercialUsageSchema, report, this.signing);
    let verified: Awaited<ReturnType<typeof verifyFederationMessage>>;
    try {
      verified = await verifyFederationMessage(CommercialUsageSchema, reportJws, key, now);
    } catch (error) {
      if (error instanceof FederationError) return this.review(tx, task, error.code);
      throw error;
    }
    await tx.insert(reports).values({
      id: report.reportId,
      reservationId: task.reservationId,
      number: 1,
      report,
      reportJws,
      digest: verified.digest,
      evidenceSet: aggregate.evidenceSet,
    });
    if (terms.agreement.mode !== "bilateral_direct")
      await tx.insert(submissions).values({
        id: randomUUID(),
        localSiteId: this.signing.siteId,
        agreementRevisionId: task.agreementRevisionId,
        input: CommercialProposalInputSchema.parse({
          operation: "record-usage",
          domainId: terms.domainId,
          recordId: report.reportId,
          digest: verified.digest,
          envelope: { providerJws: reportJws },
        }),
      });
    await tx
      .update(tasks)
      .set({ state: "reported", gaps: [], lastError: null, updatedAt: sql`clock_timestamp()` })
      .where(eq(tasks.reservationId, task.reservationId));
  }

  async list(actor: FederationActor, revisionId: string, limit: number, offset: number) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.authorizeContract(tx, actor, revisionId);
      return tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.localSiteId, this.signing.siteId),
            eq(tasks.localOrgId, actor.orgId),
            eq(tasks.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(desc(tasks.createdAt), desc(tasks.reservationId))
        .limit(limit)
        .offset(offset);
    });
  }
  async get(actor: FederationActor, revisionId: string, reservationId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      const task = await this.localTask(tx, actor, revisionId, reservationId);
      const records = await tx
        .select({
          id: reports.id,
          number: reports.number,
          report: reports.report,
          reportJws: reports.reportJws,
          digest: reports.digest,
          evidenceSet: reports.evidenceSet,
          createdAt: reports.createdAt,
          submissionId: submissions.id,
          ledgerState: submissions.state,
          lastError: submissions.lastError,
        })
        .from(reports)
        .leftJoin(
          submissions,
          and(
            eq(submissions.localSiteId, this.signing.siteId),
            sql`${submissions.input}->>'operation' = 'record-usage'`,
            sql`${submissions.input}->>'recordId' = ${reports.id}::text`,
          ),
        )
        .where(eq(reports.reservationId, reservationId))
        .orderBy(desc(reports.number))
        .limit(100);
      return { task, reports: records };
    });
  }
  async retry(actor: FederationActor, revisionId: string, reservationId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const task = await this.localTask(tx, actor, revisionId, reservationId, true);
      if (!["missing_data", "needs_review"].includes(task.state))
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(tasks)
        .set({
          state: "pending",
          nextAttemptAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(tasks.reservationId, reservationId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.usage.retry",
        target: reservationId,
        diff: { after: { previousError: task.lastError } },
      });
    });
  }
  private async authorizeContract(tx: PgTransaction, actor: FederationActor, revisionId: string) {
    const [row] = await tx
      .select({ id: contracts.revisionId })
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.localOrgId, actor.orgId),
          eq(contracts.revisionId, revisionId),
        ),
      );
    if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
  }
  private async localTask(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    reservationId: string,
    lock = false,
  ) {
    await this.authorizeContract(tx, actor, revisionId);
    const query = tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.reservationId, reservationId),
          eq(tasks.localSiteId, this.signing.siteId),
          eq(tasks.localOrgId, actor.orgId),
          eq(tasks.agreementRevisionId, revisionId),
        ),
      );
    const [task] = await (lock ? query.for("update") : query);
    if (!task) throw new FederationError("ASSET_UNAVAILABLE");
    return task;
  }
}
