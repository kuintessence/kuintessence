/**
 * Pure conversion between control-flow workflow YAML and a React Flow graph
 * (nodes + edges).
 *
 * Round-trip property: for any canonical, schema-valid workflow YAML input,
 *   yamlSemanticEq(graphToYaml(yamlToGraph(y).graph!), y) === true
 * holds for the fields the graph carries — comments and key order are not
 * preserved (we re-emit in canonical order and prepend a `# regenerated`
 * header). The graph is the source of truth for node *positions* and for the
 * `nodeRelations` edge set; every node's full body is carried verbatim in
 * `data.raw` so it survives the round-trip untouched.
 *
 * Structured property edits preserve the node body; nested subgraphs and
 * complex rules are authored in the YAML pane.
 */

import { workflowDsl } from "@kuintessence/shared/browser";
import { parse, stringify } from "yaml";

type WorkflowNode = workflowDsl.WorkflowNode;
type NodeRelation = workflowDsl.NodeRelation;
type SlotRelation = NodeRelation["slotRelations"][number];
type Workflow = workflowDsl.Workflow;
type Expr = workflowDsl.Expr;

/** Node `type` discriminant — drives renderer + palette classification. */
export type GraphNodeKind = WorkflowNode["type"];

export interface GraphNodePosition {
  x: number;
  y: number;
}

/**
 * Per-node data stored on each graph node. The full workflow node is carried in
 * `raw` so re-emission is lossless; the projected fields (`name`, `kind`,
 * `when`) exist only so renderers don't have to re-derive them per frame.
 */
export interface GraphNodeData {
  /** Node id — also used as the React Flow `node.id`. */
  id: string;
  /** Display label (falls back to id when the node has no name). */
  name: string;
  /** Visual classification — the node `type`. */
  kind: GraphNodeKind;
  /** Optional CEL `when` guard, if the node carries one. */
  when?: Expr;
  /** The schema-validated node, carried verbatim. */
  raw: WorkflowNode;
}

export interface GraphNode {
  id: string;
  position: GraphNodePosition;
  data: GraphNodeData;
  type: GraphNodeKind;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** CEL guard on the relation, if any (carried for round-trip). */
  when?: Expr;
  /** Explicit output-to-input mappings configured for this node relation. */
  slotRelations?: SlotRelation[];
}

export interface GraphHeader {
  name: string;
  description?: string;
  parameters: Workflow["parameters"];
}

export interface ParsedGraph {
  header: GraphHeader;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface YamlToGraphSuccess {
  ok: true;
  graph: ParsedGraph;
}

export interface YamlToGraphFailure {
  ok: false;
  message: string;
  errors: Array<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}

export type YamlToGraphResult = YamlToGraphSuccess | YamlToGraphFailure;

// ─── Layout ─────────────────────────────────────────────────────────────────

const NODE_W = 220;
const NODE_H = 90;
const X_GAP = 80;
const Y_GAP = 40;

/**
 * BFS layered layout. Nodes with no incoming relation land in column 0; every
 * other node lands one column past the max column of its upstream nodes. Within
 * a column nodes stack top-to-bottom in declaration order.
 *
 * Cycles cannot exist in valid input (Server validates), but we cap iterations to
 * stay terminating on malformed graphs.
 */
function autoLayout(
  ids: ReadonlyArray<string>,
  upstream: Map<string, string[]>,
): Map<string, GraphNodePosition> {
  const colByNode = new Map<string, number>();
  const remaining = new Set(ids);

  const safeIters = ids.length + 4;
  for (let iter = 0; iter < safeIters && remaining.size > 0; iter += 1) {
    const placed: string[] = [];
    for (const id of ids) {
      if (!remaining.has(id)) continue;
      const deps = upstream.get(id) ?? [];
      const allPlaced = deps.every((d) => colByNode.has(d) || !remaining.has(d));
      if (!allPlaced) continue;
      const col = deps.length === 0 ? 0 : Math.max(...deps.map((d) => colByNode.get(d) ?? 0)) + 1;
      colByNode.set(id, col);
      placed.push(id);
    }
    for (const id of placed) remaining.delete(id);
    if (placed.length === 0) break;
  }
  for (const id of remaining) colByNode.set(id, 0);

  const colCounts = new Map<number, number>();
  const positions = new Map<string, GraphNodePosition>();
  for (const id of ids) {
    const c = colByNode.get(id) ?? 0;
    const r = colCounts.get(c) ?? 0;
    positions.set(id, {
      x: c * (NODE_W + X_GAP),
      y: r * (NODE_H + Y_GAP),
    });
    colCounts.set(c, r + 1);
  }
  return positions;
}

// ─── yamlToGraph ────────────────────────────────────────────────────────────

function nodeName(node: WorkflowNode): string {
  return node.name && node.name.length > 0 ? node.name : node.id;
}

export function yamlToGraph(yaml: string): YamlToGraphResult {
  if (!yaml.trim()) {
    return {
      ok: false,
      message: "YAML is empty",
      errors: [{ path: [], message: "YAML is empty" }],
    };
  }
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : "YAML parse error";
    return { ok: false, message, errors: [{ path: [], message }] };
  }
  const result = workflowDsl.WorkflowSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      message: "Workflow schema validation failed",
      errors: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    };
  }
  const wf: Workflow = result.data;
  const drafts = wf.spec.nodeDrafts;
  const relations = wf.spec.nodeRelations;

  const ids = drafts.map((n) => n.id);
  const upstream = new Map<string, string[]>();
  for (const id of ids) upstream.set(id, []);
  for (const rel of relations) {
    const list = upstream.get(rel.toId);
    if (list) list.push(rel.fromId);
  }
  const positions = autoLayout(ids, upstream);

  const nodes: GraphNode[] = drafts.map((node) => {
    const pos = positions.get(node.id) ?? { x: 0, y: 0 };
    return {
      id: node.id,
      position: pos,
      type: node.type,
      data: {
        id: node.id,
        name: nodeName(node),
        kind: node.type,
        when: node.when,
        raw: node,
      },
    };
  });

  const edges: GraphEdge[] = relations.map((rel) => ({
    id: `${rel.fromId}->${rel.toId}`,
    source: rel.fromId,
    target: rel.toId,
    when: rel.when,
    slotRelations: rel.slotRelations,
  }));

  return {
    ok: true,
    graph: {
      header: {
        name: wf.name,
        description: wf.description ?? undefined,
        parameters: wf.parameters,
      },
      nodes,
      edges,
    },
  };
}

// ─── graphToYaml ────────────────────────────────────────────────────────────

/**
 * Drop undefined / empty fields so the emitted YAML is canonical and the
 * round-trip equality check is meaningful.
 */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const trimmed = compact(v as Record<string, unknown>);
      if (Object.keys(trimmed).length === 0) continue;
      out[k] = trimmed;
      continue;
    }
    out[k] = v;
  }
  return out as T;
}

/**
 * Rebuild the `nodeRelations` edge list from the React Flow edge set (the graph
 * is the source of truth for wiring). Slot relations are not editable on the
 * canvas and retained on each GraphEdge together with the optional `when`
 * guard.
 */
function rebuildRelations(edges: ReadonlyArray<GraphEdge>): NodeRelation[] {
  const sorted = [...edges].sort((a, b) =>
    a.source === b.source ? a.target.localeCompare(b.target) : a.source.localeCompare(b.source),
  );
  return sorted.map((e) => ({
    fromId: e.source,
    toId: e.target,
    ...(e.when ? { when: e.when } : {}),
    slotRelations: e.slotRelations ?? [],
  }));
}

/**
 * Serialize a graph back to a workflow YAML string.
 *
 * Emission rules:
 *   - `nodeDrafts` come from each node's verbatim `data.raw` body.
 *   - `nodeRelations` are rebuilt from the edge set.
 *   - Output starts with `# regenerated by yaml-graph-sync`; source comments
 *     are not preserved during serialization.
 */
export function graphToYaml(
  header: GraphHeader,
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<GraphEdge>,
  opts: { headerComment?: boolean } = {},
): string {
  const nodeDrafts = nodes.map((n) => compact(n.data.raw as unknown as Record<string, unknown>));
  const nodeRelations = rebuildRelations(edges).map((r) => ({
    ...compact(r as unknown as Record<string, unknown>),
    slotRelations: r.slotRelations,
  }));

  const doc = {
    name: header.name,
    ...(header.description !== undefined ? { description: header.description } : {}),
    parameters: header.parameters,
    spec: {
      nodeDrafts,
      nodeRelations,
    },
  };

  const body = stringify(doc, { lineWidth: 0 });
  if (opts.headerComment === false) return body;
  return `# regenerated by yaml-graph-sync\n${body}`;
}

// ─── Helpers exposed for tests / hooks ──────────────────────────────────────

/**
 * Parse both inputs and compare structurally — used for round-trip equality
 * assertions. The `# regenerated …` header is ignored (YAML treats it as a
 * comment).
 */
export function yamlSemanticEq(a: string, b: string): boolean {
  try {
    const ra = parse(a);
    const rb = parse(b);
    return JSON.stringify(ra) === JSON.stringify(rb);
  } catch {
    return false;
  }
}
