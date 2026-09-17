import { workflowDsl } from "@kuintessence/shared/browser";
import { parse } from "yaml";

type Workflow = workflowDsl.Workflow;

export interface ParseIssue {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

export interface ParseSuccess {
  ok: true;
  workflow: Workflow;
}

export interface ParseFailure {
  ok: false;
  message: string;
  /** Zod issues if shape validation failed; undefined for YAML syntax errors
   *  and for cross-field static-validation failures (those carry their own
   *  message). */
  issues?: ReadonlyArray<ParseIssue>;
}

export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Parse a YAML string against the canonical workflow schema, then run the
 * cross-field static validator. Both the schema and validator are shared with Server.
 */
export function parseWorkflowYaml(yaml: string): ParseResult {
  if (!yaml.trim()) {
    return { ok: false, message: "YAML is empty" };
  }
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "YAML parse error",
    };
  }
  const result = workflowDsl.WorkflowSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      message: "Workflow schema validation failed",
      issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    };
  }
  const errors = workflowDsl.validateWorkflow(result.data);
  if (errors.length > 0) {
    return { ok: false, message: `Workflow static validation failed: ${errors.join("; ")}` };
  }
  return { ok: true, workflow: result.data };
}

export function parsePublishedWorkflowTemplate(yaml: string): ParseResult {
  const parsed = parseWorkflowYaml(yaml);
  if (!parsed.ok || parsed.workflow.advanced?.skipStaticValidation !== true) return parsed;
  const workflow = {
    ...parsed.workflow,
    advanced: { ...parsed.workflow.advanced, skipStaticValidation: false },
  };
  const errors = workflowDsl.validateWorkflow(workflow);
  if (errors.length > 0) {
    return { ok: false, message: `Workflow static validation failed: ${errors.join("; ")}` };
  }
  return { ok: false, message: "Published workflow templates cannot skip static validation" };
}

export interface WorkflowSummary {
  nodeCount: number;
  edgeCount: number;
  /** Distinct node `type`s present, sorted, for an at-a-glance composition. */
  nodeTypes: string[];
}

export function summarize(workflow: Workflow): WorkflowSummary {
  const drafts = workflow.spec.nodeDrafts;
  const types = new Set<string>();
  for (const n of drafts) types.add(n.type);
  return {
    nodeCount: drafts.length,
    edgeCount: workflow.spec.nodeRelations.length,
    nodeTypes: [...types].sort((a, b) => a.localeCompare(b)),
  };
}
