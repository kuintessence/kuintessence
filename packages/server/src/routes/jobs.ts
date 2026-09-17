import { type PgDb, softwareAssets, usecasePackages } from "@kuintessence/db";
import type { RoleName } from "@kuintessence/shared";
import {
  AppError,
  createLogger,
  DatasetSchema,
  ErrorCode,
  hasRole,
  JobStatus,
  type JobSubmit,
  JobSubmitSchema,
  type JobUsecaseSubmit,
  JobUsecaseSubmitSchema,
  usecase,
} from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type JobReadScope, jobVisibilityOrgScopes, resolveJobReadScope } from "../auth/job-access";
import { jobProviderTuple, jobSubmissionTuples } from "../authz/projection";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { makeAliasRecorder } from "../desensitize/alias-recorder";
import { loadDesensitizeConfig } from "../desensitize/config-loader";
import { applyDesensitizationToBody } from "../middleware/desensitize";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { parseUuidParam } from "../middleware/uuid-param";
import { kqValidator } from "../middleware/validator";
import { PgDataPrerequisiteRepository } from "../services/data-prerequisite-repository-drizzle";
import { createPgDataSelectionValidator } from "../services/data-selection-validation";
import type { JobLogAccessAuditor, JobLogAccessScope } from "../services/job-log-access-auditor";
import { type JobLogsService, JobLogsUnavailableError } from "../services/job-logs-service";
import type { JobListOptions, JobService } from "../services/job-service";
import type {
  LicensePolicySnapshot,
  LicenseRuntimeGovernanceService,
} from "../services/license-runtime-governance";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";
import { SelectableDatasetService } from "../services/selectable-datasets";
import { assertUsecasePackageExecutionAccess } from "../services/usecase-execution-authorizer";

const JobListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z
    .enum([
      JobStatus.PENDING,
      JobStatus.QUEUED,
      JobStatus.RUNNING,
      JobStatus.COMPLETED,
      JobStatus.FAILED,
      JobStatus.CANCELLED,
    ])
    .optional(),
  q: z.string().trim().max(200).optional(),
  agentId: z.string().trim().min(1).max(255).optional(),
  scope: z.enum(["all", "owner", "consumer_admin", "provider_operator", "platform"]).default("all"),
});

const logger = createLogger("job-routes");

const JobLogsQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(5_000).default(1_000),
});

const DatasetOptionsQuerySchema = z.object({
  descriptor: z.string().trim().min(1).max(255),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(200).optional(),
});

const DatasetOptionValidationSchema = z.strictObject({
  descriptor: z.string().trim().min(1).max(255),
  input: DatasetSchema,
});

const TERMINAL_JOB_STATUSES = new Set<string>([
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
]);

type JobLogsTarget = {
  agentId: string;
  schedulerJobId: string;
  jobId: string;
  restrictedNoEgress: boolean;
  status: string;
  actorUserId: string;
  scope: JobLogAccessScope;
};

/**
 * REST routes for job management.
 *
 * Requires:
 * - authMiddleware to be applied upstream (provides c.get("user") with TokenPayload)
 * - principalBinder to be applied upstream (provides canonical principal.userId)
 *
 * After submission, the orchestrator runs the placement pipeline and (if an agent is
 * selected) dispatches the job over gRPC. The placement result is included in the 201
 * response so callers can inspect which agent won or which stages rejected the job.
 */
export interface JobRouteOptions {
  /** Stable salt for the `alias` action on job command/env. */
  aliasSalt?: string;
  authz?: AuthzService;
  defaultRunBase?: string;
  jobLogs?: Pick<JobLogsService, "get">;
  jobLogAccessAudit?: Pick<JobLogAccessAuditor, "record">;
  jobLogsPollIntervalMs?: number;
  governance?: LicenseRuntimeGovernanceService;
}

export function createJobRoutes(
  jobService: JobService,
  db: PgDb,
  orchestrator: PlacementOrchestrator,
  opts: JobRouteOptions = {},
) {
  const routes = new Hono();
  const aliasSalt = opts.aliasSalt ?? "kq-job-v1";
  const recordAlias = makeAliasRecorder(db);
  const resolveJobLogsTarget = async (c: ContextLike, id: string): Promise<JobLogsTarget> => {
    const viewer = requireCanonicalJobActor(c);
    const job = await jobService.getById(id);
    if (!job) {
      throw new AppError(ErrorCode.NOT_FOUND, "Job not found", 404);
    }
    const localScope = resolveLocalJobReadScope(viewer, job);
    const localAllowed = localScope !== null;
    const canView = await authorizeJobViewThroughSpice(
      c,
      opts.authz,
      job.id,
      viewer.userId,
      localAllowed,
    );
    if (!canView) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to view this job", 403);
    }
    if (job.restrictedNoEgress) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Logs are unavailable for restricted no-egress jobs",
        403,
      );
    }
    if (!job.agentId || !job.schedulerJobId) {
      throw new AppError(
        ErrorCode.JOB_DISPATCH_FAILED,
        "Job logs are unavailable before scheduler submission",
        409,
      );
    }
    const scope: JobLogAccessScope = localScope ?? "authorization_service";
    return {
      agentId: job.agentId,
      schedulerJobId: job.schedulerJobId,
      jobId: job.id,
      restrictedNoEgress: Boolean(job.restrictedNoEgress),
      status: job.status,
      actorUserId: viewer.userId,
      scope,
    };
  };
  const readJobLogs = async (target: JobLogsTarget, lines: number): Promise<string> => {
    if (!opts.jobLogs) {
      throw new AppError(ErrorCode.AGENT_OFFLINE, "Job logs service is unavailable", 503);
    }
    try {
      return await opts.jobLogs.get(
        target.agentId,
        target.schedulerJobId,
        lines,
        target.jobId,
        target.restrictedNoEgress,
      );
    } catch (error) {
      if (error instanceof JobLogsUnavailableError) {
        const terminal = TERMINAL_JOB_STATUSES.has(target.status);
        throw new AppError(
          ErrorCode.JOB_LOG_UNAVAILABLE,
          terminal
            ? "Job logs are unavailable for this terminal job"
            : "Job logs are not available yet",
          terminal ? 410 : 409,
          { state: terminal ? "terminal_unavailable" : "not_ready" },
        );
      }
      throw error;
    }
  };

  routes.post(
    "/jobs",
    kqValidator("json", JobSubmitSchema, "Invalid job submission body"),
    async (c) => {
      const data = c.req.valid("json");
      const submitter = requireCanonicalJobActor(c);
      const { job, placementResult } = await submitJobSpec({
        c,
        opts,
        db,
        jobService,
        orchestrator,
        data,
        submitter,
        route: "POST /jobs",
      });

      return c.json(
        {
          ...job,
          placement: {
            selectedAgentId: placementResult.selectedAgentId,
            rejections: placementResult.rejections,
          },
        },
        201,
      );
    },
  );

  routes.get(
    "/jobs/usecase/:id/dataset-options",
    kqValidator("query", DatasetOptionsQuerySchema, "Invalid Dataset options query"),
    async (c) => {
      const query = c.req.valid("query");
      const actor = requireCanonicalJobActor(c);
      const usecasePackageId = parseUuidParam(c.req.param("id"), "usecase package id");
      return c.json(await new SelectableDatasetService(db).list(usecasePackageId, actor, query));
    },
  );

  routes.post(
    "/jobs/usecase/:id/dataset-options/validate",
    kqValidator("json", DatasetOptionValidationSchema, "Invalid Dataset validation body"),
    async (c) => {
      const body = c.req.valid("json");
      const actor = requireCanonicalJobActor(c);
      const usecasePackageId = parseUuidParam(c.req.param("id"), "usecase package id");
      await new SelectableDatasetService(db).validate(usecasePackageId, actor, {
        descriptor: body.descriptor,
        dataset: body.input,
      });
      return c.json({ valid: true });
    },
  );

  routes.post(
    "/jobs/usecase/materialize",
    kqValidator("json", JobUsecaseSubmitSchema, "Invalid usecase job body"),
    async (c) => {
      const body = c.req.valid("json");
      requireCanonicalJobActor(c);
      const job = await materializeUsecaseJob(
        db,
        body,
        requireCanonicalJobActor(c),
        opts.governance,
      );
      return c.json({ job });
    },
  );

  routes.post(
    "/jobs/usecase/preview-placement",
    kqValidator("json", JobUsecaseSubmitSchema, "Invalid usecase job body"),
    async (c) => {
      const body = c.req.valid("json");
      const submitter = requireCanonicalJobActor(c);
      const job = await materializeUsecaseJob(db, body, submitter, opts.governance);
      await assertRawSoftwareRequirements(db, job, submitter, opts.governance);
      await validateJobSubmitIntent({
        c,
        opts,
        orchestrator,
        data: job,
        submitter,
        route: "POST /jobs/usecase/preview-placement",
      });
      const trace = await orchestrator.runWithTrace({
        job,
        userId: submitter.userId,
        userRole: submitter.role,
        orgId: submitter.orgId,
        preview: true,
      });
      return c.json(trace);
    },
  );

  routes.post(
    "/jobs/usecase",
    kqValidator("json", JobUsecaseSubmitSchema, "Invalid usecase job body"),
    async (c) => {
      const body = c.req.valid("json");
      const submitter = requireCanonicalJobActor(c);
      const data = await materializeUsecaseJob(db, body, submitter, opts.governance);
      const { job, placementResult } = await submitJobSpec({
        c,
        opts,
        db,
        jobService,
        orchestrator,
        data,
        submitter,
        route: "POST /jobs/usecase",
        trustedMaterialization: true,
      });
      return c.json(
        {
          ...job,
          placement: {
            selectedAgentId: placementResult.selectedAgentId,
            rejections: placementResult.rejections,
          },
        },
        201,
      );
    },
  );

  routes.get("/jobs", async (c) => {
    const parsed = JobListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
      status: c.req.query("status"),
      q: c.req.query("q"),
      agentId: c.req.query("agentId"),
      scope: c.req.query("scope"),
    });
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        400,
      );
    }
    const query = parsed.data;
    const listOptions: JobListOptions = {
      limit: query.limit,
      offset: query.offset,
    };
    if (query.status) {
      listOptions.status = query.status;
    }
    if (query.q) {
      listOptions.query = query.q;
    }
    if (query.agentId) {
      listOptions.agentId = query.agentId;
    }
    const viewer = requireCanonicalJobActor(c);
    const visibility = jobListVisibility(viewer, query.scope);
    if (opts.authz?.mode === "enforce") {
      try {
        listOptions.ids = await opts.authz.lookupResources({
          resourceType: "job",
          permission: "view",
          subject: { type: "user", id: viewer.userId },
        });
      } catch (err) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          `Authorization unavailable: ${err instanceof Error ? err.message : String(err)}`,
          403,
        );
      }
    }
    const authorizationDefinesAllScope = opts.authz?.mode === "enforce" && query.scope === "all";
    if (visibility && !authorizationDefinesAllScope) listOptions.visibility = visibility;
    const page = await jobService.listPage(listOptions);
    const list = page.jobs;
    const visibleJobs = await filterJobsThroughSpice(c, opts.authz, list, viewer);
    const scopedJobs = visibleJobs.map((job) => ({
      ...job,
      accessScope: jobResponseScope(viewer, job, query.scope),
    }));
    // the list must apply the same desensitization as GET /jobs/:id,
    // per job (owner/platform_admin see cleartext; others go through the
    // framework, a no-op when globalEnabled is false). Without this the list is
    // a desensitization bypass that leaks fields the detail route redacts.
    if (hasRole(viewer.role, "platform_admin")) {
      return c.json({
        jobs: scopedJobs,
        total: page.total,
        limit: query.limit,
        offset: query.offset,
      });
    }
    const config = await loadDesensitizeConfig(db);
    const jobs = await Promise.all(
      scopedJobs.map((job) =>
        viewer.userId === job.submittedBy
          ? job
          : applyDesensitizationToBody(config, job, {
              resourceType: "job",
              viewerRole: viewer.role,
              viewerOrgId: viewer.orgId,
              resourceOwnerId: job.submittedBy,
              aliasSalt,
              recordAlias,
            }),
      ),
    );
    return c.json({
      jobs,
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    });
  });

  routes.get("/jobs/:id", async (c) => {
    const id = parseUuidParam(c.req.param("id"), "job id");
    const viewer = requireCanonicalJobActor(c);
    const job = await jobService.getById(id);
    if (!job) {
      throw new AppError(ErrorCode.NOT_FOUND, "Job not found", 404);
    }

    // desensitize sensitive fields when the viewer is neither
    // the job owner nor platform_admin. Owners always see their own command
    // and env vars; platform_admin bypasses the framework for incident
    // response. All other viewers go through the apply middleware, which
    // is itself a no-op when globalEnabled is false.
    //
    const isOwner = viewer.userId === job.submittedBy;
    const isPlatformAdmin = hasRole(viewer.role, "platform_admin");
    const localScope = resolveLocalJobReadScope(viewer, job);
    const localAllowed = localScope !== null;
    const canView = await authorizeJobViewThroughSpice(
      c,
      opts.authz,
      job.id,
      viewer.userId,
      localAllowed,
    );
    if (!canView) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to view this job", 403);
    }
    const response = { ...job, accessScope: localScope ?? "authorization_service" };
    if (isOwner || isPlatformAdmin) {
      return c.json(response);
    }

    const config = await loadDesensitizeConfig(db);
    const body = await applyDesensitizationToBody(config, response, {
      resourceType: "job",
      viewerRole: viewer.role,
      viewerOrgId: viewer.orgId,
      resourceOwnerId: job.submittedBy,
      aliasSalt,
      recordAlias,
    });
    return c.json(body);
  });

  routes.get("/jobs/:id/logs", async (c) => {
    const id = parseUuidParam(c.req.param("id"), "job id");
    const lines = parseJobLogsLines(c.req.query("lines"));
    const target = await resolveJobLogsTarget(c, id);
    await opts.jobLogAccessAudit?.record({
      actorUserId: target.actorUserId,
      jobId: id,
      access: "tail",
      scope: target.scope,
    });
    const text = await readJobLogs(target, lines);
    return c.json({ text });
  });

  routes.get("/jobs/:id/logs/stream", async (c) => {
    const id = parseUuidParam(c.req.param("id"), "job id");
    const lines = parseJobLogsLines(c.req.query("lines"));
    const target = await resolveJobLogsTarget(c, id);
    await opts.jobLogAccessAudit?.record({
      actorUserId: target.actorUserId,
      jobId: id,
      access: "stream",
      scope: target.scope,
    });
    const initialText = await readJobLogs(target, lines);
    const pollIntervalMs = opts.jobLogsPollIntervalMs ?? 3_000;

    return streamSSE(c, async (stream) => {
      let previousText = initialText;
      if (initialText) {
        await stream.writeSSE({ event: "log", data: initialText });
      }
      if (TERMINAL_JOB_STATUSES.has(target.status)) {
        await stream.writeSSE({ event: "end", data: target.status });
        return;
      }

      while (!stream.aborted && !c.req.raw.signal.aborted) {
        await stream.sleep(pollIntervalMs);
        if (stream.aborted || c.req.raw.signal.aborted) return;
        try {
          const currentTarget = await resolveJobLogsTarget(c, id);
          const currentText = await readJobLogs(currentTarget, lines);
          const delta = jobLogDelta(previousText, currentText);
          if (delta) {
            await stream.writeSSE({ event: "log", data: delta });
          } else {
            await stream.writeSSE({ event: "heartbeat", data: currentTarget.status });
          }
          previousText = currentText;
          if (TERMINAL_JOB_STATUSES.has(currentTarget.status)) {
            await stream.writeSSE({ event: "end", data: currentTarget.status });
            return;
          }
        } catch (error) {
          await stream.writeSSE({
            event: "error",
            data: error instanceof Error ? error.message : "Job logs stream failed",
          });
          return;
        }
      }
    });
  });

  // Cancelling is a state mutation — restrict to the job owner or platform_admin.
  // Reads are open (desensitized), so existence isn't secret: 403, not 404.
  routes.post("/jobs/:id/cancel", async (c) => {
    const id = parseUuidParam(c.req.param("id"), "job id");
    const caller = requireCanonicalJobActor(c);
    const existing = await jobService.getById(id);
    if (!existing) {
      throw new AppError(ErrorCode.NOT_FOUND, "Job not found", 404);
    }
    const isPlatformAdmin = hasRole(caller.role, "platform_admin");
    const localAllowed = isPlatformAdmin || existing.submittedBy === caller.userId;
    const subjectId = subjectIdForJobAuthz(opts.authz, caller.userId);
    if (!subjectId) {
      throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
    }
    const canCancel = await authorizeThroughSpice(c, opts.authz, localAllowed, {
      actorUserId: caller.userId,
      actorEmail: caller.email,
      resource: { type: "job", id },
      permission: "cancel",
      subject: { type: "user", id: subjectId },
      context: { route: "POST /jobs/:id/cancel" },
    });
    if (!canCancel) {
      throw new AppError(ErrorCode.FORBIDDEN, "You can only cancel your own jobs", 403);
    }
    const job = await jobService.cancel(id);
    // Propagate to the agent so it actually kills the scheduler job (scancel/
    // qdel) — without this the DB reads "cancelled" but the cluster job keeps
    // running until it finishes on its own (tbd #11). Only meaningful once the
    // job has been placed on an agent.
    if (job.agentId) {
      try {
        await orchestrator.cancelJob(job.agentId, id, job.revokedEpoch);
      } catch (error) {
        logger.warn(
          { agentId: job.agentId, error, jobId: id },
          "Immediate job cancellation delivery failed; durable outbox will retry",
        );
      }
    }
    return c.json(job);
  });

  // The placement trace contains agent IDs and stage reasons, not command/env
  // data, so it uses the same viewer ACL as the job.
  routes.get("/jobs/:id/placement", async (c) => {
    const id = parseUuidParam(c.req.param("id"), "job id");
    const viewer = requireCanonicalJobActor(c);
    const job = await jobService.getById(id);
    if (!job) {
      throw new AppError(ErrorCode.NOT_FOUND, "Job not found", 404);
    }
    const localAllowed = resolveLocalJobReadScope(viewer, job) !== null;
    const canView = await authorizeJobViewThroughSpice(
      c,
      opts.authz,
      job.id,
      viewer.userId,
      localAllowed,
    );
    if (!canView) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to view this job", 403);
    }
    const trace = await jobService.getPlacementTrace(id);
    if (!trace) {
      throw new AppError(ErrorCode.NOT_FOUND, "Placement trace not available for this job", 404);
    }
    return c.json(trace);
  });

  return routes;
}

async function submitJobSpec(input: {
  c: ContextLike;
  opts: JobRouteOptions;
  db: PgDb;
  jobService: JobService;
  orchestrator: PlacementOrchestrator;
  data: JobSubmit;
  submitter: {
    userId: string;
    role: RoleName;
    orgId: string | null;
    email: string | null;
  };
  route: string;
  trustedMaterialization?: boolean;
}) {
  const { c, opts, db, jobService, orchestrator, data, submitter, route, trustedMaterialization } =
    input;
  await validateJobSubmitIntent({ c, opts, orchestrator, data, submitter, route });
  await assertRawSoftwareRequirements(db, data, submitter, opts.governance);
  const queueId = data.schedulingStrategy?.queueId ?? null;
  const job = await jobService.submit(data, submitter.userId, {
    orgId: submitter.orgId,
    trustedMaterialization: trustedMaterialization === true,
  });
  const effectiveWorkingDir =
    data.workingDir ?? (opts.defaultRunBase ? `${opts.defaultRunBase}/${job.id}` : undefined);
  if (effectiveWorkingDir && !data.workingDir) {
    await jobService.setWorkingDir(job.id, effectiveWorkingDir);
  }
  const submittedJob = effectiveWorkingDir ? { ...job, workingDir: effectiveWorkingDir } : job;
  const dispatchData = effectiveWorkingDir ? { ...data, workingDir: effectiveWorkingDir } : data;
  await enqueueJobSubmitAuthorization(
    opts.authz,
    job.id,
    submitter.userId,
    submitter.orgId,
    queueId,
  );

  const placementResult = await orchestrator.placeAndDispatch({
    jobId: job.id,
    job: dispatchData,
    restrictedNoEgress: job.restrictedNoEgress,
    userId: submitter.userId,
    userRole: submitter.role,
    orgId: submitter.orgId,
  });
  const placedJob = placementResult.selectedAgentId ? await jobService.getById(job.id) : null;
  await enqueueJobProviderAuthorization(opts.authz, job.id, placedJob?.providerOrgId ?? null);
  return { job: submittedJob, placementResult };
}

async function assertRawSoftwareRequirements(
  db: PgDb,
  data: JobSubmit,
  submitter: { userId: string; orgId: string | null },
  governance?: LicenseRuntimeGovernanceService,
): Promise<void> {
  const requirements = data.softwareRequirements ?? [];
  if (requirements.length === 0) return;
  if (!governance) {
    throw new AppError(ErrorCode.FORBIDDEN, "Software governance is unavailable", 403);
  }
  const subjectIds = [submitter.userId, ...(submitter.orgId ? [submitter.orgId] : [])];
  for (const requirement of requirements) {
    const conditions = [
      eq(softwareAssets.kind, "spack-package"),
      eq(softwareAssets.name, requirement.name),
      eq(softwareAssets.lifecycle, "published"),
    ];
    if (requirement.assetId) conditions.push(eq(softwareAssets.id, requirement.assetId));
    if (requirement.version) conditions.push(eq(softwareAssets.version, requirement.version));
    const rows = await db
      .select()
      .from(softwareAssets)
      .where(and(...conditions))
      .limit(2);
    const asset = rows.length === 1 ? rows[0] : undefined;
    if (!asset) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Software prerequisites block job submission: GOVERNED_ASSET_UNAVAILABLE",
        403,
      );
    }
    const policy = await governance.getCanonicalLicensePolicy(asset.id);
    const assetKey = policy?.identifiers?.[0] ?? requirement.name;
    const blocks = await governance.evaluateLicense({
      assetKey,
      assetId: asset.id,
      policy:
        policy === null
          ? undefined
          : { ...policy, providerSourceInstallEntitlementRequired: false },
      providerEntitlementSubjectIds: [],
      consumerEntitlementSubjectIds: subjectIds,
      installRequested: requirement.installable ?? false,
    });
    if (blocks.length > 0) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        `Software prerequisites block job submission: ${blocks.map((block) => block.code).join(", ")}`,
        403,
      );
    }
  }
}

async function validateJobSubmitIntent(input: {
  c: ContextLike;
  opts: JobRouteOptions;
  orchestrator: PlacementOrchestrator;
  data: JobSubmit;
  submitter: {
    userId: string;
    role: RoleName;
    orgId: string | null;
    email: string | null;
  };
  route: string;
}) {
  const { c, opts, orchestrator, data, submitter, route } = input;
  await orchestrator.validateSchedulingIntent({
    job: data,
    userId: submitter.userId,
    userRole: submitter.role,
    orgId: submitter.orgId,
  });

  const queueId = data.schedulingStrategy?.queueId ?? null;
  if (!queueId) return;
  const canSubmit = await authorizeThroughSpice(c, opts.authz, true, {
    actorUserId: submitter.userId,
    actorEmail: submitter.email,
    resource: { type: "queue", id: queueId },
    permission: "submit",
    subject: { type: "user", id: submitter.userId },
    context: { route },
  });
  if (!canSubmit) {
    throw new AppError(ErrorCode.FORBIDDEN, "Not authorized to submit to this queue", 403);
  }
}

async function materializeUsecaseJob(
  db: PgDb,
  body: JobUsecaseSubmit,
  submitter: { userId: string; orgId: string | null; subject: string | null },
  governance?: LicenseRuntimeGovernanceService,
): Promise<JobSubmit> {
  const [row] = await db
    .select({
      id: usecasePackages.id,
      name: usecasePackages.name,
      version: usecasePackages.version,
      spec: usecasePackages.spec,
    })
    .from(usecasePackages)
    .where(eq(usecasePackages.id, body.usecasePackageId))
    .limit(1);
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, "Usecase package not found", 404);
  }
  await assertUsecasePackageExecutionAccess(db, row.id, submitter);
  try {
    const pkg = usecase.UsecasePackageSchema.parse(row.spec);
    await assertUsecaseLicenseRequirements(
      db,
      pkg,
      body.installMissingSoftware,
      submitter,
      governance,
    );
    const isGoverned = "softwareRef" in pkg;
    const dataAccess = new PgDataPrerequisiteRepository(db);
    await Promise.all(
      Object.values(body.dataInputs ?? {}).map(async (input) => {
        if (input.source !== "data-market") return;
        const canUse = await dataAccess.verifyAccess({
          actorUserId: submitter.userId,
          orgId: submitter.orgId,
          assetId: input.assetId,
          versionId: input.versionId,
        });
        if (!canUse) {
          throw new AppError(
            ErrorCode.FORBIDDEN,
            "Not authorized to use the selected Data Market version",
            403,
          );
        }
      }),
    );
    const dataSelections = isGoverned
      ? await createPgDataSelectionValidator(db).validateUsecase({
          pkg,
          dataInputs: body.dataInputs ?? {},
          ...(body.dataRequirements ? { dataRequirements: body.dataRequirements } : {}),
        })
      : [];
    const selectedDataInputs = Object.fromEntries(
      Object.entries(body.dataInputs ?? {}).map(([descriptor, input]) => {
        const selection = dataSelections.find((item) => item.descriptor === descriptor);
        return [
          descriptor,
          selection && input.targetPath === undefined
            ? { ...input, targetPath: selection.stagePath }
            : input,
        ];
      }),
    );
    const marketBackedLicensedMaterials = new Set(
      dataSelections.flatMap((selection) => selection.satisfiedLicensedMaterialSelectors),
    );
    const task = usecase.materialize({
      usecase: pkg.usecase,
      software: pkg.software,
      arguments: pkg.arguments,
      environments: pkg.environments,
      filesomeInputs: pkg.filesomeInputs,
      filesomeOutputs: pkg.filesomeOutputs,
      ...(isGoverned ? { dataRequirements: pkg.dataRequirements } : {}),
      licensedMaterials: isGoverned
        ? pkg.licensedMaterials.filter(
            (material) => !marketBackedLicensedMaterials.has(material.selector),
          )
        : [],
      inputs: body.inputs,
    });
    return {
      name: body.name,
      command: usecase.wrapCommand(task),
      resources: body.resources,
      ...(body.schedulingStrategy ? { schedulingStrategy: body.schedulingStrategy } : {}),
      ...(body.workingDir ? { workingDir: body.workingDir } : {}),
      ...(body.tags ? { tags: body.tags } : {}),
      envVars: task.envVars,
      softwareRequirements: softwareRequirementsFromUsecase(
        pkg.software,
        body.installMissingSoftware,
      ),
      appTemplateKey: `${row.name}@${row.version}`,
      usecasePackageId: row.id,
      usecasePackageName: row.name,
      usecasePackageVersion: row.version,
      usecaseInputs: body.inputs,
      ...(Object.keys(selectedDataInputs).length > 0 ? { dataInputs: selectedDataInputs } : {}),
      ...(body.dataRequirements ? { dataRequirements: body.dataRequirements } : {}),
      inputStaging: task.inputStaging,
      expectedOutputs: task.expectedOutputs,
      ...(task.expectedOutputs.length > 0
        ? { fileOutputDescriptors: task.expectedOutputs.map((output) => output.descriptor) }
        : {}),
      ...(task.stdinText !== undefined ? { stdinText: task.stdinText } : {}),
      ...(task.licensedMaterials && task.licensedMaterials.length > 0
        ? { licensedMaterials: task.licensedMaterials }
        : {}),
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : "Invalid usecase input";
    throw new AppError(ErrorCode.VALIDATION_ERROR, message, 400);
  }
}

async function assertUsecaseLicenseRequirements(
  db: PgDb,
  pkg: usecase.UsecasePackage,
  installRequested: boolean,
  submitter: { userId: string; orgId: string | null },
  governance?: LicenseRuntimeGovernanceService,
): Promise<void> {
  if (!governance) return;
  if (!("softwareRef" in pkg)) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "License prerequisites require a governed usecase package with a software selector",
      403,
    );
  }
  const source = await loadSourceLicensePolicy(db, governance, pkg.softwareRef);
  const sourcePolicy = source.policy;
  const providerOrgId = pkg.softwareRef.providerOrgId ?? null;
  const subjectIds = [submitter.userId, ...(submitter.orgId ? [submitter.orgId] : [])];
  const blocks = (
    await Promise.all(
      pkg.licenseRequirements.map((requirement) =>
        governance.evaluateLicense({
          assetKey: sourcePolicy.identifiers?.[0] ?? requirement.identifier,
          assetId: source.assetId,
          policy: {
            classification: sourcePolicy.classification,
            identifiers: sourcePolicy.identifiers,
            provenance: sourcePolicy.provenance,
            acceptanceRequired:
              sourcePolicy.acceptanceRequired ||
              requirement.requiredEntitlements.includes("acceptance"),
            providerSourceInstallEntitlementRequired:
              providerOrgId !== null &&
              (sourcePolicy.providerSourceInstallEntitlementRequired ||
                requirement.requiredEntitlements.some(
                  (entitlement) =>
                    entitlement === "provider-source" || entitlement === "provider-install",
                )),
            consumerUseEntitlementRequired:
              sourcePolicy.consumerUseEntitlementRequired ||
              requirement.requiredEntitlements.includes("consumer-use"),
            autoInstallAllowed: sourcePolicy.autoInstallAllowed,
          },
          providerEntitlementSubjectIds: providerOrgId ? [providerOrgId] : [],
          consumerEntitlementSubjectIds: subjectIds,
          installRequested,
        }),
      ),
    )
  ).flat();
  if (blocks.length > 0) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      `License prerequisites block usecase submission: ${blocks.map((block) => block.code).join(", ")}`,
      403,
    );
  }
}

async function loadSourceLicensePolicy(
  db: PgDb,
  governance: LicenseRuntimeGovernanceService,
  ref: { source: string; name: string; version: string; providerOrgId?: string },
): Promise<{ assetId: string; policy: LicensePolicySnapshot }> {
  const conditions = [
    eq(softwareAssets.kind, "spack-package"),
    eq(softwareAssets.source, ref.source),
    eq(softwareAssets.name, ref.name),
    eq(softwareAssets.version, ref.version),
    eq(softwareAssets.lifecycle, "published"),
  ];
  if (ref.providerOrgId) conditions.push(eq(softwareAssets.providerOrgId, ref.providerOrgId));
  const rows = await db
    .select()
    .from(softwareAssets)
    .where(and(...conditions))
    .limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "License prerequisites block usecase submission: LICENSE_POLICY_UNAVAILABLE",
      403,
    );
  }
  const policy = await governance.getCanonicalLicensePolicy(rows[0].id);
  if (!policy) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "License prerequisites block usecase submission: LICENSE_POLICY_UNAVAILABLE",
      403,
    );
  }
  return { assetId: rows[0].id, policy };
}

function softwareRequirementsFromUsecase(
  software: usecase.SoftwareSpec,
  installable: boolean,
): JobSubmit["softwareRequirements"] {
  if (software.kind !== "Spack") return undefined;
  return [
    {
      name: software.name,
      ...(software.version ? { version: software.version } : {}),
      installable,
    },
  ];
}

function parseJobLogsLines(value: string | undefined): number {
  const parsed = JobLogsQuerySchema.safeParse({ lines: value });
  if (parsed.success) return parsed.data.lines;
  throw new AppError(
    ErrorCode.VALIDATION_ERROR,
    parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    400,
  );
}

export function jobLogDelta(previous: string, current: string): string {
  if (!previous) return current;
  if (current.startsWith(previous)) return current.slice(previous.length);
  if (!current) return "";

  const prefix = new Uint32Array(current.length);
  for (let index = 1, matched = 0; index < current.length; index += 1) {
    while (matched > 0 && current[index] !== current[matched]) {
      matched = prefix[matched - 1] ?? 0;
    }
    if (current[index] === current[matched]) matched += 1;
    prefix[index] = matched;
  }

  let matched = 0;
  const start = Math.max(0, previous.length - current.length);
  for (let index = start; index < previous.length; index += 1) {
    while (matched > 0 && previous[index] !== current[matched]) {
      matched = prefix[matched - 1] ?? 0;
    }
    if (previous[index] === current[matched]) matched += 1;
    if (matched === current.length && index < previous.length - 1) {
      matched = prefix[matched - 1] ?? 0;
    }
  }
  return current.slice(matched);
}

async function enqueueJobSubmitAuthorization(
  authz: AuthzService | undefined,
  jobId: string,
  userId: string,
  orgId: string | null,
  queueId: string | null,
): Promise<void> {
  const tuples = jobSubmissionTuples({ jobId, userId, orgId, queueId });
  if (authz?.mode === "enforce") {
    await authz.writeRelationships(tuples);
  }
  await authz?.enqueueMany(tuples);
}

async function enqueueJobProviderAuthorization(
  authz: AuthzService | undefined,
  jobId: string,
  providerOrgId: string | null,
): Promise<void> {
  if (!authz || !providerOrgId) return;
  await authz.enqueue(jobProviderTuple({ jobId, providerOrgId }));
}

async function authorizeThroughSpice(
  c: ContextLike,
  authz: AuthzService | undefined,
  localAllowed: boolean,
  check: AuthzCheck,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  if (authz.mode === "shadow") {
    await authz.shadowCheck({ ...check, localAllowed });
    return localAllowed;
  }
  try {
    await authz.requirePermission(check, isPlatformFallbackPrincipal(c));
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) return false;
    throw err;
  }
}

async function filterJobsThroughSpice<
  T extends {
    id: string;
    submittedBy?: string | null;
    orgId?: string | null;
    agentId?: string | null;
  },
>(c: ContextLike, authz: AuthzService | undefined, jobs: T[], actor: JobActor): Promise<T[]> {
  const visible: T[] = [];
  for (const job of jobs) {
    const localAllowed = resolveLocalJobReadScope(actor, job) !== null;
    if (await authorizeJobViewThroughSpice(c, authz, job.id, actor.userId, localAllowed)) {
      visible.push(job);
    }
  }
  return visible;
}

async function authorizeJobViewThroughSpice(
  c: ContextLike,
  authz: AuthzService | undefined,
  jobId: string,
  actorUserId: string | null,
  localAllowed: boolean,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  const actor = boundJobActor(c);
  const subjectId = subjectIdForJobAuthz(authz, actorUserId);
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId,
    actorEmail: actor.email,
    resource: { type: "job", id: jobId },
    permission: "view",
    subject: { type: "user", id: subjectId },
    context: { route: "job#view" },
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck({ ...check, localAllowed });
    return localAllowed;
  }
  try {
    await authz.requirePermission(check, isPlatformFallbackPrincipal(c));
    return true;
  } catch (err) {
    if (
      err instanceof AppError &&
      err.statusCode === 403 &&
      err.message === "Authorization denied"
    ) {
      return false;
    }
    throw err;
  }
}

type ContextLike = {
  get: (key: "user") => { email: string; role: string };
};

interface JobActor {
  userId: string | null;
  role: RoleName;
  orgId: string | null;
  email: string | null;
  memberships: BoundPrincipal["memberships"];
}

function isPlatformFallbackPrincipal(c: ContextLike): boolean {
  return hasRole(boundJobRole(c), "platform_admin");
}

function boundJobRole(c: ContextLike, dbRole?: string | null): RoleName {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return (principal?.role ?? dbRole ?? "guest") as RoleName;
}

function boundJobActor(c: ContextLike): JobActor {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return {
    userId: principal?.userId ?? null,
    role: (principal?.role ?? "guest") as RoleName,
    orgId: principal?.orgId ?? (principal?.orgIds ?? [])[0] ?? null,
    email: principal?.email ?? null,
    memberships: principal?.memberships ?? [],
  };
}

function requireCanonicalJobActor(c: ContextLike): {
  userId: string;
  role: RoleName;
  orgId: string | null;
  email: string | null;
  subject: string | null;
  memberships: BoundPrincipal["memberships"];
} {
  const actor = boundJobActor(c);
  if (!actor.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  if (!hasRole(actor.role, "user")) {
    throw new AppError(ErrorCode.FORBIDDEN, "Job access requires a user role", 403);
  }
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return { ...actor, userId: actor.userId, subject: principal?.sub ?? null };
}

function jobListVisibility(
  actor: JobActor & { userId: string },
  scope: "all" | JobReadScope,
): JobListOptions["visibility"] | null {
  if (scope === "platform" && hasRole(actor.role, "platform_admin")) return null;
  if (scope === "all" && hasRole(actor.role, "platform_admin")) return null;
  const orgScopes = jobVisibilityOrgScopes(actor.memberships);
  return {
    userId: actor.userId,
    includeOwner: scope === "all" || scope === "owner",
    consumerAdminOrgIds:
      scope === "all" || scope === "consumer_admin" ? orgScopes.consumerAdminOrgIds : [],
    providerOrgIds:
      scope === "all" || scope === "provider_operator" ? orgScopes.providerOperatorOrgIds : [],
  };
}

function jobResponseScope(
  actor: JobActor & { userId: string },
  job: {
    submittedBy?: string | null;
    orgId?: string | null;
    providerOrgId?: string | null;
  },
  requestedScope: "all" | JobReadScope,
): JobLogAccessScope {
  if (requestedScope !== "all") return requestedScope;
  return resolveLocalJobReadScope(actor, job) ?? "authorization_service";
}

function resolveLocalJobReadScope(
  actor: JobActor,
  job: {
    submittedBy?: string | null;
    orgId?: string | null;
    agentId?: string | null;
    providerOrgId?: string | null;
  },
) {
  if (!actor.userId) return null;
  const principal = {
    userId: actor.userId,
    role: actor.role,
    memberships: actor.memberships,
  };
  const resource = {
    submittedBy: job.submittedBy ?? null,
    consumerOrgId: job.orgId ?? null,
    providerOrgId: job.providerOrgId ?? null,
  };
  return resolveJobReadScope(principal, resource);
}

export function subjectIdForJobAuthz(
  authz: AuthzService | undefined,
  actorUserId: string | null,
): string | null {
  if (!authz || authz.mode === "off") {
    return actorUserId;
  }
  return actorUserId;
}
