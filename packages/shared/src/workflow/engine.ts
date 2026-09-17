import { coerceTyped, extractTyped } from "../usecase/value-extract";
import { createLogger } from "../utils/logger";
import * as workflowDsl from "../workflow-dsl";
import type { WorkflowNodeFailure } from "./run-store";

const logger = createLogger("workflow-engine");

/**
 * Reserved per-iteration value keys (`$`-prefixed so they can never collide
 * with a user slug, which must start with a letter/underscore). They carry
 * loop-iteration data the `Reduce` reducers consume and are stripped from the
 * persisted run result so raw logs / row bundles never bloat stored state.
 */
export const LOOP_ROWS_KEY = "$rows";
export const NODE_COLLECTED_KEY = "$collected";
export const REQUIRED_COLLECTED_OUTPUTS_KEY = "$requiredCollectedOutputs";

/** One captured iteration of a ForEach loop, consumed by `ExtractTable`. */
interface LoopRow {
  item: CelValue;
  index: number;
  nodeValues: Record<string, Record<string, CelValue>>;
  collected: Record<string, string>;
}

/**
 * Workflow engine core. Orchestration over a node graph:
 *   - topological execution; `when` guards via CEL over an accumulating
 *     `{ params, nodes, loop? }` context; value accumulation; skip/cancel
 *     propagation.
 *   - `Switch` multi-way routing (engine-handled).
 *   - `Generate` (deterministic rule → list value), `Loop` `ForEach`/`While`
 *     runtime fan-out (the nested body runs per item with `loop.item` /
 *     `loop.index` in scope; outputs are aggregated into arrays), `Reduce`
 *     (gathers a loop's aggregated outputs), and `SubWorkflow`.
 *
 * Per-leaf execution (SUC/NoAction/Script/Milestone) is an injected
 * `NodeExecutor`. This is the sole workflow engine.
 */

type CelValue = workflowDsl.CelValue;

export type NodeStatus = "Succeeded" | "Failed" | "Skipped" | "Cancelled";

export interface NodeExecutionResult {
  status: "Succeeded" | "Failed";
  values?: Record<string, CelValue>;
  failure?: WorkflowNodeFailure;
}

export type NodeExecutor = (
  node: workflowDsl.WorkflowNode,
  ctx: Record<string, CelValue>,
) => Promise<NodeExecutionResult>;

export interface RunWorkflowOptions {
  resolveWorkflowVersion?: (workflowVersionId: string) => Promise<workflowDsl.Workflow | null>;
}

interface NodeCtxEntry {
  status: NodeStatus;
  values: Record<string, CelValue>;
  failure?: WorkflowNodeFailure;
}

export interface RunResult {
  status: Record<string, NodeStatus>;
  values: Record<string, NodeCtxEntry>;
}

type Edge = {
  fromId: string;
  toId: string;
  when?: workflowDsl.Expr;
  slotRelations?: workflowDsl.SlotRelation[];
};
type Spec = workflowDsl.WorkflowSpec;
type ScopeResult = { status: Record<string, NodeStatus>; nodes: Record<string, NodeCtxEntry> };

function switchTargets(node: workflowDsl.WorkflowNode): string[] {
  if (node.type !== "Switch") {
    return [];
  }
  const targets = node.cases.map((c) => c.to);
  return node.default === undefined ? targets : [...targets, node.default];
}

export async function runWorkflow(
  wf: workflowDsl.Workflow,
  executor: NodeExecutor,
  options: RunWorkflowOptions = {},
): Promise<RunResult> {
  const params = buildParamDefaults(wf.parameters);
  const res = await runScope(wf.spec, executor, { params, nodes: {} }, options);
  return { status: res.status, values: stripReserved(res.nodes) };
}

function buildParamDefaults(parameters: workflowDsl.Parameter[]): Record<string, CelValue> {
  const params: Record<string, CelValue> = {};
  for (const p of parameters) {
    params[p.name] =
      p.default === undefined || p.default === null ? null : coerceTyped(p.default, p.type);
  }
  return params;
}

/** Drop `$`-prefixed reserved keys (loop rows, collected bundles) from the
 *  final per-node values so they never reach persistence. Reduce consumes them
 *  live during the scope run, before this boundary. */
function stripReserved(nodes: Record<string, NodeCtxEntry>): Record<string, NodeCtxEntry> {
  const out: Record<string, NodeCtxEntry> = {};
  for (const [id, entry] of Object.entries(nodes)) {
    const values: Record<string, CelValue> = {};
    for (const [key, value] of Object.entries(entry.values)) {
      if (!key.startsWith("$")) {
        values[key] = value;
      }
    }
    out[id] = {
      status: entry.status,
      values,
      ...(entry.failure ? { failure: entry.failure } : {}),
    };
  }
  return out;
}

async function runScope(
  spec: Spec,
  executor: NodeExecutor,
  parentCtx: Record<string, CelValue>,
  options: RunWorkflowOptions,
): Promise<ScopeResult> {
  const nodes = spec.nodeDrafts;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = nodes.map((n) => n.id);

  const targetToSwitch = new Map<string, string>();
  const switchEdges: Edge[] = [];
  for (const node of nodes) {
    for (const t of switchTargets(node)) {
      switchEdges.push({ fromId: node.id, toId: t });
      targetToSwitch.set(t, node.id);
    }
  }
  const explicitEdges: Edge[] = spec.nodeRelations.map((r) => ({
    fromId: r.fromId,
    toId: r.toId,
    when: r.when,
    slotRelations: r.slotRelations,
  }));
  const edges: Edge[] = [...explicitEdges, ...switchEdges];
  const order = topoSort(ids, edges);
  const orderedIds = new Set(order);
  const unresolved = new Set(ids.filter((i) => !orderedIds.has(i)));
  const executionOrder = unresolved.size === 0 ? order : [...order, ...unresolved];
  const preds = new Map<string, string[]>(ids.map((i) => [i, []]));
  const incoming = new Map<string, Edge[]>(ids.map((i) => [i, []]));
  for (const e of edges) {
    preds.get(e.toId)?.push(e.fromId);
    incoming.get(e.toId)?.push(e);
  }

  const status = new Map<string, NodeStatus>();
  const chosen = new Map<string, string | undefined>();
  const nodeCtx: Record<string, NodeCtxEntry> = {};
  const ctx: Record<string, CelValue> = {
    ...parentCtx,
    nodes: nodeCtx,
    [REQUIRED_COLLECTED_OUTPUTS_KEY]: requiredCollectedOutputs(parentCtx),
  };

  const record = (
    id: string,
    s: NodeStatus,
    values: Record<string, CelValue>,
    failure?: WorkflowNodeFailure,
  ): void => {
    status.set(id, s);
    nodeCtx[id] = { status: s, values, ...(failure ? { failure } : {}) };
  };

  for (const id of executionOrder) {
    const node = byId.get(id);
    if (!node) {
      continue;
    }
    if (unresolved.has(id)) {
      record(id, "Failed", {}, { message: "Workflow graph contains unresolved dependencies." });
      continue;
    }
    const predStatuses = (preds.get(id) ?? []).map((p) => status.get(p));
    if (predStatuses.some((s) => s === "Failed" || s === "Cancelled")) {
      record(id, "Cancelled", {});
      continue;
    }
    if (predStatuses.some((s) => s === "Skipped")) {
      record(id, "Skipped", {});
      continue;
    }
    const controllingSwitch = targetToSwitch.get(id);
    if (controllingSwitch !== undefined && chosen.get(controllingSwitch) !== id) {
      record(id, "Skipped", {});
      continue;
    }
    const relationReadiness = evaluateRelationReadiness(id, incoming.get(id) ?? [], ctx);
    if (relationReadiness === "Failed") {
      record(id, "Failed", {}, { message: "A node dependency condition could not be evaluated." });
      continue;
    }
    if (relationReadiness === "Skipped") {
      record(id, "Skipped", {});
      continue;
    }
    if (node.when) {
      const guard = evalExpr(node.when.expr, ctx, id, "Node when guard failed");
      if (guard === "Error") {
        record(id, "Failed", {}, { message: "The node run condition could not be evaluated." });
        continue;
      }
      if (guard !== true) {
        record(id, "Skipped", {});
        continue;
      }
    }
    const inputReadiness = evaluateInputReadiness(node, nodeCtx, ctx);
    if (inputReadiness === "Failed") {
      record(id, "Failed", {}, { message: "A required node input is unavailable." });
      continue;
    }
    if (inputReadiness === "Skipped") {
      record(id, "Skipped", {});
      continue;
    }
    if (node.type === "Switch") {
      const selected = evaluateSwitch(node, ctx);
      if (selected === "Error") {
        record(
          id,
          "Failed",
          {},
          { message: "The workflow branch condition could not be evaluated." },
        );
        continue;
      }
      chosen.set(id, selected);
      record(id, "Succeeded", {});
      continue;
    }
    if (node.type === "Generate") {
      try {
        record(id, "Succeeded", {
          [node.output.descriptor]: workflowDsl.expandGenerate(node.rule),
        });
      } catch (error) {
        record(
          id,
          "Failed",
          {},
          {
            message: error instanceof Error ? error.message : "Value generation failed.",
          },
        );
      }
      continue;
    }
    if (node.type === "Loop") {
      const [loopStatus, loopValues, loopFailure] = await runLoop(
        node,
        executor,
        {
          ...ctx,
          [REQUIRED_COLLECTED_OUTPUTS_KEY]: requiredCollectedOutputsForLoop(spec, node.id),
        },
        options,
      );
      record(
        id,
        loopStatus,
        loopValues,
        loopStatus === "Failed"
          ? (loopFailure ?? { message: "Loop execution failed." })
          : undefined,
      );
      continue;
    }
    if (node.type === "Reduce") {
      const [reduceStatus, reduceValues] = reduceNode(node, nodeCtx);
      record(
        id,
        reduceStatus,
        reduceValues,
        reduceStatus === "Failed" ? { message: "Result reduction failed." } : undefined,
      );
      continue;
    }
    if (node.type === "SubWorkflow") {
      const [subWorkflowStatus, subWorkflowValues, subWorkflowFailure] = await runSubWorkflow(
        node,
        executor,
        ctx,
        options,
      );
      record(
        id,
        subWorkflowStatus,
        subWorkflowValues,
        subWorkflowStatus === "Failed"
          ? (subWorkflowFailure ?? { message: "Sub-workflow execution failed." })
          : undefined,
      );
      continue;
    }
    try {
      const res = await executor(node, ctx);
      record(id, res.status, res.values ?? {}, res.failure);
    } catch (err) {
      // An executor rejection (e.g. resolvePackage / materialize blowing up) is
      // a single-node failure, not a reason to reject the whole run — record it
      // Failed so downstream cancels, consistent with a returned Failed status.
      logger.error({ nodeId: id, err }, "Node executor threw — recording node Failed");
      record(
        id,
        "Failed",
        {},
        {
          message: err instanceof Error ? err.message : "Node execution failed.",
        },
      );
    }
  }

  return { status: Object.fromEntries(status), nodes: nodeCtx };
}

type InputReadiness = "Ready" | "Skipped" | "Failed";

function evaluateRelationReadiness(
  nodeId: string,
  incomingEdges: Edge[],
  ctx: Record<string, CelValue>,
): InputReadiness {
  for (const edge of incomingEdges) {
    if (edge.when) {
      const guard = evalExpr(edge.when.expr, ctx, nodeId, "Node relation guard failed");
      if (guard === "Error") {
        return "Failed";
      }
      if (guard !== true) {
        return "Skipped";
      }
    }
    for (const slotRelation of edge.slotRelations ?? []) {
      if (!slotRelation.when) {
        continue;
      }
      const guard = evalExpr(slotRelation.when.expr, ctx, nodeId, "Slot relation guard failed");
      if (guard === "Error") {
        return "Failed";
      }
      if (guard !== true) {
        return "Skipped";
      }
    }
  }
  return "Ready";
}

function evaluateInputReadiness(
  node: workflowDsl.WorkflowNode,
  nodeCtx: Record<string, NodeCtxEntry>,
  ctx: Record<string, CelValue>,
): InputReadiness {
  if (!("inputSlots" in node)) {
    return "Ready";
  }
  for (const slot of node.inputSlots ?? []) {
    if (slot.sources && slot.sources.length > 0) {
      if (slot.select !== undefined && typeof slot.select !== "string") {
        const selected = resolveSelectIndex(slot.select, slot.sources.length, ctx, node.id);
        if (selected === undefined) {
          return "Failed";
        }
        const source = slot.sources[selected];
        if (source === undefined || !isAvailableOutput(source, nodeCtx)) {
          return "Failed";
        }
        continue;
      }
      const available = slot.sources.filter((source) => isAvailableOutput(source, nodeCtx)).length;
      if (slot.select === "RequireExactlyOne" && available !== 1) {
        return "Failed";
      }
      if (!slot.optional && (slot.select === undefined || slot.select === "FirstAvailable")) {
        if (available === 0) {
          return "Skipped";
        }
      }
      continue;
    }
    if (slot.optional || !slot.from || !("node" in slot.from) || !("output" in slot.from)) {
      continue;
    }
    if (!isAvailableOutput(slot.from, nodeCtx)) {
      return "Skipped";
    }
  }
  return "Ready";
}

function resolveSelectIndex(
  select: workflowDsl.Expr,
  sourceCount: number,
  ctx: Record<string, CelValue>,
  nodeId: string,
): number | undefined {
  const result = evalExpr(select.expr, ctx, nodeId, "Input source selector failed");
  if (result === "Error" || !Number.isInteger(result)) {
    return undefined;
  }
  const index = result as number;
  return index >= 0 && index < sourceCount ? index : undefined;
}

function isAvailableOutput(
  ref: { node: string; output: string },
  nodeCtx: Record<string, NodeCtxEntry>,
): boolean {
  const source = nodeCtx[ref.node];
  return (
    source !== undefined && source.status === "Succeeded" && source.values[ref.output] !== undefined
  );
}

function evalExpr(
  expr: string,
  ctx: Record<string, CelValue>,
  nodeId: string,
  message: string,
): CelValue | "Error" {
  try {
    return workflowDsl.evalCel(expr, ctx);
  } catch (err) {
    logger.error({ nodeId, expr, err }, message);
    return "Error";
  }
}

function evaluateSwitch(
  node: Extract<workflowDsl.WorkflowNode, { type: "Switch" }>,
  ctx: Record<string, CelValue>,
): string | undefined | "Error" {
  for (const c of node.cases) {
    const result = evalExpr(c.when.expr, ctx, node.id, "Switch case guard failed");
    if (result === "Error") {
      return "Error";
    }
    if (result === true) {
      return c.to;
    }
  }
  return node.default;
}

type ControlFlowRet = [NodeStatus, Record<string, CelValue>, WorkflowNodeFailure?];
type LoopOutSpec = { descriptor: string; from: { node: string; output: string } };
type NodeWithInputSlots = workflowDsl.WorkflowNode & { inputSlots?: workflowDsl.NodeInputSlot[] };

async function runLoop(
  node: Extract<workflowDsl.WorkflowNode, { type: "Loop" }>,
  executor: NodeExecutor,
  ctx: Record<string, CelValue>,
  options: RunWorkflowOptions,
): Promise<ControlFlowRet> {
  return node.mode === "ForEach"
    ? runForEach(node, executor, ctx, options)
    : runWhile(node, executor, ctx, options);
}

async function runForEach(
  node: Extract<workflowDsl.WorkflowNode, { type: "Loop" }>,
  executor: NodeExecutor,
  ctx: Record<string, CelValue>,
  options: RunWorkflowOptions,
): Promise<ControlFlowRet> {
  if (!node.over) {
    return ["Failed", {}];
  }
  const list = evalExpr(node.over.expr, ctx, node.id, "ForEach over expression failed");
  if (list === "Error") {
    return ["Failed", {}];
  }
  if (!Array.isArray(list)) {
    return ["Failed", {}];
  }
  const maxIterations = resolveInt(node.maxIterations, ctx, node.id);
  if (maxIterations === undefined) {
    return ["Failed", {}];
  }
  if (list.length > maxIterations) {
    return ["Failed", {}];
  }
  const outputs = (node.outputs ?? []) as LoopOutSpec[];
  const collected: Record<string, unknown[]> = {};
  for (const out of outputs) {
    collected[out.descriptor] = [];
  }
  const children = await runForEachIterations(node, list, executor, ctx, options);
  let failed = false;
  let failure: WorkflowNodeFailure | undefined;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child === undefined) {
      failed = true;
      failure ??= { message: `ForEach iteration ${i} did not produce a result.` };
      continue;
    }
    if (anyFailed(child)) {
      failed = true;
      failure ??= contextualizeScopeFailure(child, `ForEach iteration ${i}`);
    }
  }
  const rows: LoopRow[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child === undefined) {
      continue;
    }
    const item = list[i];
    if (item === undefined) {
      failed = true;
      continue;
    }
    for (const out of outputs) {
      const value = child.nodes[out.from.node]?.values?.[out.from.output];
      if (value === undefined) {
        failed = true;
        failure ??= {
          message: `ForEach iteration ${i}, node '${out.from.node}' did not produce output '${out.from.output}'.`,
        };
        continue;
      }
      collected[out.descriptor]?.push(value);
    }
    rows.push(captureRow(item, i, child.nodes));
  }
  return failed
    ? ["Failed", {}, failure]
    : ["Succeeded", { ...collected, [LOOP_ROWS_KEY]: rows } as Record<string, CelValue>];
}

async function runForEachIterations(
  node: Extract<workflowDsl.WorkflowNode, { type: "Loop" }>,
  list: CelValue[],
  executor: NodeExecutor,
  ctx: Record<string, CelValue>,
  options: RunWorkflowOptions,
): Promise<Array<ScopeResult | undefined>> {
  const children: Array<ScopeResult | undefined> = new Array(list.length);
  if (list.length === 0) {
    return children;
  }
  const concurrency = Math.min(node.maxParallel ?? list.length, list.length);
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) {
        return;
      }
      const item = list[index];
      if (item === undefined) {
        continue;
      }
      const childCtx: Record<string, CelValue> = {
        params: ctx.params,
        nodes: {},
        depth: ctx.depth,
        loop: { item, index, iteration: index },
        [REQUIRED_COLLECTED_OUTPUTS_KEY]: ctx[REQUIRED_COLLECTED_OUTPUTS_KEY] ?? [],
      };
      children[index] = await runScope(node.body, executor, childCtx, options);
    }
  });
  await Promise.all(workers);
  return children;
}

/** Build a `LoopRow` from one iteration's body scope: per-node values (minus
 *  the reserved collected bundle) plus the merged collected-output text. */
function captureRow(
  item: CelValue,
  index: number,
  childNodes: Record<string, NodeCtxEntry>,
): LoopRow {
  const nodeValues: Record<string, Record<string, CelValue>> = {};
  let collected: Record<string, string> = {};
  for (const [nodeId, entry] of Object.entries(childNodes)) {
    const { [NODE_COLLECTED_KEY]: bundle, ...rest } = entry.values;
    nodeValues[nodeId] = rest;
    if (bundle && typeof bundle === "object" && !Array.isArray(bundle)) {
      collected = { ...collected, ...(bundle as Record<string, string>) };
    }
  }
  return { item, index, nodeValues, collected };
}

async function runWhile(
  node: Extract<workflowDsl.WorkflowNode, { type: "Loop" }>,
  executor: NodeExecutor,
  ctx: Record<string, CelValue>,
  options: RunWorkflowOptions,
): Promise<ControlFlowRet> {
  if (!node.until) {
    return ["Failed", {}];
  }
  const maxIter = resolveInt(node.maxIterations, ctx, node.id);
  if (maxIter === undefined) {
    return ["Failed", {}];
  }
  const outputs = (node.outputs ?? []) as LoopOutSpec[];
  const carry = node.carry ?? [];
  const body = withLoopCarryBindings(node.body, carry);
  let previousChild: ScopeResult | undefined;
  let prevOutputs: Record<string, CelValue> | undefined;
  let lastOutputs: Record<string, CelValue> = {};
  for (let i = 0; i < maxIter; i++) {
    const loopState: Record<string, CelValue> = { iteration: i };
    if (prevOutputs) {
      loopState.previous = { values: prevOutputs };
    }
    const carryValues = resolveLoopCarryValues(carry, ctx, previousChild);
    if (carryValues === undefined) {
      return ["Failed", {}];
    }
    if (Object.keys(carryValues).length > 0) {
      loopState.carry = carryValues;
    }
    const childCtx: Record<string, CelValue> = {
      params: ctx.params,
      nodes: {},
      depth: ctx.depth,
      loop: loopState,
      [REQUIRED_COLLECTED_OUTPUTS_KEY]: ctx[REQUIRED_COLLECTED_OUTPUTS_KEY] ?? [],
    };
    const child = await runScope(body, executor, childCtx, options);
    if (anyFailed(child)) {
      return ["Failed", {}, contextualizeScopeFailure(child, `While iteration ${i}`)];
    }
    const currentOutputs = computeOutputs(outputs, child);
    if (currentOutputs === undefined) {
      return ["Failed", {}];
    }
    lastOutputs = currentOutputs;
    const done = evalExpr(
      node.until.expr,
      { ...childCtx, nodes: child.nodes },
      node.id,
      "While until expression failed",
    );
    if (done === "Error") {
      return ["Failed", {}];
    }
    if (done === true) {
      return ["Succeeded", lastOutputs];
    }
    prevOutputs = lastOutputs;
    previousChild = child;
  }
  return node.onExhausted === "SucceedWithLast" ? ["Succeeded", lastOutputs] : ["Failed", {}];
}

function withLoopCarryBindings(spec: Spec, carry: workflowDsl.LoopCarry[]): Spec {
  if (carry.length === 0) {
    return spec;
  }
  const carryInputs = new Set(carry.map((c) => c.to.input));
  return {
    ...spec,
    nodeDrafts: spec.nodeDrafts.map((node) => bindLoopCarryInputs(node, carryInputs)),
  };
}

function bindLoopCarryInputs(
  node: workflowDsl.WorkflowNode,
  carryInputs: Set<string>,
): workflowDsl.WorkflowNode {
  if (!hasInputSlots(node) || !node.inputSlots) {
    return node;
  }
  let changed = false;
  const inputSlots = node.inputSlots.map((slot) => {
    if (!shouldBindLoopCarry(slot, carryInputs)) {
      return slot;
    }
    changed = true;
    return { ...slot, from: { expr: `loop.carry.${slot.descriptor}` } };
  });
  return changed ? ({ ...node, inputSlots } as workflowDsl.WorkflowNode) : node;
}

function hasInputSlots(node: workflowDsl.WorkflowNode): node is NodeWithInputSlots {
  return "inputSlots" in node;
}

function shouldBindLoopCarry(slot: workflowDsl.NodeInputSlot, carryInputs: Set<string>): boolean {
  const hasLiteralContents = Array.isArray(slot.contents)
    ? slot.contents.length > 0
    : slot.contents !== undefined && slot.contents !== null;
  return (
    carryInputs.has(slot.descriptor) &&
    slot.from === undefined &&
    (slot.sources?.length ?? 0) === 0 &&
    !hasLiteralContents
  );
}

function resolveLoopCarryValues(
  carry: workflowDsl.LoopCarry[],
  parentCtx: Record<string, CelValue>,
  previousChild: ScopeResult | undefined,
): Record<string, CelValue> | undefined {
  const values: Record<string, CelValue> = {};
  for (const item of carry) {
    if (previousChild === undefined && item.initial === undefined) {
      continue;
    }
    const value =
      previousChild === undefined
        ? resolveBinding(item.initial, parentCtx)
        : previousChild.nodes[item.from.node]?.values?.[item.from.output];
    if (value === undefined) {
      return undefined;
    }
    values[item.to.input] = value;
  }
  return values;
}

function reduceNode(
  node: Extract<workflowDsl.WorkflowNode, { type: "Reduce" }>,
  nodeCtx: Record<string, NodeCtxEntry>,
): ControlFlowRet {
  const loopValues = nodeCtx[node.from.loop]?.values;
  if (!loopValues) {
    return ["Failed", {}];
  }
  const reducer = node.reducer;
  if (reducer.kind === "Collect" || reducer.kind === "Concat") {
    const arr = loopValues[node.from.output];
    if (!Array.isArray(arr)) {
      return ["Failed", {}];
    }
    const value = reducer.kind === "Collect" ? arr : concatScalars(arr);
    if (value === undefined) {
      return ["Failed", {}];
    }
    return ["Succeeded", { [node.output.descriptor]: value }];
  }
  const rows = loopValues[LOOP_ROWS_KEY];
  if (!Array.isArray(rows)) {
    return ["Failed", {}];
  }
  try {
    if (reducer.kind === "ExtractTable") {
      return ["Succeeded", { [node.output.descriptor]: buildTable(reducer.columns, rows) }];
    }
    if (reducer.kind === "Statistics") {
      return [
        "Succeeded",
        { [node.output.descriptor]: buildStatistics(loopValues[reducer.over], reducer.metrics) },
      ];
    }
  } catch (err) {
    logger.error({ nodeId: node.id, kind: reducer.kind, err }, "Reduce reducer failed");
    return ["Failed", {}];
  }
  // `Command` runs a usecase over the gathered rows — needs a sub-executor seam
  // (deferred); the declarative reducers above cover the scatter-gather gallery.
  return ["Failed", {}];
}

function concatScalars(values: CelValue[]): string | undefined {
  const parts: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return undefined;
    }
    parts.push(String(value));
  }
  return parts.join("");
}

type ReduceColumn = workflowDsl.ReduceColumn;

/** Render `ExtractTable` rows to CSV: header = column names, one row per
 *  iteration, each cell drawn from its column's per-iteration source. */
function buildTable(columns: ReduceColumn[], rows: LoopRow[]): string {
  const header = columns.map((c) => csvCell(c.name)).join(",");
  const lines = rows.map((row) =>
    columns.map((c) => csvCell(formatCell(resolveColumn(c, row)))).join(","),
  );
  return `${[header, ...lines].join("\n")}\n`;
}

function resolveColumn(column: ReduceColumn, row: LoopRow): CelValue {
  const source = column.source;
  if ("collectedOut" in source) {
    const text = row.collected[source.collectedOut];
    if (text === undefined) {
      throw new Error(`ExtractTable: collected output "${source.collectedOut}" is absent`);
    }
    return column.extract
      ? extractTyped(text, column.extract, column.type)
      : coerceTyped(text, column.type);
  }
  let raw: CelValue;
  if ("loopItem" in source) {
    const item = row.item;
    raw =
      item && typeof item === "object" && !Array.isArray(item) && source.loopItem in item
        ? (item as Record<string, CelValue>)[source.loopItem]
        : item;
  } else {
    raw = row.nodeValues[source.node]?.[source.output];
  }
  // A source that produced no value fails the reducer for every column type,
  // rather than leaking the literal "undefined" into a string-typed cell.
  if (raw === undefined) {
    throw new Error(`ExtractTable: column "${column.name}" source produced no value`);
  }
  if (column.extract && typeof raw === "string") {
    return extractTyped(raw, column.extract, column.type);
  }
  return coerceTyped(raw, column.type);
}

function formatCell(value: CelValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Quote a CSV cell only when it contains a delimiter, quote, or newline. */
function csvCell(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type StatMetric = workflowDsl.StatMetric;

/** Compute the requested metrics over a numeric loop-output series, rendered as
 *  a two-column (metric,value) CSV. */
function buildStatistics(series: CelValue, metrics: StatMetric[]): string {
  if (!Array.isArray(series)) {
    throw new Error("Statistics: `over` does not name a list output");
  }
  if (series.length === 0) {
    throw new Error("Statistics: series is empty");
  }
  const nums = series.map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n))) {
    throw new Error("Statistics: series contains a non-finite numeric value");
  }
  const lines = metrics.map((m) => `${m},${formatCell(statistic(nums, m))}`);
  return `metric,value\n${lines.join("\n")}\n`;
}

function statistic(nums: number[], metric: StatMetric): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
  switch (metric) {
    case "mean":
      return mean;
    case "std":
      return Math.sqrt(nums.reduce((s, n) => s + (n - mean) ** 2, 0) / nums.length);
    case "min":
      return sorted[0] ?? Number.NaN;
    case "max":
      return sorted[sorted.length - 1] ?? Number.NaN;
    case "median":
      return percentile(sorted, 0.5);
    case "p90":
      return percentile(sorted, 0.9);
    case "p95":
      return percentile(sorted, 0.95);
    case "p99":
      return percentile(sorted, 0.99);
  }
}

/** Linear-interpolation percentile over an ascending-sorted series. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  if (sorted.length === 1) {
    return sorted[0] ?? Number.NaN;
  }
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loVal = sorted[lo] ?? Number.NaN;
  const hiVal = sorted[hi] ?? Number.NaN;
  return loVal + (hiVal - loVal) * (pos - lo);
}

async function runSubWorkflow(
  node: Extract<workflowDsl.WorkflowNode, { type: "SubWorkflow" }>,
  executor: NodeExecutor,
  ctx: Record<string, CelValue>,
  options: RunWorkflowOptions,
): Promise<ControlFlowRet> {
  const depth = ((ctx.depth as number | undefined) ?? 0) + 1;
  if (depth > node.maxDepth) {
    return node.onDepthExceeded === "SucceedWithLast" ? ["Succeeded", {}] : ["Failed", {}];
  }
  const resolved = await resolveSubWorkflowSpec(node, options);
  if (!resolved) {
    return ["Failed", {}];
  }
  const params: Record<string, CelValue> = { ...resolved.paramDefaults };
  for (const inp of node.inputs ?? []) {
    let value: CelValue;
    try {
      value = resolveBinding(inp.from, ctx);
    } catch (err) {
      logger.error({ nodeId: node.id, err }, "SubWorkflow input binding failed");
      return ["Failed", {}];
    }
    if (value === undefined) {
      return ["Failed", {}];
    }
    params[inp.to.param] = value;
  }
  const child = await runScope(
    resolved.spec,
    executor,
    {
      params,
      nodes: {},
      depth,
      [REQUIRED_COLLECTED_OUTPUTS_KEY]: [],
    },
    options,
  );
  return anyFailed(child)
    ? ["Failed", {}, contextualizeScopeFailure(child, "Sub-workflow")]
    : ["Succeeded", collectSubWorkflowOutputs(node, child)];
}

function requiredCollectedOutputs(ctx: Record<string, CelValue>): string[] {
  const value = ctx[REQUIRED_COLLECTED_OUTPUTS_KEY];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function requiredCollectedOutputsForLoop(spec: Spec, loopId: string): string[] {
  const descriptors = new Set<string>();
  for (const node of spec.nodeDrafts) {
    if (
      node.type === "Reduce" &&
      node.from.loop === loopId &&
      node.reducer.kind === "ExtractTable"
    ) {
      for (const column of node.reducer.columns) {
        if ("collectedOut" in column.source) {
          descriptors.add(column.source.collectedOut);
        }
      }
    }
  }
  return [...descriptors];
}

async function resolveSubWorkflowSpec(
  node: Extract<workflowDsl.WorkflowNode, { type: "SubWorkflow" }>,
  options: RunWorkflowOptions,
): Promise<{ spec: Spec; paramDefaults: Record<string, CelValue> } | null> {
  if (node.ref.kind === "Inline") {
    return { spec: node.ref.body, paramDefaults: {} };
  }
  if (!options.resolveWorkflowVersion) {
    return null;
  }
  try {
    const wf = await options.resolveWorkflowVersion(node.ref.workflowVersionId);
    if (!wf) {
      return null;
    }
    const paramDefaults = buildParamDefaults(wf.parameters);
    return { spec: wf.spec, paramDefaults };
  } catch (err) {
    logger.error(
      { nodeId: node.id, workflowVersionId: node.ref.workflowVersionId, err },
      "SubWorkflow ByVersion resolver failed",
    );
    return null;
  }
}

function collectSubWorkflowOutputs(
  node: Extract<workflowDsl.WorkflowNode, { type: "SubWorkflow" }>,
  child: ScopeResult,
): Record<string, CelValue> {
  const values: Record<string, CelValue> = {};
  for (const out of node.outputs ?? []) {
    const value = resolveWorkflowOutput(out.from.workflowOutput, child.nodes);
    if (value !== undefined) {
      values[out.descriptor] = value;
    }
  }
  return values;
}

function resolveWorkflowOutput(
  workflowOutput: string,
  childNodes: Record<string, NodeCtxEntry>,
): CelValue | undefined {
  const sameNode = childNodes[workflowOutput];
  if (sameNode) {
    if (workflowOutput in sameNode.values) {
      return sameNode.values[workflowOutput];
    }
    const entries = Object.entries(sameNode.values);
    if (entries.length === 1) {
      return entries[0]?.[1];
    }
  }
  const matches: CelValue[] = [];
  for (const entry of Object.values(childNodes)) {
    if (workflowOutput in entry.values) {
      matches.push(entry.values[workflowOutput]);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveBinding(from: unknown, ctx: Record<string, CelValue>): CelValue {
  const b = from as Record<string, unknown>;
  if (typeof b.expr === "string") {
    return workflowDsl.evalCel(b.expr, ctx);
  }
  if (typeof b.param === "string") {
    return (ctx.params as Record<string, CelValue>)[b.param];
  }
  const ref = b as { node?: string; output?: string };
  if (ref.node && ref.output) {
    return (ctx.nodes as Record<string, NodeCtxEntry>)[ref.node]?.values?.[ref.output];
  }
  return undefined;
}

function anyFailed(scope: ScopeResult): boolean {
  return Object.values(scope.status).some((s) => s === "Failed" || s === "Cancelled");
}

function contextualizeScopeFailure(scope: ScopeResult, context: string): WorkflowNodeFailure {
  for (const [nodeId, entry] of Object.entries(scope.nodes)) {
    if (entry.status !== "Failed") continue;
    if (!entry.failure) {
      return { message: `${context}, node '${nodeId}' failed.` };
    }
    return {
      ...entry.failure,
      message: `${context}, node '${nodeId}': ${entry.failure.message}`,
    };
  }
  return { message: `${context} was cancelled before completing.` };
}

function computeOutputs(
  outputs: LoopOutSpec[],
  scope: ScopeResult,
): Record<string, CelValue> | undefined {
  const out: Record<string, CelValue> = {};
  for (const o of outputs) {
    const value = scope.nodes[o.from.node]?.values?.[o.from.output];
    if (value === undefined) {
      return undefined;
    }
    out[o.descriptor] = value;
  }
  return out;
}

function resolveInt(
  v: number | { expr: string },
  ctx: Record<string, CelValue>,
  nodeId: string,
): number | undefined {
  if (typeof v === "number") {
    return v;
  }
  const value = evalExpr(v.expr, ctx, nodeId, "Loop maxIterations expression failed");
  if (value === "Error") {
    return undefined;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function topoSort(ids: string[], edges: ReadonlyArray<Edge>): string[] {
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  const succ = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of edges) {
    const out = succ.get(e.fromId);
    if (out && indeg.has(e.toId)) {
      out.push(e.toId);
      indeg.set(e.toId, (indeg.get(e.toId) ?? 0) + 1);
    }
  }
  const queue = ids.filter((i) => (indeg.get(i) ?? 0) === 0);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const u = queue.shift();
    if (u === undefined) {
      break;
    }
    ordered.push(u);
    for (const v of succ.get(u) ?? []) {
      const d = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, d);
      if (d === 0) {
        queue.push(v);
      }
    }
  }
  return ordered;
}
