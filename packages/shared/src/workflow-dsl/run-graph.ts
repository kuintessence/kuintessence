import type { Workflow } from "./workflow";

/** One graph node for the run-detail React Flow view. */
export interface WorkflowRunGraphNode {
  id: string;
  name: string;
  /** The workflow node `type` discriminant. */
  kind: string;
}

/** One directed edge between two run-graph nodes. */
export interface WorkflowRunGraphEdge {
  source: string;
  target: string;
  /** The relation's CEL `when` guard, flattened from its `Expr` to the raw string. */
  when?: string;
}

/** Compact node/edge projection of a workflow, persisted on `workflow_runs.graph`. */
export interface WorkflowRunGraph {
  nodes: WorkflowRunGraphNode[];
  edges: WorkflowRunGraphEdge[];
}

/**
 * Project a parsed workflow into the compact `{nodes, edges}` graph the
 * run-detail view renders. A relation's `when` is an `Expr` object
 * (`{expr, lang}`); only the CEL `expr` string is kept here.
 */
export function extractRunGraph(workflow: Workflow): WorkflowRunGraph {
  const nodes: WorkflowRunGraphNode[] = workflow.spec.nodeDrafts.map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.type,
  }));
  const edges: WorkflowRunGraphEdge[] = workflow.spec.nodeRelations.map((r) => ({
    source: r.fromId,
    target: r.toId,
    ...(r.when !== undefined ? { when: r.when.expr } : {}),
  }));
  return { nodes, edges };
}
