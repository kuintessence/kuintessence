import { createHash, createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import {
  type AuthorizationSubjectId,
  agentJobStatusEvents,
  agents,
  dataAssets,
  dataAssetVersions,
  ecosystemReleaseAssets,
  ecosystemReleases,
  jobCancellations,
  jobDataBindings,
  jobs,
  netdriveFiles,
  netdriveTransferLog,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
  usecasePackageRevisions,
  usecasePackages,
  userOrgMemberships,
  workflowRuns,
} from "@kuintessence/db";
import type {
  JobStatusName,
  JobSubmit,
  PlacementTrace,
  QueueTargetMode,
  SandboxSignedManifest,
} from "@kuintessence/shared";
import {
  AppError,
  createLogger,
  DataAssetKindSchema,
  DataDeliveryPolicySchema,
  DataDeliveryTargetPathSchema,
  DataSensitivitySchema,
  ErrorCode,
  JobStatus,
} from "@kuintessence/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { EventBus } from "../events/event-bus";
import { frozenAuthorizationSubjects } from "./authorization-subjects";
import type { DataRequirement } from "./data-prerequisite";
import { PgDataPrerequisiteRepository } from "./data-prerequisite-repository-drizzle";
import type { JobUsageRecord } from "./metering";
import { assertRestrictedNoEgressSubmission } from "./restricted-no-egress";

const logger = createLogger("job-service");

/** Callback type for job status change subscribers. */
type StatusSubscriber = (jobId: string, status: string) => Promise<void> | void;

/**
 * Narrow seam onto the metering subsystem so JobService can record compute
 * usage on terminal transitions without depending on the full MeteringService
 * (which pulls in the repository, aggregator, and tenant-scope machinery).
 * MeteringService satisfies this structurally.
 */
export interface JobMeteringRecorder {
  recordJobCompletion(record: JobUsageRecord): Promise<unknown>;
}

/** Row shape returned by `updateStatus` — the subset of fields the usage
 *  record is derived from. */
type TerminalJobRow = {
  id: string;
  cpus: number;
  gpus: number | null;
  memoryMb: number;
  submittedBy: string | null;
  orgId: string | null;
  agentId: string | null;
  appTemplateKey: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

interface DataUsageAttribution {
  storageMbSeconds: number;
  networkEgressMb: number;
  metadata: Record<string, unknown>;
}

function isTerminalJobStatus(status: string): boolean {
  return (
    status === JobStatus.COMPLETED || status === JobStatus.FAILED || status === JobStatus.CANCELLED
  );
}

export interface JobListOptions {
  limit?: number;
  offset?: number;
  status?: JobStatusName;
  query?: string;
  agentId?: string;
  submittedBy?: string;
  ids?: string[];
  visibility?: {
    userId: string;
    includeOwner: boolean;
    consumerAdminOrgIds: string[];
    providerOrgIds: string[];
  };
}

export interface JobSubmitOptions {
  orgId?: string | null;
  trustedMaterialization?: boolean;
  trustedSandboxScript?: {
    revisionId: string;
    sha256: string;
  };
  workflow?: {
    runId: string;
    nodeId: string;
  };
}

export interface SchedulerRuntimeDetails {
  node?: string;
  reason?: string | null;
}

export interface QueueAuditSnapshot {
  targetMode: QueueTargetMode;
  schedulerQueueName: string | null;
  observedAt: Date | null;
}

export function acceptsTrustedMaterialization(
  options: JobSubmitOptions,
  ecosystemReleaseTrusted: boolean,
): boolean {
  return options.trustedMaterialization === true && ecosystemReleaseTrusted;
}

function jobListFilters(options: JobListOptions): SQL[] {
  const filters: SQL[] = [];
  if (options.status) {
    filters.push(eq(jobs.status, options.status));
  }
  if (options.submittedBy) {
    filters.push(eq(jobs.submittedBy, options.submittedBy));
  }
  if (options.agentId) {
    filters.push(eq(jobs.agentId, options.agentId));
  }
  if (options.ids) {
    filters.push(options.ids.length > 0 ? inArray(jobs.id, options.ids) : sql`false`);
  }
  if (options.visibility) {
    const visibilityFilters: SQL[] = [];
    if (options.visibility.includeOwner) {
      visibilityFilters.push(eq(jobs.submittedBy, options.visibility.userId));
    }
    if (options.visibility.consumerAdminOrgIds.length > 0) {
      visibilityFilters.push(inArray(jobs.orgId, options.visibility.consumerAdminOrgIds));
    }
    if (options.visibility.providerOrgIds.length > 0) {
      visibilityFilters.push(inArray(jobs.providerOrgId, options.visibility.providerOrgIds));
    }
    const visibility = or(...visibilityFilters);
    filters.push(visibility ?? sql`false`);
  }
  const query = options.query?.trim();
  if (query) {
    const pattern = `%${query}%`;
    const textFilter = or(ilike(jobs.name, pattern), sql`${jobs.id}::text ILIKE ${pattern}`);
    if (textFilter) {
      filters.push(textFilter);
    }
  }
  return filters;
}

async function dataBindingValues(
  db: PgDb,
  data: JobSubmit,
  authorizationSubjectIds: AuthorizationSubjectId[],
  actor: { userId: string; orgId: string | null },
) {
  return Promise.all(
    Object.entries(data.dataInputs ?? {}).map(async ([inputDescriptor, input]) => {
      if (inputDescriptor.length > 255) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Data input descriptor exceeds 255 characters",
          400,
        );
      }
      if (input.source === "data-market") {
        const dataAccess = new PgDataPrerequisiteRepository(db);
        const canUse = await dataAccess.verifyAccess({
          actorUserId: actor.userId,
          orgId: actor.orgId,
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
        const [resolved] = await db
          .select({
            assetKind: dataAssets.kind,
            sensitivity: dataAssets.sensitivity,
            versionAssetId: dataAssetVersions.dataAssetId,
            manifestDigest: dataAssetVersions.manifestDigest,
            manifest: dataAssetVersions.manifest,
            status: dataAssetVersions.status,
          })
          .from(dataAssetVersions)
          .innerJoin(dataAssets, eq(dataAssetVersions.dataAssetId, dataAssets.id))
          .where(eq(dataAssetVersions.id, input.versionId))
          .limit(1);
        if (
          !resolved ||
          resolved.versionAssetId !== input.assetId ||
          resolved.manifestDigest !== input.manifestDigest ||
          resolved.status !== "ready"
        ) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Data Market binding does not resolve to the requested immutable ready version",
            400,
          );
        }
        const manifestPolicy =
          typeof resolved.manifest === "object" && resolved.manifest !== null
            ? (resolved.manifest as Record<string, unknown>).deliveryPolicy
            : undefined;
        const deliveryPolicy = DataDeliveryPolicySchema.parse(
          manifestPolicy ?? defaultDataDeliveryPolicy(),
        );
        const assetKind = DataAssetKindSchema.parse(resolved.assetKind);
        const sensitivity = DataSensitivitySchema.parse(resolved.sensitivity);
        const locations = await new PgDataPrerequisiteRepository(db).listLocations(input.versionId);
        if (locations.length === 0) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Data Market binding has no available immutable location",
            409,
            {
              blocker: "DATA_LOCATION_UNAVAILABLE",
              assetId: input.assetId,
              versionId: input.versionId,
            },
          );
        }
        return {
          inputDescriptor,
          source: input.source,
          assetId: input.assetId,
          versionId: input.versionId,
          manifestDigest: input.manifestDigest,
          selectedEntries: input.selectedEntries,
          allowedLocationIds: locations.map((location) => location.locationId),
          stagePath: dataStagePath(input.targetPath, inputDescriptor),
          deliveryPolicy,
          assetKind,
          sensitivity,
          egressPolicy:
            deliveryPolicy.download === "deny" || deliveryPolicy.redistribution === "deny"
              ? ("deny" as const)
              : ("allow" as const),
          authorizationSubjectIds,
        };
      }
      return {
        inputDescriptor,
        source: input.source,
        assetId: null,
        versionId: null,
        manifestDigest: null,
        selectedEntries: [],
        allowedLocationIds: [],
        stagePath: dataStagePath(input.targetPath, inputDescriptor),
        deliveryPolicy: defaultDataDeliveryPolicy(),
        assetKind: null,
        sensitivity: null,
        egressPolicy: "deny" as const,
        authorizationSubjectIds: [],
      };
    }),
  );
}

function dataStagePath(targetPath: string | undefined, descriptor: string): string {
  const parsed = DataDeliveryTargetPathSchema.safeParse(targetPath ?? `inputs/${descriptor}`);
  if (!parsed.success) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Data Market binding has an invalid delivery target path",
      400,
      { blocker: "DATA_STAGE_PATH_INVALID", descriptor },
    );
  }
  return parsed.data;
}

interface TrustedEcosystemUsecaseBinding {
  artifactDigest: string;
  manifest: Record<string, unknown>;
  manifestEntryDigest: string;
  manifestEntryDigestKey: string;
  packageSpec: unknown;
  packageSpecDigest: string | null;
  provenance: Record<string, unknown>;
  releaseKey: string;
  revisionSpec: unknown;
  revisionSpecDigest: string;
  signature: string;
  signingKeyId: string;
  usecaseSpecDigest: string | null;
}

interface TrustedEcosystemSandboxScriptBinding {
  entryPayload: Record<string, unknown>;
  manifest: Record<string, unknown>;
  manifestEntryDigest: string;
  manifestEntryDigestKey: string;
  releaseKey: string;
  revisionPayload: Record<string, unknown>;
  signature: string;
  signingKeyId: string;
  sourceSha256: string;
}

export function verifiesTrustedEcosystemUsecaseBinding(
  binding: TrustedEcosystemUsecaseBinding,
  trustedPublicKeys: Readonly<Record<string, string>>,
): boolean {
  try {
    if (
      !binding.manifestEntryDigest ||
      !binding.usecaseSpecDigest ||
      binding.packageSpecDigest !== binding.revisionSpecDigest ||
      binding.packageSpecDigest !== binding.usecaseSpecDigest ||
      digestCanonicalJson(binding.packageSpec) !== binding.revisionSpecDigest ||
      digestCanonicalJson(binding.revisionSpec) !== binding.revisionSpecDigest
    ) {
      return false;
    }
    const assets = binding.manifest.assets;
    if (!Array.isArray(assets)) return false;
    const entry = assets.find(
      (asset) =>
        isRecord(asset) &&
        asset.ecosystemKey === binding.manifestEntryDigestKey &&
        digestCanonicalJson(asset) === binding.manifestEntryDigest,
    );
    if (!isRecord(entry) || entry.specDigest !== binding.usecaseSpecDigest) return false;
    const entryPayload = entry.payload;
    if (
      !isRecord(entryPayload) ||
      digestCanonicalJson(entryPayload.spec) !== binding.usecaseSpecDigest
    ) {
      return false;
    }
    const releaseProvenance = binding.provenance.ecosystemRelease;
    if (
      !isRecord(releaseProvenance) ||
      releaseProvenance.releaseKey !== binding.releaseKey ||
      releaseProvenance.artifactDigest !== binding.artifactDigest ||
      releaseProvenance.manifestEntryDigest !== binding.manifestEntryDigest ||
      releaseProvenance.signingKeyId !== binding.signingKeyId
    ) {
      return false;
    }
    const publicKeyDer = trustedPublicKeys[binding.signingKeyId];
    if (!publicKeyDer) return false;
    const key = createPublicKey({
      key: Buffer.from(publicKeyDer, "base64"),
      format: "der",
      type: "spki",
    });
    return verifySignature(
      null,
      Buffer.from(canonicalJson(binding.manifest)),
      key,
      Buffer.from(binding.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function verifiesTrustedEcosystemSandboxScriptBinding(
  binding: TrustedEcosystemSandboxScriptBinding,
  trustedPublicKeys: Readonly<Record<string, string>>,
): boolean {
  try {
    if (binding.manifest.releaseKey !== binding.releaseKey) return false;
    const assets = binding.manifest.assets;
    if (!Array.isArray(assets)) return false;
    const entry = assets.find(
      (asset) =>
        isRecord(asset) &&
        asset.ecosystemKey === binding.manifestEntryDigestKey &&
        asset.kind === "sandbox-script" &&
        digestCanonicalJson(asset) === binding.manifestEntryDigest,
    );
    if (!isRecord(entry) || !isRecord(entry.payload)) return false;
    if (
      digestCanonicalJson(entry.payload) !== digestCanonicalJson(binding.entryPayload) ||
      digestCanonicalJson(entry.payload) !== digestCanonicalJson(binding.revisionPayload)
    ) {
      return false;
    }
    const content = entry.payload.content;
    const declaredSha256 = entry.payload.sha256;
    if (
      entry.payload.kind !== "sandbox-script" ||
      typeof content !== "string" ||
      typeof declaredSha256 !== "string" ||
      declaredSha256 !== binding.sourceSha256 ||
      createHash("sha256").update(content, "utf8").digest("hex") !== binding.sourceSha256
    ) {
      return false;
    }
    const publicKeyDer = trustedPublicKeys[binding.signingKeyId];
    if (!publicKeyDer) return false;
    const key = createPublicKey({
      key: Buffer.from(publicKeyDer, "base64"),
      format: "der",
      type: "spki",
    });
    return verifySignature(
      null,
      Buffer.from(canonicalJson(binding.manifest)),
      key,
      Buffer.from(binding.signature, "base64"),
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Non-JSON value");
}

function digestCanonicalJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

async function isTrustedEcosystemUsecase(
  db: PgDb,
  usecasePackageId: string | undefined,
  trustedPublicKeys: Readonly<Record<string, string>>,
) {
  if (!usecasePackageId) return false;
  const [row] = await db
    .select({
      artifactDigest: ecosystemReleases.artifactDigest,
      manifest: ecosystemReleases.manifest,
      manifestEntryDigest: ecosystemReleaseAssets.manifestEntryDigest,
      manifestEntryDigestKey: ecosystemReleaseAssets.ecosystemKey,
      packageSpec: usecasePackages.spec,
      packageSpecDigest: usecasePackages.specDigest,
      provenance: usecasePackageRevisions.provenance,
      releaseKey: ecosystemReleases.releaseKey,
      revisionSpec: usecasePackageRevisions.spec,
      revisionSpecDigest: usecasePackageRevisions.specDigest,
      signature: ecosystemReleases.signature,
      signingKeyId: ecosystemReleases.signingKeyId,
      usecaseSpecDigest: ecosystemReleaseAssets.usecaseSpecDigest,
    })
    .from(ecosystemReleaseAssets)
    .innerJoin(ecosystemReleases, eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id))
    .innerJoin(usecasePackages, eq(ecosystemReleaseAssets.usecasePackageId, usecasePackages.id))
    .innerJoin(
      usecasePackageRevisions,
      and(
        eq(ecosystemReleaseAssets.usecasePackageRevisionId, usecasePackageRevisions.id),
        eq(usecasePackageRevisions.packageId, usecasePackages.id),
      ),
    )
    .where(
      and(
        eq(ecosystemReleaseAssets.usecasePackageId, usecasePackageId),
        eq(ecosystemReleaseAssets.kind, "usecase"),
        eq(ecosystemReleaseAssets.usecaseSpecDigest, usecasePackageRevisions.specDigest),
        eq(usecasePackages.specDigest, usecasePackageRevisions.specDigest),
        eq(ecosystemReleases.status, "active"),
      ),
    )
    .limit(1);
  return row ? verifiesTrustedEcosystemUsecaseBinding(row, trustedPublicKeys) : false;
}

async function isTrustedEcosystemSandboxScript(
  db: PgDb,
  source: JobSubmitOptions["trustedSandboxScript"],
  trustedPublicKeys: Readonly<Record<string, string>>,
) {
  if (!source) return false;
  const [row] = await db
    .select({
      entryPayload: ecosystemReleaseAssets.payload,
      manifest: ecosystemReleases.manifest,
      manifestEntryDigest: ecosystemReleaseAssets.manifestEntryDigest,
      manifestEntryDigestKey: ecosystemReleaseAssets.ecosystemKey,
      releaseKey: ecosystemReleases.releaseKey,
      revisionPayload: softwareAssetRevisions.payload,
      signature: ecosystemReleases.signature,
      signingKeyId: ecosystemReleases.signingKeyId,
    })
    .from(ecosystemReleaseAssets)
    .innerJoin(ecosystemReleases, eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id))
    .innerJoin(
      softwareAssetRevisions,
      and(
        eq(ecosystemReleaseAssets.assetRevisionId, softwareAssetRevisions.id),
        eq(ecosystemReleaseAssets.assetId, softwareAssetRevisions.assetId),
      ),
    )
    .innerJoin(
      softwareAssets,
      and(
        eq(softwareAssetRevisions.assetId, softwareAssets.id),
        eq(softwareAssets.kind, "sandbox-script"),
      ),
    )
    .where(
      and(
        eq(softwareAssetRevisions.id, source.revisionId),
        eq(ecosystemReleaseAssets.kind, "sandbox-script"),
        eq(ecosystemReleases.status, "active"),
      ),
    )
    .limit(1);
  return row
    ? verifiesTrustedEcosystemSandboxScriptBinding(
        { ...row, sourceSha256: source.sha256 },
        trustedPublicKeys,
      )
    : false;
}

function defaultDataDeliveryPolicy() {
  return {
    download: "deny" as const,
    derive: "deny" as const,
    redistribution: "deny" as const,
    crossCenterReplication: "deny" as const,
    retention: "source-controlled" as const,
  };
}

/**
 * Service for managing job lifecycle in the Server.
 *
 * All input data MUST be validated by the caller (typically via zValidator at the
 * route layer using JobSubmitSchema from @kuintessence/shared).
 *
 * The optional `eventBus` parameter lets the service publish
 * JobStatusChanged events for the WS layer. Existing callbacks via subscribe()
 * remain in place for the workflow run-registry, which doesn't need the bus.
 */
export class JobService {
  private subscribers: StatusSubscriber[] = [];

  constructor(
    private db: PgDb,
    private eventBus?: EventBus,
    private meteringRecorder?: JobMeteringRecorder,
    private readonly ecosystemReleaseTrustedKeys: Readonly<Record<string, string>> = {},
  ) {}

  /**
   * Register a subscriber that is called whenever a job status changes.
   * Returns an unsubscribe function.
   */
  subscribe(fn: StatusSubscriber): () => void {
    this.subscribers.push(fn);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== fn);
    };
  }

  /**
   * Submit a new job. Sets initial status to "pending".
   *
   * Persists `appTemplateKey` (workflow-runtime supplied)
   * and a snapshot of the submitter's primary org membership onto the job row
   * so CP-Console org-scoped queries can filter on `jobs.org_id` directly.
   * The org lookup is best-effort: if the user row is missing or has no
   * org, we still insert with `orgId = NULL` rather than failing the
   * submission. NULL org rows are then invisible to org-scoped CP queries
   * by construction.
   *
   * @param data - Validated job submission payload (caller MUST validate via JobSubmitSchema).
   * @param submittedBy - UUID of the submitting user (caller resolves email → UUID from JWT).
   */
  async submit(data: JobSubmit, submittedBy: string, options: JobSubmitOptions = {}) {
    const orgId =
      options.orgId !== undefined ? options.orgId : await this.resolveOrgId(submittedBy);
    const bindingValues = await dataBindingValues(
      this.db,
      data,
      frozenAuthorizationSubjects(submittedBy, orgId),
      { userId: submittedBy, orgId },
    );
    const trustedExecutable =
      (await isTrustedEcosystemUsecase(
        this.db,
        data.usecasePackageId,
        this.ecosystemReleaseTrustedKeys,
      )) ||
      (await isTrustedEcosystemSandboxScript(
        this.db,
        options.trustedSandboxScript,
        this.ecosystemReleaseTrustedKeys,
      ));
    const restrictedNoEgress = assertRestrictedNoEgressSubmission({
      facts: bindingValues.map((binding) => ({
        assetKind: binding.assetKind,
        sensitivity: binding.sensitivity,
        egressPolicy: binding.egressPolicy,
      })),
      hasLicensedMaterialMounts: (data.licensedMaterials?.length ?? 0) > 0,
      trustedExecutable: acceptsTrustedMaterialization(options, trustedExecutable),
      expectedOutputCount: data.expectedOutputs?.length ?? 0,
      fileOutputDescriptorCount: data.fileOutputDescriptors?.length ?? 0,
    });
    const jobId = randomUUID();
    const job = await this.db.transaction(async (tx) => {
      if (options.workflow) {
        const [linked] = await tx
          .update(workflowRuns)
          .set({
            stepJobs: sql`coalesce(${workflowRuns.stepJobs}, '{}'::jsonb) || ${JSON.stringify({
              [options.workflow.nodeId]: jobId,
            })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(
            and(eq(workflowRuns.id, options.workflow.runId), eq(workflowRuns.status, "running")),
          )
          .returning({ id: workflowRuns.id });
        if (!linked) {
          throw new AppError(
            ErrorCode.JOB_DISPATCH_FAILED,
            `Workflow run ${options.workflow.runId} is not accepting new jobs`,
            409,
          );
        }
      }
      const [created] = await tx
        .insert(jobs)
        .values({
          id: jobId,
          name: data.name,
          command: data.command,
          cpus: data.resources.cpus,
          memoryMb: data.resources.memoryMb,
          gpus: data.resources.gpus ?? 0,
          wallTimeSec: data.resources.wallTimeSec ?? null,
          workingDir: data.workingDir ?? null,
          envVars: data.envVars ?? null,
          submittedBy,
          appTemplateKey: data.appTemplateKey ?? null,
          softwareRequirements: data.softwareRequirements ?? null,
          usecasePackageId: data.usecasePackageId ?? null,
          usecasePackageName: data.usecasePackageName ?? null,
          usecasePackageVersion: data.usecasePackageVersion ?? null,
          usecaseInputs: data.usecaseInputs ?? null,
          inputStaging: data.inputStaging ?? null,
          expectedOutputs: data.expectedOutputs ?? null,
          fileOutputDescriptors: data.fileOutputDescriptors ?? null,
          stdinText: data.stdinText ?? null,
          queueId: data.schedulingStrategy?.queueId ?? null,
          orgId,
          restrictedNoEgress,
          status: JobStatus.PENDING,
        })
        .returning();
      if (!created) throw new AppError(ErrorCode.INTERNAL_ERROR, "Insert returned no rows", 500);
      if (bindingValues.length > 0) {
        await tx
          .insert(jobDataBindings)
          .values(bindingValues.map((binding) => ({ ...binding, jobId: created.id })));
      }
      return created;
    });
    if (!job) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Insert returned no rows", 500);
    }
    return job;
  }

  async listDataPrerequisites(jobId: string): Promise<DataRequirement[]> {
    const rows = await this.db
      .select({
        source: jobDataBindings.source,
        assetId: jobDataBindings.assetId,
        versionId: jobDataBindings.versionId,
        manifestDigest: jobDataBindings.manifestDigest,
        selectedEntries: jobDataBindings.selectedEntries,
      })
      .from(jobDataBindings)
      .where(and(eq(jobDataBindings.jobId, jobId), eq(jobDataBindings.source, "data-market")));
    return rows.flatMap((row) => {
      if (!row.assetId || !row.versionId || !row.manifestDigest) return [];
      return [
        {
          assetId: row.assetId,
          versionId: row.versionId,
          manifestDigest: row.manifestDigest,
          ...(row.selectedEntries.length > 0 ? { requiredPaths: row.selectedEntries } : {}),
        },
      ];
    });
  }

  /**
   * Resolve the submitter's primary membership org for stamping onto the job row.
   * Best-effort: returns null on lookup failure (transient DB hiccup) or
   * when the user has no org membership. NULL is the same value used for
   * legacy rows pre-migration-0013, so org-scoped queries treat both
   * identically.
   */
  private async resolveOrgId(userId: string): Promise<string | null> {
    try {
      const [row] = await this.db
        .select({ orgId: userOrgMemberships.orgId })
        .from(userOrgMemberships)
        .where(eq(userOrgMemberships.userId, userId))
        .orderBy(asc(userOrgMemberships.createdAt))
        .limit(1);
      return row?.orgId ?? null;
    } catch (err) {
      logger.warn({ userId, err }, "resolveOrgId lookup failed; storing NULL");
      return null;
    }
  }

  async backfillProviderSnapshots(): Promise<number> {
    const updated = await this.db
      .update(jobs)
      .set({ providerOrgId: agents.providerOrgId })
      .from(agents)
      .where(
        and(
          isNull(jobs.providerOrgId),
          eq(jobs.agentId, agents.agentId),
          isNotNull(agents.providerOrgId),
        ),
      )
      .returning({ id: jobs.id });
    return updated.length;
  }

  /**
   * Retrieve a job by UUID. Returns null if not found.
   */
  async getById(id: string) {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return job ?? null;
  }

  /**
   * List jobs ordered by submittedAt descending (newest first).
   *
   * @param limit - Maximum number of jobs to return (default 50).
   */
  async list(limit = 50) {
    const page = await this.listPage({ limit });
    return page.jobs;
  }

  async listPage(options: JobListOptions = {}) {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const filters = jobListFilters(options);
    const where = filters.length > 0 ? and(...filters) : undefined;
    const rows = await this.db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(desc(jobs.submittedAt))
      .limit(limit)
      .offset(offset);
    const [totalRow] = await this.db.select({ value: count() }).from(jobs).where(where);
    return { jobs: rows, total: totalRow?.value ?? 0 };
  }

  /**
   * Transition a job to a new status.
   * - Automatically sets startedAt when transitioning to "running".
   * - Automatically sets completedAt when first entering a terminal state
   *   ("completed", "failed", "cancelled"). Preserves the original timestamp
   *   if the job is already terminal (prevents audit trail loss on race conditions).
   * - Optionally records the external scheduler job ID (e.g. Slurm job number).
   * - After a successful write, fires all registered status subscribers.
   *
   * @param status - Typed status name; caught at compile time by JobStatusName.
   * @throws AppError NOT_FOUND if job does not exist.
   */
  /** Set the job's run directory (the workflow runner composes `<base>/<jobId>` after
   *  submit, once the id exists). Read back by placeAndDispatch for staging and
   *  by the agent for `--chdir`. */
  async setWorkingDir(jobId: string, workingDir: string) {
    await this.db.update(jobs).set({ workingDir }).where(eq(jobs.id, jobId));
  }

  async updateStatus(
    jobId: string,
    status: JobStatusName,
    schedulerJobId?: string,
    expectedAgentId?: string,
    errorMessage?: string,
    exitCode?: number,
    collectedOutputs?: Record<string, string>,
    agentEventId?: string,
    schedulerDetails?: SchedulerRuntimeDetails,
  ) {
    const idWhere = expectedAgentId
      ? and(eq(jobs.id, jobId), eq(jobs.agentId, expectedAgentId))
      : eq(jobs.id, jobId);

    const isTerminal =
      status === JobStatus.COMPLETED ||
      status === JobStatus.FAILED ||
      status === JobStatus.CANCELLED;
    const now = new Date();
    let changed = false;
    const updated = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(jobs).where(idWhere).limit(1).for("update");
      if (!current) {
        throw new AppError(ErrorCode.NOT_FOUND, `Job ${jobId} not found`, 404);
      }

      if (agentEventId && expectedAgentId) {
        const [claimed] = await tx
          .insert(agentJobStatusEvents)
          .values({
            agentId: expectedAgentId,
            eventId: agentEventId,
            jobId,
            status,
          })
          .onConflictDoNothing()
          .returning({ id: agentJobStatusEvents.id });
        if (!claimed) return current;
      }

      const currentIsTerminal =
        current.status === JobStatus.COMPLETED ||
        current.status === JobStatus.FAILED ||
        current.status === JobStatus.CANCELLED;
      if (currentIsTerminal) return current;

      const statusChanged =
        current.status !== status ||
        (schedulerJobId !== undefined && current.schedulerJobId !== schedulerJobId) ||
        (errorMessage !== undefined && current.errorMessage !== errorMessage) ||
        (exitCode !== undefined && current.exitCode !== exitCode) ||
        (schedulerDetails?.node !== undefined && current.node !== schedulerDetails.node) ||
        (schedulerDetails?.reason !== undefined && current.reason !== schedulerDetails.reason);
      if (!statusChanged) return current;

      const [written] = await tx
        .update(jobs)
        .set({
          status,
          ...(schedulerJobId !== undefined ? { schedulerJobId } : {}),
          ...(errorMessage !== undefined ? { errorMessage } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(schedulerDetails?.node !== undefined ? { node: schedulerDetails.node } : {}),
          ...(schedulerDetails?.reason !== undefined ? { reason: schedulerDetails.reason } : {}),
          ...(collectedOutputs !== undefined
            ? {
                collectedOutputs: current.restrictedNoEgress ? {} : collectedOutputs,
              }
            : {}),
          ...(status === JobStatus.RUNNING || isTerminal
            ? { startedAt: current.startedAt ?? now }
            : {}),
          ...(isTerminal ? { completedAt: current.completedAt ?? now } : {}),
          ...(status === JobStatus.CANCELLED
            ? { revokedEpoch: Math.max(current.revokedEpoch, current.dispatchEpoch + 1) }
            : {}),
        })
        .where(idWhere)
        .returning();
      if (!written) {
        throw new AppError(ErrorCode.NOT_FOUND, `Job ${jobId} not found`, 404);
      }
      changed = true;
      return written;
    });

    if (!changed) return updated;

    await this.publishStatusChange(updated, status, isTerminal);

    return updated;
  }

  async cancel(jobId: string) {
    const now = new Date();
    const cancelled = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for("update");
      if (!current) {
        throw new AppError(ErrorCode.NOT_FOUND, `Job ${jobId} not found`, 404);
      }
      if (isTerminalJobStatus(current.status)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Job is already in a terminal state", 409);
      }
      const [written] = await tx
        .update(jobs)
        .set({
          status: JobStatus.CANCELLED,
          startedAt: current.startedAt ?? now,
          completedAt: now,
          revokedEpoch: Math.max(current.revokedEpoch, current.dispatchEpoch + 1),
        })
        .where(eq(jobs.id, jobId))
        .returning();
      if (!written) {
        throw new AppError(ErrorCode.NOT_FOUND, `Job ${jobId} not found`, 404);
      }
      if (written.agentId) {
        await tx
          .insert(jobCancellations)
          .values({
            agentId: written.agentId,
            jobId: written.id,
            revokedEpoch: written.revokedEpoch,
          })
          .onConflictDoNothing({ target: jobCancellations.jobId });
      }
      return written;
    });

    await this.publishStatusChange(cancelled, JobStatus.CANCELLED, true);
    return cancelled;
  }

  private async publishStatusChange(
    updated: TerminalJobRow & { schedulerJobId: string | null },
    status: JobStatusName,
    isTerminal: boolean,
  ): Promise<void> {
    for (const sub of this.subscribers) {
      try {
        await sub(updated.id, status);
      } catch (err) {
        logger.error({ jobId: updated.id, status, err }, "Status subscriber threw an error");
      }
    }

    if (this.eventBus) {
      this.eventBus.publishJobStatus({
        jobId: updated.id,
        status,
        schedulerJobId: updated.schedulerJobId ?? null,
        agentId: updated.agentId ?? null,
      });
    }

    if (isTerminal && this.meteringRecorder) {
      await this.recordUsage(updated);
    }
  }

  /**
   * Best-effort metering producer: derive a {@link JobUsageRecord} from a
   * just-terminated job row and hand it to the recorder. A metering failure
   * MUST NOT propagate out of `updateStatus` — the job has already transitioned
   * and the status write is authoritative — so any error is swallowed and
   * logged. `recordJobCompletion` is idempotent on `jobId`, so redundant
   * terminal transitions (e.g. a late agent report after cancel) never
   * double-count.
   */
  private async recordUsage(updated: TerminalJobRow): Promise<void> {
    const { submittedBy, orgId, agentId, startedAt, completedAt } = updated;
    // The raw row requires all five — skip silently if any is missing rather
    // than fabricate a partial record the metering validator would reject.
    if (!submittedBy || !orgId || !agentId || !startedAt || !completedAt) {
      logger.debug(
        { jobId: updated.id },
        "Skipping usage record: missing required attribution/timestamp field",
      );
      return;
    }

    const durationSec = Math.max(0, (completedAt.getTime() - startedAt.getTime()) / 1000);
    const dataUsage = await this.estimateDataUsage({
      jobId: updated.id,
      userId: submittedBy,
      orgId,
      startedAt,
      completedAt,
      durationSec,
    });
    const record: JobUsageRecord = {
      jobId: updated.id,
      userId: submittedBy,
      orgId,
      agentId,
      // No agent→cluster mapping yet; the agent id doubles as the cluster
      // identifier until a dedicated mapping lands.
      clusterName: agentId,
      appTemplateKey: updated.appTemplateKey ?? null,
      cpuCoreSeconds: Math.round(updated.cpus * durationSec),
      gpuSeconds: Math.round((updated.gpus ?? 0) * durationSec),
      memoryMbSeconds: Math.round(Number(updated.memoryMb) * durationSec),
      storageMbSeconds: dataUsage.storageMbSeconds,
      networkEgressMb: dataUsage.networkEgressMb,
      startedAt,
      finishedAt: completedAt,
      metadata: dataUsage.metadata,
    };

    try {
      await this.meteringRecorder?.recordJobCompletion(record);
    } catch (err) {
      logger.warn({ jobId: updated.id, err }, "Failed to record compute usage to metering");
    }
  }

  private async estimateDataUsage(input: {
    jobId: string;
    userId: string;
    orgId: string;
    startedAt: Date;
    completedAt: Date;
    durationSec: number;
  }): Promise<DataUsageAttribution> {
    try {
      const exactTransfers = await this.db
        .select({
          fileId: netdriveTransferLog.fileId,
          netdriveFileIds: netdriveTransferLog.netdriveFileIds,
        })
        .from(netdriveTransferLog)
        .where(
          and(
            eq(netdriveTransferLog.jobId, input.jobId),
            inArray(netdriveTransferLog.direction, ["download", "mirror"]),
          ),
        );
      const exactFileIds = [
        ...new Set(
          exactTransfers.flatMap((row) => [
            ...(row.fileId ? [row.fileId] : []),
            ...row.netdriveFileIds,
          ]),
        ),
      ];
      const [exactNetworkRow] = await this.db
        .select({
          bytes: sql<string>`coalesce(sum(${netdriveTransferLog.bytes}), 0)`,
          count: sql<string>`count(*)`,
        })
        .from(netdriveTransferLog)
        .where(
          and(
            eq(netdriveTransferLog.jobId, input.jobId),
            inArray(netdriveTransferLog.direction, ["download", "mirror"]),
          ),
        );
      if (numericStringToNumber(exactNetworkRow?.count ?? "0") > 0) {
        const [exactStorageRow] =
          exactFileIds.length > 0
            ? await this.db
                .select({
                  bytes: sql<string>`coalesce(sum(${netdriveFiles.size}), 0)`,
                })
                .from(netdriveFiles)
                .where(inArray(netdriveFiles.id, exactFileIds))
            : [{ bytes: "0" }];
        const storageBytes = numericStringToNumber(exactStorageRow?.bytes ?? "0");
        const networkBytes = numericStringToNumber(exactNetworkRow?.bytes ?? "0");
        return {
          storageMbSeconds: Math.round(bytesToMiB(storageBytes) * input.durationSec),
          networkEgressMb: roundFour(bytesToMiB(networkBytes)),
          metadata: {
            dataAttribution: {
              version: "netdrive",
              networkSource: "netdrive_transfer_log:download+mirror jobId",
              storageSource: "netdrive_files:job-linked-file-ids * job-duration",
              storageBytes,
              networkEgressBytes: networkBytes,
              netdriveFileIds: exactFileIds,
            },
          },
        };
      }

      const [storageRow] = await this.db
        .select({
          bytes: sql<string>`coalesce(sum(${netdriveFiles.size}), 0)`,
        })
        .from(netdriveFiles)
        .where(and(eq(netdriveFiles.ownerId, input.userId), isNull(netdriveFiles.deletedAt)));
      const [networkRow] = await this.db
        .select({
          bytes: sql<string>`coalesce(sum(${netdriveTransferLog.bytes}), 0)`,
        })
        .from(netdriveTransferLog)
        .where(
          and(
            eq(netdriveTransferLog.actorId, input.userId),
            eq(netdriveTransferLog.orgId, input.orgId),
            inArray(netdriveTransferLog.direction, ["download", "mirror"]),
            gte(netdriveTransferLog.occurredAt, input.startedAt),
            lte(netdriveTransferLog.occurredAt, input.completedAt),
          ),
        );

      const storageBytes = numericStringToNumber(storageRow?.bytes ?? "0");
      const networkBytes = numericStringToNumber(networkRow?.bytes ?? "0");
      return {
        storageMbSeconds: Math.round(bytesToMiB(storageBytes) * input.durationSec),
        networkEgressMb: roundFour(bytesToMiB(networkBytes)),
        metadata: {
          dataAttribution: {
            version: "netdrive-v1",
            networkSource: "netdrive_transfer_log:download+mirror actor/org/job-window",
            storageSource: "netdrive_files:live-owner-bytes * job-duration",
            storageBytes,
            networkEgressBytes: networkBytes,
          },
        },
      };
    } catch (err) {
      logger.warn({ err }, "Failed to estimate NetDrive metering attribution");
      return {
        storageMbSeconds: 0,
        networkEgressMb: 0,
        metadata: {
          dataAttribution: {
            version: "netdrive-v1",
            error: "NETDRIVE_ATTRIBUTION_UNAVAILABLE",
          },
        },
      };
    }
  }

  /**
   * Assign a job to an agent and transition it to "queued".
   * Used by the global scheduler (Task 9+) after placement decisions.
   *
   * @param jobId - UUID of the job.
   * @param agentId - agentId of the target agent (FK → agents.agent_id).
   * @param providerOrgId - Placement-time provider snapshot. Once set, it is immutable.
   * @throws AppError NOT_FOUND if job does not exist.
   */
  async assignToAgent(
    jobId: string,
    agentId: string,
    providerOrgId: string | null = null,
    queueSnapshot?: QueueAuditSnapshot,
  ) {
    const providerMatch = providerOrgId
      ? or(isNull(jobs.providerOrgId), eq(jobs.providerOrgId, providerOrgId))
      : isNull(jobs.providerOrgId);
    const [updated] = await this.db
      .update(jobs)
      .set({
        agentId,
        providerOrgId: sql`coalesce(${jobs.providerOrgId}, ${providerOrgId})`,
        status: JobStatus.QUEUED,
        dispatchEpoch: sql`${jobs.dispatchEpoch} + 1`,
        ...(queueSnapshot
          ? {
              queueTargetMode: queueSnapshot.targetMode,
              schedulerQueueName: queueSnapshot.schedulerQueueName,
              queueObservedAt: queueSnapshot.observedAt,
            }
          : {}),
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, JobStatus.PENDING), providerMatch))
      .returning();
    if (!updated) {
      const [existing] = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!existing) {
        throw new AppError(ErrorCode.NOT_FOUND, `Job ${jobId} not found`, 404);
      }
      throw new AppError(
        ErrorCode.JOB_DISPATCH_FAILED,
        `Job ${jobId} is no longer pending or is already bound to a different provider`,
        409,
      );
    }
    return updated;
  }

  async claimDispatchEpoch(jobId: string, dispatchEpoch: number): Promise<boolean> {
    const [claimed] = await this.db
      .update(jobs)
      .set({ status: JobStatus.QUEUED })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, JobStatus.QUEUED),
          eq(jobs.dispatchEpoch, dispatchEpoch),
          lt(jobs.revokedEpoch, dispatchEpoch),
        ),
      )
      .returning({ id: jobs.id });
    return claimed !== undefined;
  }

  /**
   * persist the placement trace produced by the
   * orchestrator's `runWithTrace` path. The trace travels with the job in a
   * dedicated JSONB column so the Web "Placement trace" tab and the CP
   * Console can explain post-hoc why each candidate was kept or dropped.
   *
   * @throws AppError NOT_FOUND if job does not exist.
   */
  async setPlacementTrace(jobId: string, trace: PlacementTrace) {
    const [updated] = await this.db
      .update(jobs)
      .set({ placementTrace: trace })
      .where(eq(jobs.id, jobId))
      .returning();
    if (!updated) {
      throw new AppError(ErrorCode.NOT_FOUND, `Job ${jobId} not found`, 404);
    }
    return updated;
  }

  async setSandboxExecution(jobId: string, manifest: SandboxSignedManifest) {
    const [updated] = await this.db
      .update(jobs)
      .set({ sandboxExecution: manifest })
      .where(eq(jobs.id, jobId))
      .returning();
    if (!updated) {
      throw new AppError(ErrorCode.NOT_FOUND, `Job ${jobId} not found`, 404);
    }
    return updated;
  }

  /**
   * fetch the persisted placement trace for a job, or null if
   * no trace exists. Returns null (not throws) when the job exists but has
   * never been routed through the orchestrator's trace path; the route
   * layer maps that to a 404.
   */
  async getPlacementTrace(jobId: string): Promise<PlacementTrace | null> {
    const [row] = await this.db
      .select({ trace: jobs.placementTrace })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    if (!row || row.trace == null) return null;
    return row.trace as PlacementTrace;
  }
}

function bytesToMiB(bytes: number): number {
  return bytes / 1024 / 1024;
}

function roundFour(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function numericStringToNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`job-service metering attribution produced non-finite numeric value: ${value}`);
  }
  return n;
}
