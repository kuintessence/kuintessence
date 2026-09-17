import type { workflowDsl } from "@kuintessence/shared/browser";
import { yamlToGraph } from "./yaml-graph-sync";

export interface WorkflowEstimateQueue {
  costRate?: number | null;
  queueId: string;
}

export interface WorkflowEstimate {
  durationSec: number;
  fallbackNodeCount: number;
  maxCost: number | null;
  minCost: number | null;
  unpricedNodeCount: number;
}

const DEFAULT_NODE_DURATION_SEC = 3_600;

export function estimateWorkflow(yaml: string, queues: WorkflowEstimateQueue[]): WorkflowEstimate {
  const parsed = yamlToGraph(yaml);
  if (!parsed.ok) {
    return {
      durationSec: 0,
      fallbackNodeCount: 0,
      maxCost: null,
      minCost: null,
      unpricedNodeCount: 0,
    };
  }
  const schedulable = parsed.graph.nodes.filter((node) => isSchedulable(node.data.raw));
  const durations = new Map<string, number>();
  let fallbackNodeCount = 0;
  let minCost = 0;
  let maxCost = 0;
  let pricedNodeCount = 0;
  let unpricedNodeCount = 0;

  for (const node of parsed.graph.nodes) {
    if (!isSchedulable(node.data.raw)) {
      durations.set(node.id, 0);
      continue;
    }
    const requestedDuration = node.data.raw.requirements?.maxWallTime;
    const durationSec =
      typeof requestedDuration === "number" && requestedDuration > 0
        ? requestedDuration
        : DEFAULT_NODE_DURATION_SEC;
    if (!(typeof requestedDuration === "number" && requestedDuration > 0)) fallbackNodeCount += 1;
    durations.set(node.id, durationSec);
    const cpuCores = Math.max(node.data.raw.requirements?.cpuCores ?? 1, 1);
    const rates = queueRates(node.data.raw.schedulingStrategy, queues);
    if (rates.length === 0) {
      unpricedNodeCount += 1;
      continue;
    }
    const cpuHours = (cpuCores * durationSec) / 3_600;
    minCost += Math.min(...rates) * cpuHours;
    maxCost += Math.max(...rates) * cpuHours;
    pricedNodeCount += 1;
  }

  return {
    durationSec: criticalPathDuration(
      parsed.graph.nodes.map((node) => node.id),
      parsed.graph.edges.map((edge) => ({ source: edge.source, target: edge.target })),
      durations,
    ),
    fallbackNodeCount,
    maxCost: pricedNodeCount === 0 ? null : maxCost,
    minCost: pricedNodeCount === 0 ? null : minCost,
    unpricedNodeCount: Math.max(unpricedNodeCount, schedulable.length - pricedNodeCount),
  };
}

function isSchedulable(
  node: workflowDsl.WorkflowNode,
): node is Extract<workflowDsl.WorkflowNode, { type: "SoftwareUsecaseComputing" | "Script" }> {
  return node.type === "SoftwareUsecaseComputing" || node.type === "Script";
}

function queueRates(
  strategy: workflowDsl.SchedulingStrategy | undefined,
  queues: WorkflowEstimateQueue[],
): number[] {
  const queueIds = !strategy || strategy.type === "Auto" ? null : new Set(strategy.queues);
  return queues
    .filter((queue) => queueIds === null || queueIds.has(queue.queueId))
    .flatMap((queue) =>
      typeof queue.costRate === "number" && Number.isFinite(queue.costRate) ? [queue.costRate] : [],
    );
}

function criticalPathDuration(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>,
  durations: Map<string, number>,
): number {
  const incoming = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.source) || !incoming.has(edge.target)) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const queue = nodeIds.filter((id) => incoming.get(id) === 0);
  const finish = new Map(nodeIds.map((id) => [id, durations.get(id) ?? 0]));
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (!nodeId) continue;
    visited += 1;
    for (const target of outgoing.get(nodeId) ?? []) {
      finish.set(
        target,
        Math.max(finish.get(target) ?? 0, (finish.get(nodeId) ?? 0) + (durations.get(target) ?? 0)),
      );
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  if (visited !== nodeIds.length) {
    return nodeIds.reduce((total, id) => total + (durations.get(id) ?? 0), 0);
  }
  return Math.max(0, ...finish.values());
}
