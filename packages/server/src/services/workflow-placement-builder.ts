import {
  agents,
  artifactReplicas,
  type PgDb,
  sandboxRuntimeContractBindings,
  sandboxRuntimeProfiles,
  softwareAssetRevisions,
  workflowArtifacts,
  workflowRuns,
} from "@kuintessence/db";
import {
  type ExecutionIdentity,
  type PlacementConstraint,
  type SandboxRuntimeContractRef,
  type Workflow,
  type WorkflowPlacementConfig,
  WorkflowPlacementConfigSchema,
} from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import type { SandboxPlannerCandidate, SandboxPlannerNode } from "../scheduler/sandbox-planner";
import { parseWorkflowYaml } from "../workflow/parser";
import { sandboxRuntimeContractKey } from "./license-runtime-governance";
import type { PlacementPlanBuilder, PlacementPlanBuildInput } from "./placement-plan";
import { SandboxExecutionStatsService } from "./sandbox-execution-stats";
import { hashSandboxScript } from "./sandbox-script";

const SIZE_CLASS_BYTES = {
  Tiny: 1_024,
  Small: 1_048_576,
  Medium: 104_857_600,
  Large: 1_073_741_824,
  Huge: 10_737_418_240,
  Unknown: 1_048_576,
} as const;

function adapterName(schedulerType: string): "slurm" | "pbs-pro" | "torque" | "kubernetes" | null {
  const normalized = schedulerType.toLowerCase();
  if (normalized.includes("slurm")) return "slurm";
  if (normalized.includes("pbs")) return "pbs-pro";
  if (normalized.includes("torque")) return "torque";
  if (normalized.includes("k8s") || normalized.includes("kubernetes")) return "kubernetes";
  return null;
}

function cachedDigest(cache: Array<Record<string, unknown>>, digest: string): boolean {
  return cache.some((entry) => entry.digest === digest && entry.signatureVerified === true);
}

function hasPersistedRuntimeAttestation(
  binding: typeof sandboxRuntimeContractBindings.$inferSelect,
): boolean {
  return (
    (binding.attestationKeyId?.trim().length ?? 0) > 0 &&
    (binding.attestationSignature?.trim().length ?? 0) > 0 &&
    binding.attestedAt !== null
  );
}

function selectRuntimeBinding(
  rows: Array<{
    binding: typeof sandboxRuntimeContractBindings.$inferSelect;
    profile: typeof sandboxRuntimeProfiles.$inferSelect;
  }>,
  ref: SandboxRuntimeContractRef,
  agent: typeof agents.$inferSelect,
) {
  const matching = rows.filter(
    ({ binding }) =>
      binding.providerOrgId === agent.providerOrgId &&
      binding.runtimeContractRef === sandboxRuntimeContractKey(ref) &&
      hasPersistedRuntimeAttestation(binding) &&
      (binding.agentId === null || binding.agentId === agent.agentId) &&
      (binding.clusterId === null || binding.clusterId === agent.clusterId),
  );
  const rank = (binding: (typeof matching)[number]["binding"]) =>
    Number(binding.agentId !== null) + Number(binding.clusterId !== null);
  const highestRank = Math.max(...matching.map(({ binding }) => rank(binding)));
  const candidates = matching.filter(({ binding }) => rank(binding) === highestRank);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function outputBytes(node: Workflow["spec"]["nodeDrafts"][number]): number {
  if (node.type !== "Script") return 0;
  return Object.values(node.outputs).reduce((total, output) => {
    const hint = output.sizeHint;
    if (hint.type === "FixedBytes") return total + hint.bytes;
    if (hint.type === "SizeClass") return total + SIZE_CLASS_BYTES[hint.value];
    return total + SIZE_CLASS_BYTES.Unknown;
  }, 0);
}

function targetSite(node: Workflow["spec"]["nodeDrafts"][number]): string | undefined {
  if (node.type !== "Script") return undefined;
  for (const output of Object.values(node.outputs)) {
    if (output.locality.type === "TargetSite") return output.locality.siteId;
  }
  return undefined;
}

function executionIdentity(
  node: Workflow["spec"]["nodeDrafts"][number],
  config: WorkflowPlacementConfig,
): ExecutionIdentity {
  if (node.type !== "Script" || node.executionIdentity.type === "Inherit") {
    return config.defaultExecutionIdentity;
  }
  return node.executionIdentity;
}

function constraint(
  node: Workflow["spec"]["nodeDrafts"][number],
  config: WorkflowPlacementConfig,
): PlacementConstraint | null {
  if (node.type === "Script" && node.placementConstraint) return node.placementConstraint;
  return config.nodeConstraints[node.id] ?? config.runConstraint;
}

function assertInlineIdentity(
  node: Workflow["spec"]["nodeDrafts"][number],
  identity: ExecutionIdentity,
): void {
  if (
    node.type === "Script" &&
    node.source?.type === "Inline" &&
    identity.type !== "MappedAuto" &&
    identity.type !== "MappedAccount"
  ) {
    throw new Error(`Inline Script node '${node.id}' requires a mapped execution account`);
  }
}

function isResolvedScriptNode(node: Workflow["spec"]["nodeDrafts"][number]): node is Extract<
  Workflow["spec"]["nodeDrafts"][number],
  { type: "Script" }
> & {
  source: NonNullable<
    Extract<Workflow["spec"]["nodeDrafts"][number], { type: "Script" }>["source"]
  >;
} {
  return node.type === "Script" && node.source !== undefined;
}

function baseCandidate(row: typeof agents.$inferSelect): SandboxPlannerCandidate | null {
  if (row.status !== "online" || !row.siteId || !row.clusterId) return null;
  return {
    agentId: row.agentId,
    siteId: row.siteId,
    clusterId: row.clusterId,
    computeCost: 1,
    queueWaitCost: row.queueDepth + row.historicalP95WaitSec / 60,
    wallTimeCost: 0,
    runtimeCached: true,
    runtimeMissCost: 0,
    failureRiskCost: row.status === "online" ? 0 : 10_000,
    preferenceCost: 0,
    networkCostBySite: {},
  };
}

async function loadContext(
  db: PgDb,
  workflowRunId: string,
  context?: { workflow: Workflow; config: WorkflowPlacementConfig },
): Promise<{ workflow: Workflow; config: WorkflowPlacementConfig }> {
  if (context) return context;
  const [run] = await db
    .select({ input: workflowRuns.input })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, workflowRunId))
    .limit(1);
  if (!run?.input?.yaml) throw new Error("workflow run does not contain a recoverable definition");
  return {
    workflow: parseWorkflowYaml(run.input.yaml),
    config: WorkflowPlacementConfigSchema.parse(run.input.placementConfig ?? {}),
  };
}

export function createWorkflowPlacementBuilder(db: PgDb): PlacementPlanBuilder {
  const executionStats = new SandboxExecutionStatsService(db);
  return async (workflowRunId, _trigger, suppliedContext): Promise<PlacementPlanBuildInput> => {
    const { workflow, config } = await loadContext(db, workflowRunId, suppliedContext);
    const agentRows = await db.select().from(agents);
    const scriptNodes = workflow.spec.nodeDrafts.filter(isResolvedScriptNode);
    const profileIds = [
      ...new Set(
        scriptNodes.flatMap((node) => (node.runtimeProfileId ? [node.runtimeProfileId] : [])),
      ),
    ];
    const profiles =
      profileIds.length > 0
        ? await db
            .select()
            .from(sandboxRuntimeProfiles)
            .where(inArray(sandboxRuntimeProfiles.id, profileIds))
        : [];
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const runtimeBindings = scriptNodes.some((node) => node.runtimeContractRef !== undefined)
      ? await db
          .select({ binding: sandboxRuntimeContractBindings, profile: sandboxRuntimeProfiles })
          .from(sandboxRuntimeContractBindings)
          .innerJoin(
            sandboxRuntimeProfiles,
            eq(sandboxRuntimeContractBindings.runtimeProfileId, sandboxRuntimeProfiles.id),
          )
          .where(eq(sandboxRuntimeContractBindings.status, "active"))
      : [];
    const assetIds = [
      ...new Set(
        scriptNodes.flatMap((node) =>
          node.source.type === "AssetRevision" ? [node.source.assetId] : [],
        ),
      ),
    ];
    const revisionRows =
      assetIds.length > 0
        ? await db
            .select()
            .from(softwareAssetRevisions)
            .where(inArray(softwareAssetRevisions.assetId, assetIds))
        : [];
    const revisionByPin = new Map(
      revisionRows.map((revision) => [`${revision.assetId}:${revision.revision}`, revision.id]),
    );
    const artifacts = await db
      .select()
      .from(workflowArtifacts)
      .where(eq(workflowArtifacts.workflowRunId, workflowRunId));
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const replicas =
      artifactIds.length > 0
        ? await db
            .select()
            .from(artifactReplicas)
            .where(inArray(artifactReplicas.artifactId, artifactIds))
        : [];
    const replicaSites = new Map<string, string[]>();
    for (const replica of replicas) {
      if (replica.status !== "available") continue;
      replicaSites.set(replica.artifactId, [
        ...(replicaSites.get(replica.artifactId) ?? []),
        replica.siteId,
      ]);
    }
    const artifactsByProducer = new Map<string, typeof artifacts>();
    for (const artifact of artifacts) {
      artifactsByProducer.set(artifact.producerNodeId, [
        ...(artifactsByProducer.get(artifact.producerNodeId) ?? []),
        artifact,
      ]);
    }
    const identities: Record<string, ExecutionIdentity> = {};
    const nodes: SandboxPlannerNode[] = await Promise.all(
      workflow.spec.nodeDrafts.map(async (node) => {
        const identity = executionIdentity(node, config);
        assertInlineIdentity(node, identity);
        identities[node.id] = identity;
        if (
          node.type === "Script" &&
          (!node.source ||
            (node.runtimeProfileId === undefined && node.runtimeContractRef === undefined))
        ) {
          throw new Error(`Script node '${node.id}' has unresolved asset or runtime references`);
        }
        const profile =
          node.type === "Script" && node.runtimeProfileId
            ? profileById.get(node.runtimeProfileId)
            : undefined;
        if (
          node.type === "Script" &&
          node.runtimeProfileId &&
          (!profile || profile.lifecycle !== "active")
        ) {
          throw new Error(`Script node '${node.id}' runtime profile is unavailable`);
        }
        const candidates = agentRows.flatMap((agent) => {
          const candidate = baseCandidate(agent);
          if (!candidate) return [];
          if (node.type !== "Script") return [candidate];
          const adapter = adapterName(agent.schedulerType);
          if (!adapter || agent.sandboxReadiness !== "ready") {
            return [];
          }
          const bound = node.runtimeContractRef
            ? selectRuntimeBinding(runtimeBindings, node.runtimeContractRef, agent)
            : undefined;
          const candidateProfile = bound?.profile ?? profile;
          if (
            !candidateProfile?.adapters.includes(adapter) ||
            candidateProfile.lifecycle !== "active"
          ) {
            return [];
          }
          const digest =
            adapter === "kubernetes" ? candidateProfile.ociDigest : candidateProfile.sifDigest;
          if (bound && digest !== bound.binding.runtimeDigest) return [];
          if (!digest || !cachedDigest(agent.sandboxRuntimeCache, digest)) return [];
          return [{ ...candidate, runtimeCached: true }];
        });
        const incoming = workflow.spec.nodeRelations.filter(
          (relation) => relation.toId === node.id,
        );
        const inputs = incoming.flatMap((relation) =>
          (artifactsByProducer.get(relation.fromId) ?? []).map((artifact) => ({
            bytes: artifact.sizeBytes,
            replicaSiteIds: replicaSites.get(artifact.id) ?? [],
          })),
        );
        const estimatedOutputBytes = outputBytes(node);
        const inputBytes = inputs.reduce((total, input) => total + input.bytes, 0);
        const scriptSource = node.type === "Script" ? node.source : undefined;
        const correctedOutputBytes =
          node.type === "Script" && node.runtimeProfileId && scriptSource
            ? await executionStats.estimate({
                assetRevisionId:
                  scriptSource.type === "AssetRevision"
                    ? (revisionByPin.get(`${scriptSource.assetId}:${scriptSource.revision}`) ??
                      null)
                    : null,
                inlineScriptHash:
                  scriptSource.type === "Inline" ? hashSandboxScript(scriptSource.content) : null,
                runtimeProfileId: node.runtimeProfileId,
                inputBytes,
                manifestBytes: estimatedOutputBytes,
              })
            : estimatedOutputBytes;
        const site = targetSite(node);
        return {
          id: node.id,
          candidates,
          constraint: constraint(node, config),
          ...(inputs.length > 0 ? { inputs } : {}),
          ...(correctedOutputBytes > 0
            ? {
                outputs: [{ bytes: correctedOutputBytes, ...(site ? { targetSiteId: site } : {}) }],
              }
            : {}),
        };
      }),
    );
    const estimatedByNode = new Map(
      nodes.map((node) => [
        node.id,
        node.outputs?.reduce((total, output) => total + output.bytes, 0) ?? 0,
      ]),
    );
    return {
      config,
      request: {
        nodes,
        edges: workflow.spec.nodeRelations.map((relation) => ({
          from: relation.fromId,
          to: relation.toId,
          bytes: estimatedByNode.get(relation.fromId) ?? 0,
        })),
        beamWidth: 64,
        defaultNetworkCostPerByte: 1e-9,
      },
      executionIdentities: identities,
    };
  };
}
