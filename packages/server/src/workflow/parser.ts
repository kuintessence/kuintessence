import { workflowDsl } from "@kuintessence/shared";
import { parse } from "yaml";

/**
 * Parse + statically validate a control-flow workflow document.
 *
 * Two-stage: Zod shape validation (throws ZodError) then cross-field static
 * checks (throws Error listing problems) before the execution engine runs.
 */
export function parseWorkflowYaml(yaml: string): workflowDsl.Workflow {
  const parsed = parse(yaml);
  const wf = workflowDsl.WorkflowSchema.parse(parsed);
  const errors = workflowDsl.validateWorkflow(wf);
  if (errors.length > 0) {
    throw new Error(`workflow static validation failed:\n${errors.join("\n")}`);
  }
  return wf;
}
