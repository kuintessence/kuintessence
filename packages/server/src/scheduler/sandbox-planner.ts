import type { PlacementConstraint, PlacementObjective, PlannerMode } from "@kuintessence/shared";

export interface SandboxPlannerCandidate {
  agentId: string;
  siteId: string;
  clusterId: string;
  computeCost: number;
  queueWaitCost: number;
  wallTimeCost: number;
  runtimeCached: boolean;
  runtimeMissCost: number;
  failureRiskCost: number;
  preferenceCost: number;
  networkCostBySite: Readonly<Record<string, number>>;
}

export interface SandboxPlannerInput {
  bytes: number;
  replicaSiteIds: readonly string[];
}

export interface SandboxPlannerOutput {
  bytes: number;
  targetSiteId?: string;
}

export interface SandboxPlannerNode {
  id: string;
  candidates: readonly SandboxPlannerCandidate[];
  inputs?: readonly SandboxPlannerInput[];
  outputs?: readonly SandboxPlannerOutput[];
  constraint?: PlacementConstraint | null;
}

export interface SandboxPlannerEdge {
  from: string;
  to: string;
  bytes: number;
}

export interface SandboxPlannerRequest {
  mode: PlannerMode;
  nodes: readonly SandboxPlannerNode[];
  edges?: readonly SandboxPlannerEdge[];
  beamWidth?: number;
  budgetCap?: number | null;
  defaultNetworkCostPerByte?: number;
  preferPenalty?: number;
}

export interface SandboxPlannerAssignment {
  nodeId: string;
  agentId: string;
  siteId: string;
  clusterId: string;
  fallbackAgentIds: string[];
  objective: PlacementObjective;
}

export interface SandboxPlannerResult {
  mode: PlannerMode;
  assignments: SandboxPlannerAssignment[];
  objective: PlacementObjective;
  budgetStatus: "within-cap" | "awaiting-approval";
}

interface PlannerState {
  byNode: ReadonlyMap<string, SandboxPlannerAssignment>;
  assignments: SandboxPlannerAssignment[];
  objective: PlacementObjective;
}

export class SandboxPlannerError extends Error {
  constructor(
    message: string,
    readonly nodeId: string,
  ) {
    super(message);
    this.name = "SandboxPlannerError";
  }
}

const ZERO_OBJECTIVE: PlacementObjective = {
  computeCost: 0,
  queueWaitCost: 0,
  wallTimeCost: 0,
  inputTransferCost: 0,
  outputTransferCost: 0,
  runtimeCacheCost: 0,
  failureRiskCost: 0,
  preferenceCost: 0,
  total: 0,
};

function addObjective(left: PlacementObjective, right: PlacementObjective): PlacementObjective {
  const objective = {
    computeCost: left.computeCost + right.computeCost,
    queueWaitCost: left.queueWaitCost + right.queueWaitCost,
    wallTimeCost: left.wallTimeCost + right.wallTimeCost,
    inputTransferCost: left.inputTransferCost + right.inputTransferCost,
    outputTransferCost: left.outputTransferCost + right.outputTransferCost,
    runtimeCacheCost: left.runtimeCacheCost + right.runtimeCacheCost,
    failureRiskCost: left.failureRiskCost + right.failureRiskCost,
    preferenceCost: left.preferenceCost + right.preferenceCost,
    total: 0,
  };
  objective.total =
    objective.computeCost +
    objective.queueWaitCost +
    objective.wallTimeCost +
    objective.inputTransferCost +
    objective.outputTransferCost +
    objective.runtimeCacheCost +
    objective.failureRiskCost +
    objective.preferenceCost;
  return objective;
}

function networkCost(
  candidate: SandboxPlannerCandidate,
  siteId: string,
  bytes: number,
  defaultCost: number,
): number {
  if (candidate.siteId === siteId) return 0;
  return bytes * (candidate.networkCostBySite[siteId] ?? defaultCost);
}

function matchesTargets(
  candidate: SandboxPlannerCandidate,
  constraint: PlacementConstraint | null | undefined,
): boolean {
  if (!constraint) return true;
  const siteMatches =
    constraint.siteIds.length === 0 || constraint.siteIds.includes(candidate.siteId);
  const clusterMatches =
    constraint.clusterIds.length === 0 || constraint.clusterIds.includes(candidate.clusterId);
  return siteMatches && clusterMatches;
}

function transferForbidden(
  node: SandboxPlannerNode,
  candidate: SandboxPlannerCandidate,
  assigned: ReadonlyMap<string, SandboxPlannerAssignment>,
  incoming: readonly SandboxPlannerEdge[],
): boolean {
  if (node.constraint?.dataMovement !== "Forbid") return false;
  if (node.inputs?.some((input) => !input.replicaSiteIds.includes(candidate.siteId))) return true;
  if (
    node.outputs?.some((output) => output.targetSiteId && output.targetSiteId !== candidate.siteId)
  ) {
    return true;
  }
  return incoming.some((edge) => assigned.get(edge.from)?.siteId !== candidate.siteId);
}

function candidateObjective(
  node: SandboxPlannerNode,
  candidate: SandboxPlannerCandidate,
  assigned: ReadonlyMap<string, SandboxPlannerAssignment>,
  incoming: readonly SandboxPlannerEdge[],
  defaultNetworkCost: number,
  preferPenalty: number,
): PlacementObjective {
  const inputTransferCost =
    node.inputs?.reduce((sum, input) => {
      const closest = Math.min(
        ...input.replicaSiteIds.map((siteId) =>
          networkCost(candidate, siteId, input.bytes, defaultNetworkCost),
        ),
      );
      return sum + (Number.isFinite(closest) ? closest : input.bytes * defaultNetworkCost);
    }, 0) ?? 0;
  const edgeTransferCost = incoming.reduce((sum, edge) => {
    const producer = assigned.get(edge.from);
    return producer
      ? sum + networkCost(candidate, producer.siteId, edge.bytes, defaultNetworkCost)
      : sum;
  }, 0);
  const outputTransferCost =
    node.outputs?.reduce(
      (sum, output) =>
        sum +
        (output.targetSiteId
          ? networkCost(candidate, output.targetSiteId, output.bytes, defaultNetworkCost)
          : 0),
      0,
    ) ?? 0;
  const manualPreferenceCost =
    node.constraint?.mode === "Prefer" && !matchesTargets(candidate, node.constraint)
      ? preferPenalty
      : 0;
  return addObjective(ZERO_OBJECTIVE, {
    computeCost: candidate.computeCost,
    queueWaitCost: candidate.queueWaitCost,
    wallTimeCost: candidate.wallTimeCost,
    inputTransferCost: inputTransferCost + edgeTransferCost,
    outputTransferCost,
    runtimeCacheCost: candidate.runtimeCached ? 0 : candidate.runtimeMissCost,
    failureRiskCost: candidate.failureRiskCost,
    preferenceCost: candidate.preferenceCost + manualPreferenceCost,
    total: 0,
  });
}

function eligibleCandidates(
  node: SandboxPlannerNode,
  assigned: ReadonlyMap<string, SandboxPlannerAssignment>,
  incoming: readonly SandboxPlannerEdge[],
): SandboxPlannerCandidate[] {
  return node.candidates
    .filter(
      (candidate) =>
        (node.constraint?.mode !== "Require" || matchesTargets(candidate, node.constraint)) &&
        !transferForbidden(node, candidate, assigned, incoming),
    )
    .toSorted((left, right) => left.agentId.localeCompare(right.agentId));
}

function topologicalNodes(
  nodes: readonly SandboxPlannerNode[],
  edges: readonly SandboxPlannerEdge[],
): SandboxPlannerNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const ordered: SandboxPlannerNode[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => left.localeCompare(right));
    const id = ready.shift();
    if (!id) break;
    const node = byId.get(id);
    if (node) ordered.push(node);
    for (const next of outgoing.get(id) ?? []) {
      const value = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, value);
      if (value === 0) ready.push(next);
    }
  }
  if (ordered.length !== nodes.length) {
    throw new SandboxPlannerError("placement graph must be acyclic", "graph");
  }
  return ordered;
}

function outgoingLowerBound(
  candidate: SandboxPlannerCandidate,
  outgoing: readonly SandboxPlannerEdge[],
  byId: ReadonlyMap<string, SandboxPlannerNode>,
  defaultNetworkCost: number,
): number {
  return outgoing.reduce((sum, edge) => {
    const consumer = byId.get(edge.to);
    if (!consumer || consumer.candidates.length === 0) return sum;
    const closest = Math.min(
      ...consumer.candidates.map((next) =>
        networkCost(candidate, next.siteId, edge.bytes, defaultNetworkCost),
      ),
    );
    return sum + closest;
  }, 0);
}

function assignment(
  node: SandboxPlannerNode,
  candidate: SandboxPlannerCandidate,
  objective: PlacementObjective,
): SandboxPlannerAssignment {
  return {
    nodeId: node.id,
    agentId: candidate.agentId,
    siteId: candidate.siteId,
    clusterId: candidate.clusterId,
    fallbackAgentIds: [],
    objective,
  };
}

function planSequential(
  request: SandboxPlannerRequest,
  ordered: readonly SandboxPlannerNode[],
  edges: readonly SandboxPlannerEdge[],
): PlannerState {
  const byId = new Map(request.nodes.map((node) => [node.id, node]));
  const byNode = new Map<string, SandboxPlannerAssignment>();
  const assignments: SandboxPlannerAssignment[] = [];
  let objective = ZERO_OBJECTIVE;
  const defaultNetworkCost = request.defaultNetworkCostPerByte ?? 1;
  const preferPenalty = request.preferPenalty ?? 1_000;
  for (const node of ordered) {
    const incoming = edges.filter((edge) => edge.to === node.id);
    const candidates = eligibleCandidates(node, byNode, incoming);
    if (candidates.length === 0) {
      throw new SandboxPlannerError("no candidate satisfies placement constraints", node.id);
    }
    const outgoing = edges.filter((edge) => edge.from === node.id);
    const ranked = candidates
      .map((candidate) => {
        const actual = candidateObjective(
          node,
          candidate,
          byNode,
          incoming,
          defaultNetworkCost,
          preferPenalty,
        );
        const lookahead =
          request.mode === "Lookahead"
            ? outgoingLowerBound(candidate, outgoing, byId, defaultNetworkCost)
            : 0;
        return { candidate, actual, rank: actual.total + lookahead };
      })
      .toSorted(
        (left, right) =>
          left.rank - right.rank || left.candidate.agentId.localeCompare(right.candidate.agentId),
      );
    const selected = ranked[0];
    if (!selected) throw new SandboxPlannerError("no candidate available", node.id);
    const next = assignment(node, selected.candidate, selected.actual);
    byNode.set(node.id, next);
    assignments.push(next);
    objective = addObjective(objective, selected.actual);
  }
  return { byNode, assignments, objective };
}

function planGlobal(
  request: SandboxPlannerRequest,
  ordered: readonly SandboxPlannerNode[],
  edges: readonly SandboxPlannerEdge[],
): PlannerState {
  const defaultNetworkCost = request.defaultNetworkCostPerByte ?? 1;
  const preferPenalty = request.preferPenalty ?? 1_000;
  const beamWidth = Math.max(1, request.beamWidth ?? 64);
  let beam: PlannerState[] = [{ byNode: new Map(), assignments: [], objective: ZERO_OBJECTIVE }];
  for (const node of ordered) {
    const incoming = edges.filter((edge) => edge.to === node.id);
    const expanded: PlannerState[] = [];
    for (const state of beam) {
      const candidates = eligibleCandidates(node, state.byNode, incoming);
      for (const candidate of candidates) {
        const nodeObjective = candidateObjective(
          node,
          candidate,
          state.byNode,
          incoming,
          defaultNetworkCost,
          preferPenalty,
        );
        const next = assignment(node, candidate, nodeObjective);
        expanded.push({
          byNode: new Map([...state.byNode, [node.id, next]]),
          assignments: [...state.assignments, next],
          objective: addObjective(state.objective, nodeObjective),
        });
      }
    }
    if (expanded.length === 0) {
      throw new SandboxPlannerError("no candidate satisfies placement constraints", node.id);
    }
    beam = expanded
      .toSorted(
        (left, right) =>
          left.objective.total - right.objective.total ||
          left.assignments
            .map((item) => item.agentId)
            .join("|")
            .localeCompare(right.assignments.map((item) => item.agentId).join("|")),
      )
      .slice(0, beamWidth);
  }
  const selected = beam[0];
  if (!selected) throw new SandboxPlannerError("planner produced no plan", "graph");
  return selected;
}

export function planSandboxPlacement(request: SandboxPlannerRequest): SandboxPlannerResult {
  const edges = request.edges ?? [];
  const ordered = topologicalNodes(request.nodes, edges);
  const state =
    request.mode === "Global"
      ? planGlobal(request, ordered, edges)
      : planSequential(request, ordered, edges);
  const assignments = state.assignments.map((selected) => {
    const node = request.nodes.find((item) => item.id === selected.nodeId);
    if (!node) return selected;
    const incoming = edges.filter((edge) => edge.to === node.id);
    const ranked = eligibleCandidates(node, state.byNode, incoming)
      .filter((candidate) => candidate.agentId !== selected.agentId)
      .map((candidate) => ({
        agentId: candidate.agentId,
        total: candidateObjective(
          node,
          candidate,
          state.byNode,
          incoming,
          request.defaultNetworkCostPerByte ?? 1,
          request.preferPenalty ?? 1_000,
        ).total,
      }))
      .toSorted(
        (left, right) => left.total - right.total || left.agentId.localeCompare(right.agentId),
      );
    return { ...selected, fallbackAgentIds: ranked.map((item) => item.agentId) };
  });
  return {
    mode: request.mode,
    assignments,
    objective: state.objective,
    budgetStatus:
      request.budgetCap != null && state.objective.total > request.budgetCap
        ? "awaiting-approval"
        : "within-cap",
  };
}
