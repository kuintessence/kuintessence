import { createHash } from "node:crypto";
import { agents, netdriveFiles, type PgDb } from "@kuintessence/db";
import {
  createLogger,
  DataInputRefSchema,
  type EffectiveSandboxPolicy,
  type ExecutionIdentity,
  type JobDataInputs,
  type JobStatusName,
  type NodeExecutionResult,
  type RoleName,
  type SandboxDispatchIdentity,
  type SandboxDispatchMount,
  type SandboxExecutionMode,
  SandboxRuntimeAttestationIdSchema,
  SandboxSelfAccountSchema,
  SandboxTrustedExecutionProfileSchema,
  workflowDsl,
} from "@kuintessence/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { JobService } from "./job-service";
import {
  type LicenseRuntimeGovernanceService,
  sandboxRuntimeContractKey,
} from "./license-runtime-governance";
import type { PlacementOrchestrator } from "./placement-orchestrator";
import type {
  ResolvedSandboxRuntime,
  ResolvedSandboxSource,
  SandboxExecutionResolver,
} from "./sandbox-execution-resolver";
import { type SandboxManifestSigner, sandboxBundleSha256 } from "./sandbox-manifest-signer";
import type { WorkflowArtifactService } from "./workflow-artifact";

const logger = createLogger("sandbox-node-executor");

interface CompletionResult {
  status: JobStatusName;
  collected: Record<string, string>;
  errorMessage?: string;
  reason?: string;
  exitCode?: number;
}

const SANDBOX_NOT_DISPATCHED_MESSAGE =
  "Sandbox job was not dispatched because no eligible compute resource was available.";

function completionFailureMessage(completion: CompletionResult): string {
  const message = completion.errorMessage?.trim() || completion.reason?.trim();
  if (message) return message;
  if (completion.exitCode !== undefined) {
    return `Sandbox job exited with code ${completion.exitCode}.`;
  }
  return `Sandbox job ended with status '${completion.status}'.`;
}

export interface SandboxNodeExecutorOptions {
  db: PgDb;
  resolver: SandboxExecutionResolver;
  signer: SandboxManifestSigner;
  jobService: JobService;
  orchestrator: PlacementOrchestrator;
  artifactService: WorkflowArtifactService;
  awaitCompletion(jobId: string): Promise<CompletionResult>;
  submittedBy: string;
  orgId?: string | null;
  userRole: RoleName;
  authorizeJobSubmission(input: {
    jobId: string;
    orgId: string | null;
    queueId: string | null;
  }): Promise<void>;
  workflowRunId: string;
  defaultExecutionIdentity: ExecutionIdentity;
  resolvePolicy(target: {
    providerOrgId: string | null;
    clusterId: string | null;
    agentId: string;
  }): Promise<EffectiveSandboxPolicy>;
  resolvePlannedAgents?(nodeId: string): Promise<string[]>;
  recordExecutionStats?(input: {
    assetRevisionId: string | null;
    inlineScriptHash: string | null;
    runtimeProfileId: string;
    inputBytes: number;
    predictedOutputBytes: number;
    actualOutputBytes: number;
    succeeded: boolean;
  }): Promise<void>;
  limits: { pids: number; outputBytes: number; logBytes: number };
  governance?: LicenseRuntimeGovernanceService;
}

interface PreparedInputs {
  mounts: SandboxDispatchMount[];
  inputStaging: { fileMetadataId: string; stagePath: string }[];
  dataInputs: JobDataInputs;
  bytesByDescriptor: Record<string, number>;
}

interface SandboxArtifactFact {
  descriptor: string;
  sha256: string;
  sizeBytes: number;
  storageRef: string;
}

interface SelectedSandboxAgentFacts {
  rootMode: boolean;
  sandboxCapabilities: unknown;
  sandboxRuntimeCache: unknown;
}

interface SelfAccountExecutionFacts {
  executionMode: "SelfAccount";
  runtimeAttestationId: string;
}

interface RootImpersonationExecutionFacts {
  executionMode: "RootImpersonation";
}

interface SelfAccountManifestInput {
  jobId: string;
  source: ResolvedSandboxSource;
  scriptContent: Uint8Array;
  bundleSha256: string;
  runtime: ResolvedSandboxRuntime;
  runtimeDigest: { kind: "OCI" | "SIF"; digest: string };
  identity: SandboxDispatchIdentity;
  preparedInputs: PreparedInputs;
  outputMounts: SandboxDispatchMount[];
  policy: EffectiveSandboxPolicy;
  runtimeAttestationId: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function selectedExecutionMode(capabilities: unknown): SandboxExecutionMode {
  const value = objectValue(capabilities)?.executionMode;
  if (value === "RootImpersonation" || value === "SelfAccount") return value;
  throw new Error("Selected Agent does not advertise a supported Sandbox execution mode");
}

function hasFreshRuntimeAttestation(
  raw: unknown,
  runtime: { kind: "OCI" | "SIF"; digest: string },
  nowUnixMs: number,
): string | undefined {
  const entry = objectValue(raw);
  if (
    entry?.kind !== runtime.kind ||
    entry.digest !== runtime.digest ||
    entry.signatureVerified !== true ||
    !Array.isArray(entry.attestedNodes) ||
    !entry.attestedNodes.some((node) => typeof node === "string" && node.trim().length > 0) ||
    typeof entry.expiresAtUnixMs !== "number" ||
    !Number.isSafeInteger(entry.expiresAtUnixMs) ||
    entry.expiresAtUnixMs <= nowUnixMs
  ) {
    return undefined;
  }
  const attestation = SandboxRuntimeAttestationIdSchema.safeParse(entry.runtimeAttestationId);
  return attestation.success ? attestation.data : undefined;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function resolveBinding(binding: unknown, ctx: Record<string, workflowDsl.CelValue>) {
  const value = binding as Record<string, unknown>;
  if (typeof value.expr === "string") return workflowDsl.evalCel(value.expr, ctx);
  if (typeof value.param === "string") {
    return (ctx.params as Record<string, workflowDsl.CelValue> | undefined)?.[value.param];
  }
  if (typeof value.node === "string" && typeof value.output === "string") {
    const nodes = ctx.nodes as
      | Record<string, { status?: string; values?: Record<string, workflowDsl.CelValue> }>
      | undefined;
    const node = nodes?.[value.node];
    return node?.status === "Succeeded" ? node.values?.[value.output] : undefined;
  }
  return undefined;
}

function resolveSlotValue(
  slot: workflowDsl.NodeInputSlot | undefined,
  ctx: Record<string, workflowDsl.CelValue>,
) {
  if (!slot) return undefined;
  if (slot.from) return resolveBinding(slot.from, ctx);
  if (slot.sources && slot.sources.length > 0) {
    const available = slot.sources
      .map((source) => resolveBinding(source, ctx))
      .filter((value) => value !== undefined);
    if (slot.select === "RequireExactlyOne" && available.length !== 1) {
      throw new Error(`Script input '${slot.descriptor}' requires exactly one available source`);
    }
    return available[0];
  }
  if (slot.type === "File" && slot.contents) return slot.isBatch ? slot.contents : slot.contents[0];
  return undefined;
}

function fileMetadataIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = (item as Record<string, unknown>).fileMetadataId;
    return typeof id === "string" ? [id] : [];
  });
}

function batchSha256(entries: Array<{ relativePath: string; sha256: string; sizeBytes: number }>) {
  const hash = createHash("sha256");
  for (const entry of entries.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(`${entry.relativePath}\0${entry.sizeBytes}\0${entry.sha256}\n`);
  }
  return hash.digest("hex");
}

function artifactFact(value: string | undefined, descriptor: string): SandboxArtifactFact {
  if (!value) throw new Error(`Sandbox output '${descriptor}' lacks a verified artifact fact`);
  const parsed = JSON.parse(value) as Partial<SandboxArtifactFact>;
  if (
    parsed.descriptor !== descriptor ||
    typeof parsed.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.sha256) ||
    !Number.isSafeInteger(parsed.sizeBytes) ||
    (parsed.sizeBytes ?? -1) < 0 ||
    typeof parsed.storageRef !== "string" ||
    parsed.storageRef.length === 0
  ) {
    throw new Error(`Sandbox output '${descriptor}' returned an invalid artifact fact`);
  }
  return parsed as SandboxArtifactFact;
}

const OUTPUT_SIZE_CLASS_BYTES = {
  Tiny: 1_024,
  Small: 1_048_576,
  Medium: 104_857_600,
  Large: 1_073_741_824,
  Huge: 10_737_418_240,
  Unknown: 1_048_576,
} as const;

function predictedOutputBytes(
  node: Extract<workflowDsl.WorkflowNode, { type: "Script" }>,
  inputBytes: Record<string, number>,
): number {
  return Object.values(node.outputs).reduce((total, output) => {
    if (output.sizeHint.type === "FixedBytes") return total + output.sizeHint.bytes;
    if (output.sizeHint.type === "InputRatio") {
      return total + Math.round((inputBytes[output.sizeHint.input] ?? 0) * output.sizeHint.ratio);
    }
    return total + OUTPUT_SIZE_CLASS_BYTES[output.sizeHint.value];
  }, 0);
}

export class SandboxNodeExecutor {
  constructor(private readonly options: SandboxNodeExecutorOptions) {}

  async execute(
    node: Extract<workflowDsl.WorkflowNode, { type: "Script" }>,
    ctx: Record<string, workflowDsl.CelValue>,
  ): Promise<NodeExecutionResult> {
    if (!node.source) {
      throw new Error("Sandbox Script must resolve source and runtime references before execution");
    }
    const source = await this.options.resolver.resolveSource(node, this.options.submittedBy);
    const runtimeContractRef = node.runtimeContractRef ?? source.runtimeContractRef;
    const preferredAgentIds = await this.options.resolvePlannedAgents?.(node.id);
    const plannedAgentId = preferredAgentIds?.[0];
    const runtime = node.runtimeProfileId
      ? await this.options.resolver.resolveRuntime(node.runtimeProfileId)
      : runtimeContractRef && plannedAgentId
        ? await this.options.resolver.resolveRuntimeForAgent({
            runtimeContractRef,
            agentId: plannedAgentId,
          })
        : (() => {
            throw new Error(
              "Sandbox Script runtime contract requires a concrete planned Agent before dispatch",
            );
          })();
    if (source.language !== runtime.language) {
      throw new Error("Sandbox script language does not match its runtime profile");
    }
    const preparedInputs = await this.prepareInputs(node, ctx);
    const totalInputBytes = Object.values(preparedInputs.bytesByDescriptor).reduce(
      (total, bytes) => total + bytes,
      0,
    );
    const predictedBytes = predictedOutputBytes(node, preparedInputs.bytesByDescriptor);
    const outputMounts = Object.entries(node.outputs).map(([descriptor, output]) => ({
      descriptor,
      ioType: output.type,
      mode: "WriteOnly" as const,
      relativePath: `outputs/${descriptor}`,
      containerPath: `/kq/outputs/${descriptor}`,
      expectedSha256: null,
      inlineContentBase64: null,
      batchEntries: [],
      sizeLimitBytes: this.options.limits.outputBytes,
      required: output.required,
    }));
    const requestedIdentity =
      node.executionIdentity.type === "Inherit"
        ? this.options.defaultExecutionIdentity
        : node.executionIdentity;
    const job = await this.options.jobService.submit(
      {
        name: node.name,
        command: "sandbox-manifest",
        resources: {
          cpus: Math.max(1, node.requirements?.cpuCores ?? 1),
          memoryMb: 1024,
          ...(node.requirements?.maxWallTime != null
            ? { wallTimeSec: node.requirements.maxWallTime }
            : {}),
        },
        envVars: {},
        inputStaging: preparedInputs.inputStaging,
        ...(Object.keys(preparedInputs.dataInputs).length > 0
          ? { dataInputs: preparedInputs.dataInputs }
          : {}),
        expectedOutputs: Object.entries(node.outputs)
          .filter(([, output]) => output.type === "Text" || output.type === "JSON")
          .map(([descriptor]) => ({
            descriptor,
            path: `outputs/${descriptor}`,
            isBatch: false,
          })),
        ...(node.schedulingStrategy.type === "Manual" && node.schedulingStrategy.queues[0]
          ? { schedulingStrategy: { queueId: node.schedulingStrategy.queues[0] } }
          : {}),
      },
      this.options.submittedBy,
      {
        ...(this.options.orgId !== undefined ? { orgId: this.options.orgId } : {}),
        trustedMaterialization: source.assetRevisionId !== null,
        ...(source.assetRevisionId
          ? {
              trustedSandboxScript: {
                revisionId: source.assetRevisionId,
                sha256: source.sha256,
              },
            }
          : {}),
        workflow: {
          runId: this.options.workflowRunId,
          nodeId: node.id,
        },
      },
    );
    await this.options.authorizeJobSubmission({
      jobId: job.id,
      orgId: job.orgId,
      queueId: job.queueId,
    });
    const scriptContent = Buffer.from(source.content, "utf8");
    const bundleSha256 = sandboxBundleSha256({
      language: source.language,
      entrypoint: source.entrypoint,
      sha256: source.sha256,
    });
    const dispatch = await this.options.orchestrator.placeAndDispatch({
      jobId: job.id,
      restrictedNoEgress: job.restrictedNoEgress,
      workflowRunId: this.options.workflowRunId,
      job: {
        name: job.name,
        command: job.command,
        resources: {
          cpus: job.cpus,
          memoryMb: job.memoryMb,
          gpus: job.gpus ?? 0,
          wallTimeSec: Number(job.wallTimeSec ?? 0),
        },
        workingDir: job.workingDir ?? undefined,
        envVars: {},
        inputStaging: preparedInputs.inputStaging,
        expectedOutputs: job.expectedOutputs ?? [],
        ...(job.queueId ? { schedulingStrategy: { queueId: job.queueId } } : {}),
      },
      userId: this.options.submittedBy,
      userRole: this.options.userRole,
      orgId: job.orgId,
      ...(preferredAgentIds && preferredAgentIds.length > 0 ? { preferredAgentIds } : {}),
      sandboxExecution: {
        runtimeDigests: {
          ...(runtime.ociDigest ? { OCI: runtime.ociDigest } : {}),
          ...(runtime.sifDigest ? { SIF: runtime.sifDigest } : {}),
        },
        build: async (selected) => {
          const selectedRuntime = runtimeContractRef
            ? await this.options.resolver.resolveRuntimeForTarget({
                runtimeContractRef,
                agentId: selected.agentId,
                providerOrgId: selected.providerOrgId,
                clusterId: selected.clusterId,
                schedulerType: selected.schedulerType,
              })
            : runtime;
          if (runtimeContractRef && this.options.governance) {
            const blocks = await this.options.governance.evaluateRuntime({
              contractId: sandboxRuntimeContractKey(runtimeContractRef),
              providerOrgId: selected.providerOrgId,
              agentId: selected.agentId,
              clusterId: selected.clusterId,
              runtimeProfileId: selectedRuntime.id,
            });
            if (blocks.length > 0) {
              throw new Error(
                `Sandbox runtime prerequisites block dispatch: ${blocks.map((block) => block.code).join(", ")}`,
              );
            }
          }
          const policy = await this.options.resolvePolicy({
            providerOrgId: selected.providerOrgId,
            clusterId: selected.clusterId,
            agentId: selected.agentId,
          });
          if (!policy.sandboxEnabled) throw new Error("Sandbox is disabled by effective policy");
          if (policy.disabledRuntimeProfileIds.includes(selectedRuntime.id)) {
            throw new Error("Sandbox runtime is disabled by effective policy");
          }
          if (
            job.cpus > policy.limits.maxCpuCores ||
            job.memoryMb > policy.limits.maxMemoryMb ||
            Number(job.wallTimeSec ?? 0) > policy.limits.maxWallTimeSec
          ) {
            throw new Error("Sandbox resource request exceeds effective policy limits");
          }
          const selectedRuntimeDigest = this.options.resolver.runtimeForScheduler(
            selectedRuntime,
            selected.schedulerType,
          );
          const identity = await this.options.resolver.resolveIdentity({
            requested: requestedIdentity,
            userId: this.options.submittedBy,
            agentId: selected.agentId,
            providerOrgId: selected.providerOrgId,
            source,
            runtimeProfileId: selectedRuntime.id,
            runtimeDigest: selectedRuntimeDigest.digest,
          });
          if (identity.mode === "SharedService" && !policy.sharedServiceAllowed) {
            throw new Error("Shared service identity is disabled by effective policy");
          }
          const executionMode = await this.executionModeForSelectedAgent({
            agentId: selected.agentId,
            schedulerType: selected.schedulerType,
            identity,
            runtime: selectedRuntimeDigest,
            policy,
            restrictedNoEgress: job.restrictedNoEgress === true,
          });
          if (
            executionMode.executionMode === "RootImpersonation" &&
            identity.backend === "Unix" &&
            !policy.impersonationEnabled
          ) {
            throw new Error("Unix account impersonation is disabled by effective policy");
          }
          if (executionMode.executionMode === "SelfAccount") {
            return this.signSelfAccountManifest({
              jobId: job.id,
              source,
              scriptContent,
              bundleSha256,
              runtime: selectedRuntime,
              runtimeDigest: selectedRuntimeDigest,
              identity,
              preparedInputs,
              outputMounts,
              policy,
              runtimeAttestationId: executionMode.runtimeAttestationId,
            });
          }
          const executionProfile = job.restrictedNoEgress
            ? await this.restrictedExecutionProfileForAgent(selected.agentId)
            : undefined;
          return this.options.signer.sign({
            jobId: job.id,
            script: {
              language: source.language,
              entrypoint: source.entrypoint,
              contentBase64: scriptContent.toString("base64"),
              sha256: source.sha256,
              bundleSha256,
            },
            runtime: {
              profileId: selectedRuntime.id,
              kind: selectedRuntimeDigest.kind,
              digest: selectedRuntimeDigest.digest,
            },
            executionMode: "RootImpersonation",
            ...(executionProfile ? { executionProfile } : {}),
            identity,
            mounts: [
              ...preparedInputs.mounts,
              ...outputMounts.map((mount) => ({
                ...mount,
                sizeLimitBytes: Math.min(mount.sizeLimitBytes, policy.limits.maxOutputBytes),
              })),
            ],
            limits: {
              pids: Math.min(this.options.limits.pids, policy.limits.maxPids),
              outputBytes: Math.min(this.options.limits.outputBytes, policy.limits.maxOutputBytes),
              logBytes: Math.min(this.options.limits.logBytes, policy.limits.maxLogBytes),
            },
            networkDisabled: true,
          });
        },
      },
    });
    if (!dispatch.dispatched || !dispatch.selectedAgentId) {
      return {
        status: "Failed",
        values: {},
        failure: { message: SANDBOX_NOT_DISPATCHED_MESSAGE, jobId: job.id },
      };
    }
    const completion = await this.options.awaitCompletion(job.id);
    if (completion.status !== "completed") {
      await this.recordStats({
        assetRevisionId: source.assetRevisionId,
        inlineScriptHash: source.assetRevisionId ? null : source.sha256,
        runtimeProfileId: runtime.id,
        inputBytes: totalInputBytes,
        predictedOutputBytes: predictedBytes,
        actualOutputBytes: 0,
        succeeded: false,
      });
      return {
        status: "Failed",
        values: {},
        failure: {
          message: completionFailureMessage(completion),
          jobId: job.id,
          ...(completion.exitCode !== undefined ? { exitCode: completion.exitCode } : {}),
        },
      };
    }
    const [agent] = await this.options.db
      .select({ siteId: agents.siteId, clusterId: agents.clusterId })
      .from(agents)
      .where(eq(agents.agentId, dispatch.selectedAgentId))
      .limit(1);
    if (!agent?.siteId || !agent.clusterId) throw new Error("Selected Agent lacks locality facts");
    const values: Record<string, workflowDsl.CelValue> = {};
    let actualOutputBytes = 0;
    for (const [descriptor, output] of Object.entries(node.outputs)) {
      const rawFact = completion.collected[`$sandbox-artifact:${descriptor}`];
      if (!rawFact && !output.required) continue;
      const fact = artifactFact(rawFact, descriptor);
      actualOutputBytes += fact.sizeBytes;
      const artifact = await this.options.artifactService.registerLocal({
        workflowRunId: this.options.workflowRunId,
        producerNodeId: node.id,
        descriptor,
        ioType: output.type,
        contentHash: fact.sha256,
        sizeBytes: fact.sizeBytes,
        durability: output.durability,
        ownerId: this.options.submittedBy,
        agentId: dispatch.selectedAgentId,
        siteId: agent.siteId,
        clusterId: agent.clusterId,
        storageRef: fact.storageRef,
      });
      if (output.type === "Text") values[descriptor] = completion.collected[descriptor] ?? "";
      else if (output.type === "JSON")
        values[descriptor] = JSON.parse(completion.collected[descriptor] ?? "null");
      else values[descriptor] = { artifactId: artifact.id, type: output.type };
    }
    await this.recordStats({
      assetRevisionId: source.assetRevisionId,
      inlineScriptHash: source.assetRevisionId ? null : source.sha256,
      runtimeProfileId: runtime.id,
      inputBytes: totalInputBytes,
      predictedOutputBytes: predictedBytes,
      actualOutputBytes,
      succeeded: true,
    });
    return { status: "Succeeded", values };
  }

  private async restrictedExecutionProfileForAgent(agentId: string) {
    const [agent] = await this.options.db
      .select({ sandboxCapabilities: agents.sandboxCapabilities })
      .from(agents)
      .where(eq(agents.agentId, agentId))
      .limit(1);
    const capability = agent?.sandboxCapabilities;
    const raw =
      capability && typeof capability === "object"
        ? (capability as Record<string, unknown>).restrictedExecutionProfile
        : undefined;
    const parsed = SandboxTrustedExecutionProfileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        "Restricted no-egress dispatch requires a ready compute-node trusted execution profile",
      );
    }
    return parsed.data;
  }

  private async executionModeForSelectedAgent(input: {
    agentId: string;
    schedulerType: string;
    identity: SandboxDispatchIdentity;
    runtime: { kind: "OCI" | "SIF"; digest: string };
    policy: EffectiveSandboxPolicy;
    restrictedNoEgress: boolean;
  }): Promise<SelfAccountExecutionFacts | RootImpersonationExecutionFacts> {
    const [agent] = await this.options.db
      .select({
        rootMode: agents.rootMode,
        sandboxCapabilities: agents.sandboxCapabilities,
        sandboxRuntimeCache: agents.sandboxRuntimeCache,
      })
      .from(agents)
      .where(eq(agents.agentId, input.agentId))
      .limit(1);
    const facts = agent as SelectedSandboxAgentFacts | undefined;
    if (!facts) throw new Error("Selected Sandbox Agent no longer exists");
    const executionMode = selectedExecutionMode(facts.sandboxCapabilities);
    if (executionMode === "RootImpersonation") {
      if (input.schedulerType !== "kubernetes" && !facts.rootMode) {
        throw new Error("Selected Agent does not advertise root Sandbox impersonation capability");
      }
      return { executionMode };
    }
    if (input.restrictedNoEgress) {
      throw new Error("Restricted no-egress Sandbox dispatch cannot use SelfAccount execution");
    }
    if (!input.policy.selfAccountEnabled) {
      throw new Error("Self-account Sandbox execution is disabled by effective policy");
    }
    if (input.schedulerType !== "slurm") {
      throw new Error("Self-account Sandbox execution is currently limited to Slurm");
    }
    if (input.identity.backend !== "Unix" || input.identity.mode !== "MappedAccount") {
      throw new Error("Self-account Sandbox execution requires a mapped Unix identity");
    }
    const selfAccount = SandboxSelfAccountSchema.safeParse(
      objectValue(facts.sandboxCapabilities)?.selfAccount,
    );
    if (!selfAccount.success) {
      throw new Error("Selected Agent does not advertise a valid self-account identity");
    }
    if (
      input.identity.username !== selfAccount.data.username ||
      input.identity.uid !== selfAccount.data.uid ||
      input.identity.gid !== selfAccount.data.gid
    ) {
      throw new Error(
        "Sandbox mapped identity does not exactly match the selected Agent self account",
      );
    }
    const runtimeAttestationId = Array.isArray(facts.sandboxRuntimeCache)
      ? facts.sandboxRuntimeCache
          .map((entry) => hasFreshRuntimeAttestation(entry, input.runtime, Date.now()))
          .find((value): value is string => value !== undefined)
      : undefined;
    if (!runtimeAttestationId) {
      throw new Error("Selected Agent lacks a fresh runtime attestation for SelfAccount execution");
    }
    return { executionMode, runtimeAttestationId };
  }

  private signSelfAccountManifest(input: SelfAccountManifestInput) {
    return this.options.signer.sign({
      jobId: input.jobId,
      script: {
        language: input.source.language,
        entrypoint: input.source.entrypoint,
        contentBase64: Buffer.from(input.scriptContent).toString("base64"),
        sha256: input.source.sha256,
        bundleSha256: input.bundleSha256,
      },
      runtime: {
        profileId: input.runtime.id,
        kind: input.runtimeDigest.kind,
        digest: input.runtimeDigest.digest,
      },
      executionMode: "SelfAccount",
      runtimeAttestationId: input.runtimeAttestationId,
      identity: input.identity,
      mounts: [
        ...input.preparedInputs.mounts,
        ...input.outputMounts.map((mount) => ({
          ...mount,
          sizeLimitBytes: Math.min(mount.sizeLimitBytes, input.policy.limits.maxOutputBytes),
        })),
      ],
      limits: {
        pids: Math.min(this.options.limits.pids, input.policy.limits.maxPids),
        outputBytes: Math.min(this.options.limits.outputBytes, input.policy.limits.maxOutputBytes),
        logBytes: Math.min(this.options.limits.logBytes, input.policy.limits.maxLogBytes),
      },
      networkDisabled: true,
    });
  }

  private async recordStats(input: {
    assetRevisionId: string | null;
    inlineScriptHash: string | null;
    runtimeProfileId: string;
    inputBytes: number;
    predictedOutputBytes: number;
    actualOutputBytes: number;
    succeeded: boolean;
  }): Promise<void> {
    try {
      await this.options.recordExecutionStats?.(input);
    } catch (error) {
      logger.warn({ error, workflowRunId: this.options.workflowRunId }, "Stats update failed");
    }
  }

  private async prepareInputs(
    node: Extract<workflowDsl.WorkflowNode, { type: "Script" }>,
    ctx: Record<string, workflowDsl.CelValue>,
  ): Promise<PreparedInputs> {
    const mounts: SandboxDispatchMount[] = [];
    const inputStaging: PreparedInputs["inputStaging"] = [];
    const dataInputs: JobDataInputs = {};
    const bytesByDescriptor: Record<string, number> = {};
    for (const [descriptor, input] of Object.entries(node.inputs)) {
      const slot = node.inputSlots?.find((candidate) => candidate.descriptor === descriptor);
      const value = resolveSlotValue(slot, ctx);
      if (value === undefined) {
        if (input.required)
          throw new Error(`Required Sandbox input '${descriptor}' is unavailable`);
        continue;
      }
      if (input.type === "File" || input.type === "FileBatch") {
        const dataInput = DataInputRefSchema.safeParse(value);
        if (dataInput.success && dataInput.data.source === "data-market") {
          if (input.type !== "FileBatch") {
            throw new Error(`Sandbox Data Market input '${descriptor}' must use FileBatch`);
          }
          dataInputs[descriptor] = dataInput.data;
          bytesByDescriptor[descriptor] = 0;
          continue;
        }
        const fileIds = fileMetadataIds(value);
        if (
          (input.type === "File" && fileIds.length !== 1) ||
          (input.type === "FileBatch" && !Array.isArray(value))
        ) {
          throw new Error(`Sandbox ${input.type} input '${descriptor}' is invalid`);
        }
        const files =
          fileIds.length > 0
            ? await this.options.db
                .select()
                .from(netdriveFiles)
                .where(
                  and(
                    inArray(netdriveFiles.id, fileIds),
                    eq(netdriveFiles.ownerId, this.options.submittedBy),
                    isNull(netdriveFiles.deletedAt),
                  ),
                )
            : [];
        if (files.length !== fileIds.length) {
          throw new Error(`Sandbox ${input.type} input '${descriptor}' does not exist`);
        }
        const fileById = new Map(files.map((file) => [file.id, file]));
        const orderedFiles = fileIds.map((id) => fileById.get(id));
        if (orderedFiles.some((file) => !file)) {
          throw new Error(`Sandbox ${input.type} input '${descriptor}' is incomplete`);
        }
        const batchEntries =
          input.type === "FileBatch"
            ? orderedFiles.map((file, index) => {
                if (!file) throw new Error("Sandbox FileBatch entry disappeared");
                const name =
                  file.path
                    .split("/")
                    .at(-1)
                    ?.replace(/[^A-Za-z0-9._-]/g, "_") || "file";
                return {
                  relativePath: `${String(index).padStart(4, "0")}-${name}`,
                  sha256: file.sha256,
                  sizeBytes: file.size,
                };
              })
            : [];
        const totalBytes = orderedFiles.reduce((total, file) => total + (file?.size ?? 0), 0);
        bytesByDescriptor[descriptor] = totalBytes;
        const single = orderedFiles[0];
        const expectedSha256 =
          input.type === "FileBatch" ? batchSha256(batchEntries) : single?.sha256;
        if (!expectedSha256) throw new Error(`Sandbox File input '${descriptor}' lacks a hash`);
        mounts.push({
          descriptor,
          ioType: input.type,
          mode: "ReadOnly",
          relativePath: `inputs/${descriptor}`,
          containerPath: `/kq/inputs/${descriptor}`,
          expectedSha256,
          inlineContentBase64: null,
          batchEntries,
          sizeLimitBytes: Math.max(1, totalBytes),
          required: input.required,
        });
        orderedFiles.forEach((file, index) => {
          if (!file) return;
          inputStaging.push({
            fileMetadataId: file.id,
            stagePath:
              input.type === "FileBatch"
                ? `inputs/${descriptor}/${batchEntries[index]?.relativePath ?? index}`
                : `inputs/${descriptor}`,
          });
        });
        continue;
      }
      const text =
        input.type === "JSON"
          ? JSON.stringify(value)
          : typeof value === "string"
            ? value
            : String(value);
      const content = Buffer.from(text, "utf8");
      bytesByDescriptor[descriptor] = content.byteLength;
      if (content.byteLength > 4 * 1024 * 1024) {
        throw new Error(`Inline Sandbox input '${descriptor}' exceeds 4 MiB`);
      }
      mounts.push({
        descriptor,
        ioType: input.type,
        mode: "ReadOnly",
        relativePath: `inputs/${descriptor}`,
        containerPath: `/kq/inputs/${descriptor}`,
        expectedSha256: sha256(content),
        inlineContentBase64: content.toString("base64"),
        batchEntries: [],
        sizeLimitBytes: Math.max(1, content.byteLength),
        required: input.required,
      });
    }
    return { mounts, inputStaging, dataInputs, bytesByDescriptor };
  }
}
