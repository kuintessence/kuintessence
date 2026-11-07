import type { Workflow, workflowDsl } from "@kuintessence/shared";

export async function requiresDurableWorkflow(
  workflow: Workflow,
  resolveVersion?: (id: string) => Promise<Workflow | null>,
): Promise<boolean> {
  const visited = new Set<string>();
  const walk = async (spec: workflowDsl.WorkflowSpec): Promise<boolean> => {
    for (const node of spec.nodeDrafts) {
      if (node.type === "Federation") return true;
      if (node.type === "Loop" && (await walk(node.body))) return true;
      if (node.type !== "SubWorkflow") continue;
      if (node.ref.kind === "Inline") {
        if (await walk(node.ref.body)) return true;
      } else if (resolveVersion && !visited.has(node.ref.workflowVersionId)) {
        visited.add(node.ref.workflowVersionId);
        const referenced = await resolveVersion(node.ref.workflowVersionId);
        if (!referenced)
          throw new Error(`workflow version not found: ${node.ref.workflowVersionId}`);
        if (await walk(referenced.spec)) return true;
      }
    }
    return false;
  };
  return walk(workflow.spec);
}
