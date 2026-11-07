import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  federationCommercialAgreements as contracts,
  federationAccountingCollections,
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
  type CommercialAgreement,
  CommercialAgreementSchema,
  CommercialProposalInputSchema,
  type CommercialUsage,
  type CommercialUsageCorrectionEvidence,
  CommercialUsageCorrectionEvidenceSchema,
  type CommercialUsageCorrectionInput,
  CommercialUsageCorrectionInputSchema,
  type CommercialUsageEvidenceSet,
  type CommercialUsageGap,
  CommercialUsageSchema,
} from "@kuintessence/shared/federation/commercial";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
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
        collection: federationAccountingCollections,
      })
      .from(workflowExecutionJobs)
      .innerJoin(jobs, eq(jobs.id, workflowExecutionJobs.jobId))
      .leftJoin(federationTerminalEvidence, eq(federationTerminalEvidence.jobId, jobs.id))
      .leftJoin(federationAccountingCollections, eq(federationAccountingCollections.jobId, jobs.id))
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
      rows.flatMap((row) =>
        row.evidence
          ? [
              {
                ...row.evidence,
                ...(row.collection?.observation && row.collection.digest
                  ? {
                      accountingObservation: {
                        observation: row.collection.observation,
                        digest: row.collection.digest,
                      },
                    }
                  : {}),
              },
            ]
          : [],
      ),
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
    try {
      await this.saveReport(tx, task, report, aggregate.evidenceSet, 1, now, terms.agreement.mode);
    } catch (error) {
      if (error instanceof FederationError) return this.review(tx, task, error.code);
      throw error;
    }
    await tx
      .update(tasks)
      .set({ state: "reported", gaps: [], lastError: null, updatedAt: sql`clock_timestamp()` })
      .where(eq(tasks.reservationId, task.reservationId));
  }

  private async saveReport(
    tx: PgTransaction,
    task: Task,
    report: CommercialUsage,
    evidenceSet: CommercialUsageEvidenceSet,
    number: number,
    now: Date,
    mode: CommercialAgreement["agreement"]["mode"],
    correctionEvidence?: CommercialUsageCorrectionEvidence,
  ) {
    await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
    const key = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx);
    if (!key.allowedKinds.includes("commercial-usage"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const reportJws = await signFederationMessage(CommercialUsageSchema, report, this.signing);
    const verified = await verifyFederationMessage(CommercialUsageSchema, reportJws, key, now);
    const [saved] = await tx
      .insert(reports)
      .values({
        id: report.reportId,
        reservationId: task.reservationId,
        number,
        report,
        reportJws,
        digest: verified.digest,
        evidenceSet,
        correctionEvidence,
      })
      .returning();
    if (!saved) throw new FederationError("OPERATION_CONFLICT");
    if (mode !== "bilateral_direct")
      await tx.insert(submissions).values({
        id: randomUUID(),
        localSiteId: this.signing.siteId,
        agreementRevisionId: task.agreementRevisionId,
        input: CommercialProposalInputSchema.parse({
          operation: "record-usage",
          domainId: report.domainId,
          recordId: report.reportId,
          digest: verified.digest,
          envelope: { providerJws: reportJws },
        }),
      });
    return saved;
  }

  async correct(
    actor: FederationActor,
    revisionId: string,
    reservationId: string,
    raw: CommercialUsageCorrectionInput,
  ) {
    const input = CommercialUsageCorrectionInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const task = await this.localTask(tx, actor, revisionId, reservationId, true);
      if (task.state !== "reported") throw new FederationError("OPERATION_CONFLICT");
      const [existing] = await tx.select().from(reports).where(eq(reports.id, input.reportId));
      if (existing) {
        if (
          existing.reservationId !== reservationId ||
          !existing.correctionEvidence ||
          federationMaterialDigest(existing.correctionEvidence.declaration) !==
            federationMaterialDigest(input)
        )
          throw new FederationError("OPERATION_CONFLICT");
        return existing;
      }
      const [previous] = await tx
        .select()
        .from(reports)
        .where(eq(reports.reservationId, reservationId))
        .orderBy(desc(reports.number))
        .limit(1);
      if (!previous || previous.id !== input.correctionOf || previous.number >= 2147483647)
        throw new FederationError("OPERATION_CONFLICT");
      const [contract] = await tx
        .select()
        .from(contracts)
        .where(
          and(eq(contracts.localSiteId, task.localSiteId), eq(contracts.revisionId, revisionId)),
        );
      if (!contract) throw new FederationError("AGREEMENT_UNAVAILABLE");
      const terms = CommercialAgreementSchema.parse(contract.terms);
      if (
        terms.agreement.targetSiteId !== this.signing.siteId ||
        previous.report.agreementDigest !== contract.digest ||
        input.measurements.length !== terms.prices.length ||
        !input.measurements.every((measurement) =>
          terms.prices.some(
            (price) =>
              price.metric === measurement.metric &&
              price.quantityUnit === measurement.quantityUnit,
          ),
        )
      )
        throw new FederationError("INVALID_MESSAGE");
      const [time] = await tx
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(tasks)
        .where(eq(tasks.reservationId, reservationId));
      const now = new Date(time?.now ?? NaN);
      if (!Number.isFinite(now.getTime()) || now < new Date(previous.report.reportedAt))
        throw new FederationError("OPERATION_CONFLICT");
      const correctionEvidence = CommercialUsageCorrectionEvidenceSchema.parse({
        version: 1,
        kind: "provider-technical-correction",
        reservationId,
        previousDigest: previous.digest,
        recordedAt: now.toISOString(),
        salt: randomBytes(32).toString("hex"),
        declaration: input,
      });
      const digest = federationMaterialDigest(correctionEvidence);
      const report = CommercialUsageSchema.parse({
        ...previous.report,
        reportId: input.reportId,
        correctionOf: previous.id,
        reportedAt: now.toISOString(),
        salt: randomBytes(32).toString("hex"),
        measurements: input.measurements.map(({ supportingEvidenceDigest: _, ...measurement }) => ({
          ...measurement,
          evidenceDigest: digest,
        })),
      });
      const saved = await this.saveReport(
        tx,
        task,
        report,
        previous.evidenceSet,
        previous.number + 1,
        now,
        terms.agreement.mode,
        correctionEvidence,
      );
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.usage.correct",
        target: input.reportId,
        diff: { after: { correctionOf: previous.id, digest: saved.digest } },
      });
      return saved;
    });
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
  async get(
    actor: FederationActor,
    revisionId: string,
    reservationId: string,
    limit = 100,
    offset = 0,
  ) {
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
          correctionEvidence: reports.correctionEvidence,
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
        .limit(limit + 1)
        .offset(offset);
      return { task, reports: records.slice(0, limit), hasMore: records.length > limit };
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
      await tx
        .update(federationAccountingCollections)
        .set({ state: "pending", lastError: null, nextAttemptAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(federationAccountingCollections.state, "needs_review"),
            inArray(
              federationAccountingCollections.jobId,
              tx
                .select({ id: federationTerminalEvidence.jobId })
                .from(federationTerminalEvidence)
                .where(eq(federationTerminalEvidence.reservationId, reservationId)),
            ),
          ),
        );
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
