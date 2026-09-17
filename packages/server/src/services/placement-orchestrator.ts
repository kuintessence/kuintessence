import {
  agentInstalledSoftware,
  agentSoftware,
  jobs,
  type PgDb,
  usageQuotas,
} from "@kuintessence/db";
import type {
  JobSubmit,
  LicensedMaterialRequest,
  PlacementPreferenceRejection,
  PlacementTrace,
  RoleName,
  SandboxSignedManifest,
  SoftwareAvailabilityRequest,
} from "@kuintessence/shared";
import { createLogger } from "@kuintessence/shared";
import { and, eq, inArray, or } from "drizzle-orm";
import type { AgentDispatcher, JobCancellationOutbox } from "../grpc/dispatcher";
import type { PreferenceService } from "../preferences/preference-service";
import { deriveDataSites } from "../scheduler/data-locality";
import { AutoFilter } from "../scheduler/filters/auto";
import { BillingFilter } from "../scheduler/filters/billing";
import {
  ComputeHealthFilter,
  type ComputeHealthFilterOptions,
} from "../scheduler/filters/compute-health";
import { InstallRightsFilter } from "../scheduler/filters/install-rights";
import { LoadFilter } from "../scheduler/filters/load";
import { ManualFilter } from "../scheduler/filters/manual";
import { PermissionFilter } from "../scheduler/filters/permission";
import { QueueFilter } from "../scheduler/filters/queue";
import { SoftwareFilter } from "../scheduler/filters/software";
import { UrgencyFilter } from "../scheduler/filters/urgency";
import { runPlacementWithTrace } from "../scheduler/placement-trace";
import type { AgentRow, FilterStage, RejectionTrace } from "../scheduler/types";
import type { AgentManager } from "./agent-manager";
import type { ResolvedDataDelivery, RestrictedSandboxDeliveryBinding } from "./data-delivery";
import type { DataPrerequisitePlacementGate, DataRequirement } from "./data-prerequisite";
import type { JobService } from "./job-service";
import type { QueueDispatchTarget, QueueRegistryService, QueueSelection } from "./queue-registry";
import type { SoftwareAvailabilityService } from "./software-availability";

const logger = createLogger("placement-orchestrator");

/**
 * Stages a placed job's input files onto the selected agent before dispatch.
 * Implemented (in index.ts) by reusing the FileTransferRequest cloud_to_cluster
 * subsystem; injected via setInputStager so the orchestrator stays decoupled
 * from NetDrive (which is built later and only when NETDRIVE_ENABLED).
 */
export type InputStager = (args: {
  jobId: string;
  workflowRunId?: string;
  agentId: string;
  actorUserId: string;
  workingDir: string;
  files: { fileMetadataId: string; stagePath: string }[];
}) => Promise<void>;

export type InputUrlResolver = (args: {
  jobId: string;
  workflowRunId?: string;
  actorUserId: string;
  files: { fileMetadataId: string; stagePath: string }[];
}) => Promise<Array<{ fileMetadataId: string; stagePath: string; sourceUrl: string }>>;

export type DispatchInputStaging = {
  fileMetadataId: string;
  stagePath: string;
  sourceUrl?: string;
  deliveryLeaseId?: string;
  deliveryLeaseExpiresAtUnixMs?: number;
};

export interface PlaceAndDispatchInput {
  jobId: string;
  workflowRunId?: string;
  job: JobSubmit;
  userId: string;
  userRole: RoleName;
  orgId: string | null;
  preferredAgentIds?: string[];
  restrictedNoEgress?: boolean;
  sandboxExecution?: {
    runtimeDigests: Partial<Record<"OCI" | "SIF", string>>;
    build(input: {
      agentId: string;
      schedulerType: string;
      providerOrgId: string | null;
      clusterId: string | null;
      queueName?: string;
      qos?: string;
    }): Promise<SandboxSignedManifest>;
  };
}

export interface PlaceAndDispatchResult {
  selectedAgentId: string | null;
  rejections: RejectionTrace[];
  /** True only when an agent was selected AND the DispatchJob reached a live
   *  channel. The workflow runner uses this to fail the job's awaitCompletion rather
   *  than hang when the job will never run (no agent / closed channel). */
  dispatched: boolean;
  /** full per-stage trace persisted on the job. */
  trace?: PlacementTrace;
}

export interface LicensedMaterialDispatchMount extends LicensedMaterialRequest {
  expectedFingerprint: string;
}

export function restrictToIsolatedAgents<T extends { restrictedDataIsolation: boolean }>(
  candidates: T[],
  restrictedNoEgress: boolean,
): T[] {
  return restrictedNoEgress
    ? candidates.filter((candidate) => candidate.restrictedDataIsolation)
    : candidates;
}

function preflightRejectionTrace(
  stage: string,
  candidates: AgentRow[],
  reason: string,
): PlacementTrace {
  return {
    generatedAt: new Date().toISOString(),
    preview: false,
    candidateCount: candidates.length,
    stages: [
      {
        name: stage,
        inputCount: candidates.length,
        passed: [],
        rejected: candidates.map((agent) => ({
          agent: {
            agentId: agent.agentId,
            siteName: agent.siteName,
            schedulerType: agent.schedulerType,
            schedulerVersion: agent.schedulerVersion,
          },
          reason,
        })),
      },
    ],
    finalDecision: null,
  };
}

function withPreferredQueueRejections(
  trace: PlacementTrace,
  rejections: PlacementPreferenceRejection[],
): PlacementTrace {
  return rejections.length > 0 ? { ...trace, softPreferenceRejections: rejections } : trace;
}

export function assertSandboxDataDeliveryMode(
  restrictedNoEgress: boolean,
  dataDeliveryCount: number,
): void {
  if (dataDeliveryCount > 0 && !restrictedNoEgress) {
    throw new Error("Sandbox Data Market delivery requires restricted no-egress signed mounts");
  }
}

/**
 * Orchestrates the post-submit flow: load candidates, run the placement
 * pipeline, assign the winner to the job, and push a dispatch message over gRPC.
 *
 * If no agent is selected the job remains in "pending" status and the caller
 * receives the rejection traces so they can surface them in the API response.
 */
export class PlacementOrchestrator {
  constructor(
    private deps: {
      agentManager: AgentManager;
      jobService: JobService;
      preferenceService: PreferenceService;
      dispatcher: AgentDispatcher;
      jobCancellations?: Pick<JobCancellationOutbox, "enqueue" | "redeliver">;
      queueRegistry?: QueueRegistryService;
      computeHealth?: ComputeHealthFilterOptions;
      db?: PgDb;
      softwareAvailability?: SoftwareAvailabilityService;
      dataPrerequisites?: DataPrerequisitePlacementGate;
      loadPersistedDataPrerequisites?: (jobId: string) => Promise<DataRequirement[]>;
      resolveLicensedMaterials?: (input: {
        requests: LicensedMaterialRequest[];
        providerOrgId: string | null;
        agentId: string;
        consumerEntitlementSubjectIds: string[];
      }) => Promise<LicensedMaterialDispatchMount[]>;
    },
  ) {}

  private inputStager?: InputStager;
  private inputUrlResolver?: InputUrlResolver;
  private dataDeliveryResolver?: (input: {
    jobId: string;
    actorUserId: string;
    orgId: string | null;
    agentId: string;
  }) => Promise<ResolvedDataDelivery[]>;
  private restrictedSandboxDeliveryBinder?: (
    manifest: SandboxSignedManifest,
    deliveries: readonly ResolvedDataDelivery[],
  ) => RestrictedSandboxDeliveryBinding;

  /** Wire the input-file stager once NetDrive is available (index.ts). */
  setInputStager(stager: InputStager | undefined): void {
    this.inputStager = stager;
  }

  setInputUrlResolver(resolver: InputUrlResolver | undefined): void {
    this.inputUrlResolver = resolver;
  }

  setDataDeliveryResolver(
    resolver:
      | ((input: {
          jobId: string;
          actorUserId: string;
          orgId: string | null;
          agentId: string;
        }) => Promise<ResolvedDataDelivery[]>)
      | undefined,
  ): void {
    this.dataDeliveryResolver = resolver;
  }

  setRestrictedSandboxDeliveryBinder(
    binder:
      | ((
          manifest: SandboxSignedManifest,
          deliveries: readonly ResolvedDataDelivery[],
        ) => RestrictedSandboxDeliveryBinding)
      | undefined,
  ): void {
    this.restrictedSandboxDeliveryBinder = binder;
  }

  /**
   * Push a cancel to the agent running a job so it kills the scheduler job
   * (scancel/qdel). The server already marks the job cancelled in the DB; this is
   * the propagation that actually frees the cluster allocation (tbd #11).
   * Returns whether the message was queued (false if the agent isn't connected).
   */
  async cancelJob(agentId: string, jobId: string, revokedEpoch = 0): Promise<void> {
    if (this.deps.jobCancellations) {
      await this.deps.jobCancellations.enqueue(agentId, jobId, revokedEpoch);
      await this.deps.jobCancellations.redeliver(agentId);
      return;
    }
    this.deps.dispatcher.pushCancelJob(agentId, jobId, revokedEpoch);
  }

  async validateSchedulingIntent(input: {
    job: JobSubmit;
    userId: string;
    userRole: RoleName;
    orgId: string | null;
  }): Promise<{
    queueSelection: QueueSelection | null;
    preferredQueueSelections: QueueSelection[];
    preferredQueueRejections: PlacementPreferenceRejection[];
  }> {
    const ctx = {
      role: input.userRole,
      orgId: input.orgId,
      userId: input.userId,
    };
    const queueSelection =
      (await this.deps.queueRegistry?.resolveForSubmit(
        input.job.schedulingStrategy?.queueId,
        ctx,
      )) ?? null;
    const preferred = this.deps.queueRegistry
      ? await this.deps.queueRegistry.inspectPreferredForSubmit(
          input.job.schedulingStrategy?.preferredQueueIds,
          ctx,
        )
      : { selections: [], rejections: [] };
    return {
      queueSelection,
      preferredQueueSelections: preferred.selections,
      preferredQueueRejections: preferred.rejections,
    };
  }

  /**
   * Auto-fill `requires.locality.dataSites` from NetDrive mirror records when
   * the submitter left it unset and the job stages input files. Returns the
   * job unchanged when there's nothing to derive (no db, no inputStaging, or an
   * explicit dataSites already present). Immutable — never mutates `job`.
   *
   * Dormant until cross-site mirroring writes `netdrive_transfer_log` mirror
   * rows; the explicit submit-time field is the active locality path.
   */
  private async withDerivedDataSites(job: JobSubmit): Promise<JobSubmit> {
    if (!this.deps.db) return job;
    if (job.requires?.locality?.dataSites !== undefined) return job;
    const files = job.inputStaging ?? [];
    if (files.length === 0) return job;
    // Locality is a soft scoring hint — derivation MUST NOT block placement.
    // `fileMetadataId` is `z.string()` (not UUID-validated), so a malformed id
    // makes the uuid-column query throw; a transient DB blip can too. Either way
    // we degrade to "no derived sites" rather than failing the job's placement.
    try {
      const dataSites = await deriveDataSites(
        this.deps.db,
        files.map((f) => f.fileMetadataId),
      );
      if (dataSites.length === 0) return job;
      return { ...job, requires: { ...job.requires, locality: { dataSites } } };
    } catch (err) {
      logger.warn({ err }, "data-locality derivation failed; placing without locality hint");
      return job;
    }
  }

  async placeAndDispatch(input: PlaceAndDispatchInput): Promise<PlaceAndDispatchResult> {
    const {
      jobId,
      workflowRunId,
      job,
      userId,
      userRole,
      orgId,
      sandboxExecution,
      preferredAgentIds,
      restrictedNoEgress = false,
    } = input;

    const onlineCandidates = await this.deps.agentManager.listOnline();
    const liveCandidates = onlineCandidates.filter((agent) =>
      this.deps.dispatcher.isOnline(agent.agentId),
    );
    let candidates = sandboxExecution
      ? liveCandidates.filter((agent) => {
          if (agent.sandboxReadiness !== "ready") return false;
          const kind = agent.schedulerType === "kubernetes" ? "OCI" : "SIF";
          const requiredDigest = sandboxExecution.runtimeDigests[kind];
          if (!requiredDigest) return false;
          return agent.sandboxRuntimeCache.some(
            (runtime) =>
              runtime.kind === kind &&
              runtime.digest === requiredDigest &&
              runtime.signatureVerified === true,
          );
        })
      : liveCandidates;
    if (restrictedNoEgress) {
      candidates = restrictToIsolatedAgents(candidates, true);
      if (candidates.length === 0) {
        const reason =
          "Restricted no-egress jobs require an Agent advertising trusted restricted-data isolation";
        const trace = preflightRejectionTrace("restricted-data-isolation", liveCandidates, reason);
        try {
          await this.deps.jobService.setPlacementTrace(jobId, trace);
        } catch (error) {
          logger.warn({ error, jobId }, "Failed to persist restricted isolation rejection trace");
        }
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, undefined, reason);
        return {
          selectedAgentId: null,
          rejections: liveCandidates.map((agent) => ({
            stage: "restricted-data-isolation",
            agentId: agent.agentId,
            reason,
          })),
          dispatched: false,
          trace,
        };
      }
    }
    const dataRequirements = this.deps.loadPersistedDataPrerequisites
      ? await this.deps.loadPersistedDataPrerequisites(jobId)
      : dataRequirementsFromJob(job);
    if (this.deps.dataPrerequisites && dataRequirements.length > 0) {
      try {
        const plan = await this.deps.dataPrerequisites.prepare({
          actorUserId: userId,
          orgId,
          requirements: dataRequirements,
          candidateAgentIds: candidates.map((candidate) => candidate.agentId),
        });
        const eligible = new Set(plan.eligibleAgentIds);
        candidates = candidates.filter((candidate) => eligible.has(candidate.agentId));
      } catch (err) {
        const reason = `Data prerequisites block placement: ${errorMessage(err)}`;
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, undefined, reason);
        return {
          selectedAgentId: null,
          rejections: [{ stage: "data-prerequisite", agentId: "", reason }],
          dispatched: false,
        };
      }
    }
    if (candidates.length === 0) {
      if (sandboxExecution && liveCandidates.length > 0) {
        const reason = "No live Agent satisfies the Sandbox capability and signed runtime cache";
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, undefined, reason);
        return {
          selectedAgentId: null,
          rejections: liveCandidates.map((agent) => ({
            stage: "sandbox-capability",
            agentId: agent.agentId,
            reason,
          })),
          dispatched: false,
        };
      }
      if (onlineCandidates.length > 0) {
        logger.warn({ jobId }, "Online agents have no live Server channel; marking job failed");
        await this.deps.jobService.updateStatus(
          jobId,
          "failed",
          undefined,
          undefined,
          "No live agent channel is available for this job. Wait for the agent to reconnect and retry.",
        );
        return { selectedAgentId: null, rejections: [], dispatched: false };
      }
      logger.warn({ jobId }, "No online agents — job remains pending");
      return { selectedAgentId: null, rejections: [], dispatched: false };
    }

    const preferences = await this.deps.preferenceService.resolveEffective(orgId, userId);
    const schedulingIntent = await this.validateSchedulingIntent({ job, userId, userRole, orgId });

    const placedJob = await this.withDerivedDataSites(job);

    // Load data needed by the real filter implementations
    const agentIds = candidates.map((a) => a.agentId);
    const agentSoftwareMap = await this.loadAgentSoftware(agentIds);
    const softwareAvailability = await this.loadSoftwareAvailability(placedJob, agentIds, {
      userId,
      userRole,
      orgId,
    });
    const quotaMap = await this.loadQuotas(userId, orgId);
    const activeJobsByAgent = await this.loadActiveJobsByAgent(agentIds);
    const autoQueueRejections = await this.loadAutoQueueRejections(candidates);

    const sink = new Map<string, number>();
    const stages = this.buildStages(
      sink,
      agentSoftwareMap,
      softwareAvailability,
      quotaMap,
      activeJobsByAgent,
      autoQueueRejections,
    );

    // run the trace path (collect every stage's outcome) so we
    // can persist a complete audit trail on the job. The trace's
    // `finalDecision` is the canonical winner; we still derive a flat
    // `rejections` array from it for the existing /api/jobs response shape
    // so legacy consumers don't break.
    const trace = withPreferredQueueRejections(
      await runPlacementWithTrace({
        candidates,
        context: {
          job: placedJob,
          preferences,
          userRole,
          userId,
          orgId,
          queueSelection: schedulingIntent.queueSelection,
          preferredQueueSelections: schedulingIntent.preferredQueueSelections,
          ...(preferredAgentIds && preferredAgentIds.length > 0 ? { preferredAgentIds } : {}),
        },
        stages,
        scoreSink: sink,
        preview: false,
      }),
      schedulingIntent.preferredQueueRejections,
    );

    const rejections: RejectionTrace[] = trace.stages.flatMap((stage) =>
      stage.rejected.map((r) => ({
        stage: stage.name,
        agentId: r.agent.agentId,
        reason: r.reason,
      })),
    );

    if (!trace.finalDecision) {
      logger.info({ jobId, rejections: rejections.length }, "Placement found no eligible agent");
      // Preserve rejection traces so callers can explain why no target was selected.
      try {
        await this.deps.jobService.setPlacementTrace(jobId, trace);
      } catch (err) {
        logger.warn({ jobId, err }, "Failed to persist placement trace for unplaced job");
      }
      await this.deps.jobService.updateStatus(
        jobId,
        "failed",
        undefined,
        undefined,
        "No eligible agent found for this job. Open the placement tab for rejection details.",
      );
      return { selectedAgentId: null, rejections, dispatched: false, trace };
    }

    const agentId = trace.finalDecision.agentId;
    const selectedAgent = candidates.find((candidate) => candidate.agentId === agentId);
    if (!selectedAgent) {
      throw new Error(`Placement selected unknown agent ${agentId}`);
    }
    const selectedQueue =
      schedulingIntent.queueSelection ??
      schedulingIntent.preferredQueueSelections.find(
        (queue) =>
          queue.agentId === agentId && queue.schedulerType === trace.finalDecision?.schedulerType,
      );
    let dispatchQueue: QueueDispatchTarget | QueueSelection | undefined = selectedQueue;
    try {
      dispatchQueue ??= await this.deps.queueRegistry?.resolveAutoTarget(
        agentId,
        selectedAgent.schedulerType,
      );
    } catch (error) {
      const reason = `Queue validation blocks dispatch: ${errorMessage(error)}`;
      await this.deps.jobService.updateStatus(jobId, "failed", undefined, undefined, reason);
      return { selectedAgentId: null, rejections, dispatched: false, trace };
    }
    const queueTargetMode = dispatchQueue?.targetMode ?? "default";
    const assigned = await this.deps.jobService.assignToAgent(
      jobId,
      agentId,
      selectedAgent.providerOrgId,
      {
        targetMode: queueTargetMode,
        schedulerQueueName: dispatchQueue?.resolvedQueueName ?? dispatchQueue?.queueName ?? null,
        observedAt: dispatchQueue?.queueObservedAt ?? null,
      },
    );
    try {
      await this.deps.jobService.setPlacementTrace(jobId, trace);
    } catch (err) {
      logger.warn({ jobId, err }, "Failed to persist placement trace");
    }

    let licensedMaterialMounts: LicensedMaterialDispatchMount[] = [];
    if (this.deps.dataPrerequisites && dataRequirements.length > 0) {
      try {
        await this.deps.dataPrerequisites.verifyBeforeDispatch({
          actorUserId: userId,
          orgId,
          requirements: dataRequirements,
          agentId,
        });
      } catch (err) {
        const reason = `Data prerequisites block dispatch: ${errorMessage(err)}`;
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, agentId, reason);
        return { selectedAgentId: agentId, rejections, dispatched: false, trace };
      }
    }
    if ((job.licensedMaterials?.length ?? 0) > 0) {
      if (!this.deps.resolveLicensedMaterials) {
        const reason = "Licensed material resolution is unavailable";
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, agentId, reason);
        return { selectedAgentId: agentId, rejections, dispatched: false, trace };
      }
      try {
        licensedMaterialMounts = await this.deps.resolveLicensedMaterials({
          requests: job.licensedMaterials ?? [],
          providerOrgId: selectedAgent.providerOrgId,
          agentId,
          consumerEntitlementSubjectIds: [userId, ...(orgId ? [orgId] : [])],
        });
      } catch (error) {
        const reason = `Licensed material prerequisites block dispatch: ${errorMessage(error)}`;
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, agentId, reason);
        return { selectedAgentId: agentId, rejections, dispatched: false, trace };
      }
    }
    let dataDeliveries: ResolvedDataDelivery[] = [];
    if (dataRequirements.length > 0) {
      if (!this.dataDeliveryResolver) {
        const reason = "Data Market delivery resolver is unavailable";
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, agentId, reason);
        return { selectedAgentId: agentId, rejections, dispatched: false, trace };
      }
      try {
        dataDeliveries = await this.dataDeliveryResolver({
          jobId,
          actorUserId: userId,
          orgId,
          agentId,
        });
      } catch (error) {
        const reason = `Data delivery prerequisites block dispatch: ${errorMessage(error)}`;
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, agentId, reason);
        return { selectedAgentId: agentId, rejections, dispatched: false, trace };
      }
    }
    let signedSandbox: SandboxSignedManifest | undefined;
    let restrictedSandboxInputs: DispatchInputStaging[] = [];
    if (sandboxExecution) {
      try {
        signedSandbox = await sandboxExecution.build({
          agentId,
          schedulerType: selectedAgent.schedulerType,
          providerOrgId: selectedAgent.providerOrgId,
          clusterId: selectedAgent.clusterId,
          ...(dispatchQueue?.queueName ? { queueName: dispatchQueue.queueName } : {}),
          ...(dispatchQueue?.qos ? { qos: dispatchQueue.qos } : {}),
        });
        assertSandboxDataDeliveryMode(restrictedNoEgress, dataDeliveries.length);
        if (dataDeliveries.length > 0) {
          if (!this.restrictedSandboxDeliveryBinder) {
            throw new Error(
              "Restricted Data Market delivery requires a signed Sandbox input binder",
            );
          }
          const bound = this.restrictedSandboxDeliveryBinder(signedSandbox, dataDeliveries);
          signedSandbox = bound.manifest;
          restrictedSandboxInputs = bound.inputStaging;
          dataDeliveries = [];
        }
        await this.deps.jobService.setSandboxExecution(jobId, signedSandbox);
      } catch (err) {
        const reason = `Sandbox manifest construction failed: ${errorMessage(err)}`;
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, agentId, reason);
        return { selectedAgentId: agentId, rejections, dispatched: false, trace };
      }
    }
    const files = job.inputStaging ?? [];
    const usesAgentManagedWorkRoot = dataDeliveries.length > 0 || licensedMaterialMounts.length > 0;
    if (
      usesAgentManagedWorkRoot &&
      (files.length > 0 || (job.fileOutputDescriptors?.length ?? 0) > 0)
    ) {
      const reason =
        "Data Market execution cannot mix Agent-managed data with NetDrive file inputs or artifact outputs";
      await this.deps.jobService.updateStatus(jobId, "failed", undefined, agentId, reason);
      return { selectedAgentId: agentId, rejections, dispatched: false, trace };
    }
    let dispatchInputStaging: DispatchInputStaging[] | undefined = job.inputStaging;
    const needsDispatchInputUrls =
      files.length > 0 && (sandboxExecution !== undefined || !job.workingDir);
    if (needsDispatchInputUrls) {
      if (!this.inputUrlResolver) {
        const reason = "Artifact inputs require signed NetDrive download URLs";
        await this.deps.jobService.updateStatus(jobId, "failed", undefined, agentId, reason);
        return { selectedAgentId: agentId, rejections, dispatched: false, trace };
      }
      try {
        dispatchInputStaging = await this.inputUrlResolver({
          jobId,
          workflowRunId,
          actorUserId: userId,
          files,
        });
      } catch (err) {
        logger.error(
          { jobId, agentId, err },
          "Input URL resolution failed — job will not be dispatched",
        );
        await this.deps.jobService.updateStatus(
          jobId,
          "failed",
          undefined,
          agentId,
          `Input URL resolution failed: ${errorMessage(err)}`,
        );
        return { selectedAgentId: agentId, rejections, dispatched: false, trace };
      }
    } else if (files.length > 0 && this.inputStager) {
      try {
        await this.inputStager({
          jobId,
          workflowRunId,
          agentId,
          actorUserId: userId,
          workingDir: job.workingDir ?? "",
          files,
        });
      } catch (err) {
        logger.error({ jobId, agentId, err }, "Input staging failed — job will not be dispatched");
        await this.deps.jobService.updateStatus(
          jobId,
          "failed",
          undefined,
          undefined,
          `Input staging failed: ${errorMessage(err)}`,
        );
        return { selectedAgentId: agentId, rejections, dispatched: false, trace };
      }
    }
    if (restrictedSandboxInputs.length > 0) {
      dispatchInputStaging = [...(dispatchInputStaging ?? []), ...restrictedSandboxInputs];
    }
    try {
      await this.deps.queueRegistry?.assertDispatchTargetAvailable({
        agentId,
        schedulerType: selectedAgent.schedulerType,
        targetMode: queueTargetMode,
        ...(dispatchQueue?.queueName ? { queueName: dispatchQueue.queueName } : {}),
      });
    } catch (error) {
      const reason = `Queue validation blocks dispatch: ${errorMessage(error)}`;
      await this.deps.jobService.updateStatus(jobId, "failed", undefined, agentId, reason);
      return { selectedAgentId: agentId, rejections, dispatched: false, trace };
    }
    const dispatchClaimed = await this.deps.jobService.claimDispatchEpoch(
      jobId,
      assigned.dispatchEpoch,
    );
    if (!dispatchClaimed) {
      return { selectedAgentId: agentId, rejections, dispatched: false, trace };
    }
    const ok = this.deps.dispatcher.pushDispatchJob(agentId, jobId, {
      jobIdInternal: jobId,
      dispatchEpoch: assigned.dispatchEpoch,
      name: job.name,
      command: job.command,
      resources: job.resources,
      workingDir: job.workingDir,
      envVars: job.envVars,
      inputStaging: dispatchInputStaging,
      expectedOutputs: job.expectedOutputs,
      fileOutputDescriptors: job.fileOutputDescriptors,
      stdinText: job.stdinText,
      queueName: dispatchQueue?.queueName,
      queueTargetMode,
      queueValidationMode: dispatchQueue?.validationMode ?? "off",
      qos: dispatchQueue?.qos,
      sandboxExecution: signedSandbox,
      licensedMaterialMounts,
      restrictedNoEgress,
      dataDeliveries,
    });
    if (!ok) {
      // Assigned but the channel was gone: don't leave a "queued" row that no
      // agent will ever run. Mark failed so it matches the workflow node outcome.
      // Dispatch fails immediately when no Agent channel is available.
      logger.warn({ jobId, agentId }, "Selected agent has no live channel; marking job failed");
      await this.deps.jobService.updateStatus(
        jobId,
        "failed",
        undefined,
        agentId,
        "Selected agent channel is unavailable; the job was not dispatched.",
      );
    }

    logger.info({ jobId, agentId, dispatched: ok }, "Job placement complete");
    return { selectedAgentId: agentId, rejections, dispatched: ok, trace };
  }

  /**
   * return the canonical filter array shared between the
   * dispatch path (PlacementPipeline) and the explainability path
   * (runPlacementWithTrace). Keeping a single source means the trace and the
   * actual placement decision can never drift.
   */
  private buildStages(
    sink: Map<string, number>,
    agentSoftwareMap: Map<string, Set<string>>,
    softwareAvailability: Map<string, Map<string, string[]>>,
    quotaMap: Map<string, number>,
    activeJobsByAgent: Map<string, number>,
    autoQueueRejections: Map<string, string>,
  ): FilterStage[] {
    return [
      new ComputeHealthFilter(this.deps.computeHealth),
      new PermissionFilter(),
      new QueueFilter({ autoDefaultRejections: autoQueueRejections }),
      new SoftwareFilter({ agentSoftware: agentSoftwareMap, availability: softwareAvailability }),
      new BillingFilter({ quotas: quotaMap }),
      new LoadFilter(),
      new UrgencyFilter((agentId) => activeJobsByAgent.get(agentId) ?? 0),
      new InstallRightsFilter(),
      new ManualFilter(),
      new AutoFilter(sink),
    ];
  }

  /**
   * run the full pipeline in collect-all-stages mode and
   * return a `PlacementTrace` for UI consumption. Used by both the
   * pre-submit `POST /api/scheduler/preview-placement` endpoint (preview =
   * true, no DB persistence) and the post-submit dispatch path (preview =
   * false, persisted on the job by `placeAndDispatch`).
   *
   * The decision a caller acts on (e.g. dispatch the job to which agent) is
   * `trace.finalDecision`. The same data structure also explains each stage
   * for the audit / preview UI.
   */
  async runWithTrace(input: {
    job: JobSubmit;
    userId: string;
    userRole: RoleName;
    orgId: string | null;
    preview: boolean;
  }): Promise<PlacementTrace> {
    const { job, userId, userRole, orgId, preview } = input;

    let candidates = (await this.deps.agentManager.listOnline()).filter((agent) =>
      this.deps.dispatcher.isOnline(agent.agentId),
    );
    const dataRequirements = dataRequirementsFromJob(job);
    if (this.deps.dataPrerequisites && dataRequirements.length > 0) {
      const plan = await this.deps.dataPrerequisites.prepare({
        actorUserId: userId,
        orgId,
        requirements: dataRequirements,
        candidateAgentIds: candidates.map((candidate) => candidate.agentId),
      });
      const eligible = new Set(plan.eligibleAgentIds);
      candidates = candidates.filter((candidate) => eligible.has(candidate.agentId));
    }
    const preferences = await this.deps.preferenceService.resolveEffective(orgId, userId);
    const schedulingIntent = await this.validateSchedulingIntent({ job, userId, userRole, orgId });

    const agentIds = candidates.map((a) => a.agentId);
    const agentSoftwareMap = await this.loadAgentSoftware(agentIds);
    const softwareAvailability = await this.loadSoftwareAvailability(job, agentIds, {
      userId,
      userRole,
      orgId,
    });
    const quotaMap = await this.loadQuotas(userId, orgId);
    const activeJobsByAgent = await this.loadActiveJobsByAgent(agentIds);
    const autoQueueRejections = await this.loadAutoQueueRejections(candidates);

    const sink = new Map<string, number>();
    const stages = this.buildStages(
      sink,
      agentSoftwareMap,
      softwareAvailability,
      quotaMap,
      activeJobsByAgent,
      autoQueueRejections,
    );

    return withPreferredQueueRejections(
      await runPlacementWithTrace({
        candidates,
        context: {
          job,
          preferences,
          userRole,
          userId,
          orgId,
          queueSelection: schedulingIntent.queueSelection,
          preferredQueueSelections: schedulingIntent.preferredQueueSelections,
        },
        stages,
        scoreSink: sink,
        preview,
      }),
      schedulingIntent.preferredQueueRejections,
    );
  }

  /**
   * Load all software installed on the given agents from the current
   * agent_installed_software ledger and the legacy agent_software table.
   * Returns a Map<agentId, Set<"name@version">>.
   */
  private async loadAgentSoftware(agentIds: string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (!this.deps.db || agentIds.length === 0) return result;

    const [reportedRows, legacyRows] = await Promise.all([
      this.deps.db
        .select()
        .from(agentInstalledSoftware)
        .where(inArray(agentInstalledSoftware.agentId, agentIds)),
      this.deps.db.select().from(agentSoftware).where(inArray(agentSoftware.agentId, agentIds)),
    ]);

    for (const row of reportedRows) {
      if (!result.has(row.agentId)) {
        result.set(row.agentId, new Set());
      }
      result.get(row.agentId)?.add(row.spec);
      result.get(row.agentId)?.add(`${row.name}@${row.version}`);
    }
    for (const row of legacyRows) {
      const key = `${row.softwareName}@${row.softwareVersion}`;
      if (!result.has(row.agentId)) {
        result.set(row.agentId, new Set());
      }
      result.get(row.agentId)?.add(key);
    }
    return result;
  }

  private async loadSoftwareAvailability(
    job: JobSubmit,
    agentIds: string[],
    principal: { userId: string; userRole: RoleName; orgId: string | null },
  ): Promise<Map<string, Map<string, string[]>>> {
    const result = new Map<string, Map<string, string[]>>();
    if (!this.deps.softwareAvailability || agentIds.length === 0) return result;

    await Promise.all(
      (job.softwareRequirements ?? []).map(async (req) => {
        const key = req.version ? `${req.name}@${req.version}` : req.name;
        const response = await this.deps.softwareAvailability?.resolve(
          availabilityRequestForRequirement(req, agentIds),
          {
            sub: principal.userId,
            role: principal.userRole,
            email: `${principal.userId}@local`,
            userId: principal.userId,
            orgId: principal.orgId,
            orgIds: principal.orgId ? [principal.orgId] : [],
            memberships: principal.orgId ? [{ orgId: principal.orgId, role: "member" }] : [],
            capabilities: [],
          },
        );
        const reasonsByAgent = new Map<string, string[]>();
        for (const blocked of response?.blocked ?? []) {
          reasonsByAgent.set(blocked.agentId, blocked.reasons);
        }
        result.set(key, reasonsByAgent);
      }),
    );

    return result;
  }

  /**
   * Load credit quotas for the given user and org from usage_quotas table.
   * Returns a Map<"scope:scopeId", remainingCreditUnits>.
   */
  private async loadQuotas(userId: string, orgId: string | null): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!this.deps.db) return result;

    const conditions = [
      and(eq(usageQuotas.scope, "user"), eq(usageQuotas.scopeId, userId)),
      ...(orgId ? [and(eq(usageQuotas.scope, "org"), eq(usageQuotas.scopeId, orgId))] : []),
    ];

    const rows = await this.deps.db
      .select()
      .from(usageQuotas)
      .where(or(...conditions));

    for (const row of rows) {
      result.set(`${row.scope}:${row.scopeId}`, row.remainingCreditUnits);
    }
    return result;
  }

  private async loadAutoQueueRejections(candidates: AgentRow[]): Promise<Map<string, string>> {
    const queueRegistry = this.deps.queueRegistry;
    if (
      !queueRegistry ||
      typeof queueRegistry.autoCandidateRejection !== "function" ||
      candidates.length === 0
    ) {
      return new Map();
    }
    const outcomes = await Promise.all(
      candidates.map(async (candidate) => ({
        agentId: candidate.agentId,
        reason: await queueRegistry.autoCandidateRejection(
          candidate.agentId,
          candidate.schedulerType,
        ),
      })),
    );
    const rejections = new Map<string, string>();
    for (const outcome of outcomes) {
      if (outcome.reason) rejections.set(outcome.agentId, outcome.reason);
    }
    return rejections;
  }

  /**
   * Count running+queued jobs per agent to feed UrgencyFilter.
   */
  private async loadActiveJobsByAgent(agentIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!this.deps.db || agentIds.length === 0) return result;

    const rows = await this.deps.db
      .select({ agentId: jobs.agentId, status: jobs.status })
      .from(jobs)
      .where(
        and(
          inArray(jobs.agentId, agentIds),
          or(eq(jobs.status, "running"), eq(jobs.status, "queued")),
        ),
      );

    for (const row of rows) {
      if (!row.agentId) continue;
      result.set(row.agentId, (result.get(row.agentId) ?? 0) + 1);
    }
    return result;
  }
}

export function availabilityRequestForRequirement(
  requirement: NonNullable<JobSubmit["softwareRequirements"]>[number],
  agentIds: string[],
): SoftwareAvailabilityRequest {
  const rawSpec = requirement.version
    ? `${requirement.name}@${requirement.version}`
    : requirement.name;
  return {
    rawSpec,
    ...(requirement.assetId
      ? { assetRef: { kind: "spack-package" as const, id: requirement.assetId } }
      : {}),
    targetAgentIds: agentIds,
    installable: requirement.installable ?? false,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function dataRequirementsFromJob(job: JobSubmit): DataRequirement[] {
  return Object.values(job.dataInputs ?? {}).flatMap((input) => {
    if (input.source !== "data-market") return [];
    return [
      {
        assetId: input.assetId,
        versionId: input.versionId,
        manifestDigest: input.manifestDigest,
        ...(input.selectedEntries.length > 0 ? { requiredPaths: input.selectedEntries } : {}),
      },
    ];
  });
}
