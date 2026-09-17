import { z } from "zod";
import { WorkflowSchema } from "./workflow-dsl";

/**
 * JSON Schema export for the control-flow workflow DSL.
 * External tools (Monaco/VS Code YAML, CI lint) pin
 * this without running the Server. Derived mechanically from the Zod source of
 * truth via `z.toJSONSchema`.
 *
 * Cross-field constraints expressed via `superRefine` (e.g. While requires
 * `until`) and the static checks in `validateWorkflow` are NOT representable
 * in JSON Schema; `unrepresentable: "any"` degrades them gracefully. The Server
 * parser remains the authority for those.
 */
export const WORKFLOW_SCHEMA_ID = "https://platform.local/schemas/workflow.json";
export const WORKFLOW_SCHEMA_TITLE = "Workflow DSL";

export interface WorkflowJsonSchema {
  $schema: string;
  $id?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

export function getWorkflowJsonSchema(): WorkflowJsonSchema {
  const raw = z.toJSONSchema(WorkflowSchema, {
    io: "input",
    unrepresentable: "any",
  }) as WorkflowJsonSchema;
  return {
    ...raw,
    $id: WORKFLOW_SCHEMA_ID,
    title: WORKFLOW_SCHEMA_TITLE,
    description:
      "Control-flow workflow DSL for federated HPC. Generated from the Zod " +
      "source of truth; cross-field and static-validation rules are enforced by " +
      "the Server parser, not this schema.",
  };
}

/** Pre-computed schema constant for consumers that don't need a fresh copy. */
export const WORKFLOW_JSON_SCHEMA: WorkflowJsonSchema = getWorkflowJsonSchema();
