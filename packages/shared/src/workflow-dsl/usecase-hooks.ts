import type { WorkflowNode, WorkflowSpec } from "./node";
import type { ScriptInputSpec } from "./script";
import type { NodeInputSlot } from "./slot";

function stageInputs(
  source: string,
  descriptors: Record<string, ScriptInputSpec>,
): NodeInputSlot[] {
  return Object.entries(descriptors).map(([descriptor, spec]) => {
    const common = {
      descriptor,
      from: { node: source, output: descriptor },
      optional: !spec.required,
    };
    return spec.type === "File" || spec.type === "FileBatch"
      ? { ...common, type: "File", isBatch: spec.type === "FileBatch" }
      : {
          ...common,
          type: "Text",
          ...(spec.type === "JSON" ? { rule: { type: "Json" as const } } : {}),
        };
  });
}

/** Expand before policy checks and placement so every stage has a normal durable node identity. */
export function expandUsecaseHooks(
  spec: WorkflowSpec,
  issue: (message: string) => void,
): WorkflowSpec {
  const ids = new Set(spec.nodeDrafts.map((node) => node.id));
  const entries = new Map<string, string>();
  const nodes: WorkflowNode[] = [];
  const links: WorkflowSpec["nodeRelations"] = [];
  for (const node of spec.nodeDrafts) {
    if (node.type === "Loop") {
      nodes.push({ ...node, body: expandUsecaseHooks(node.body, issue) });
    } else if (node.type === "SubWorkflow" && node.ref.kind === "Inline") {
      nodes.push({ ...node, ref: { ...node.ref, body: expandUsecaseHooks(node.ref.body, issue) } });
    } else if (node.type === "SoftwareUsecaseComputing" && node.hooks) {
      const {
        hooks: { pre, post },
        when,
        ...main
      } = node;
      const preId = `${node.id}__pre`;
      const mainId = post ? `${node.id}__main` : node.id;
      for (const id of [...(pre ? [preId] : []), ...(post ? [mainId] : [])]) {
        if (ids.has(id)) issue(`Usecase hook node ID '${id}' is already in use`);
        ids.add(id);
      }
      const schedulingStrategy = node.schedulingStrategy ?? { type: "Auto" };
      entries.set(node.id, pre ? preId : mainId);
      if (pre) {
        for (const slot of node.inputSlots ?? []) {
          const type = pre.inputs[slot.descriptor]?.type;
          const matches =
            slot.type === "Text"
              ? type === "Text" || type === "JSON"
              : slot.type === "Dataset" || slot.isBatch
                ? type === "FileBatch"
                : type === "File";
          if (!matches)
            issue(`Pre-hook input '${slot.descriptor}' must match the input slot on '${node.id}'`);
        }
        for (const [descriptor, input] of Object.entries(pre.inputs)) {
          if (input.required && !node.inputSlots?.some((slot) => slot.descriptor === descriptor))
            issue(`Pre-hook on '${node.id}' requires an input slot for '${descriptor}'`);
        }
        nodes.push({
          type: "Script",
          id: preId,
          name: `${node.name} (pre)`,
          ...pre,
          when,
          schedulingStrategy,
          requirements: node.requirements,
          inputSlots: node.inputSlots,
        });
        links.push({ fromId: preId, toId: mainId, slotRelations: [] });
      }
      nodes.push({
        ...main,
        id: mainId,
        when: pre ? undefined : when,
        inputSlots: pre ? stageInputs(preId, pre.outputs) : node.inputSlots,
      });
      if (post) {
        for (const [descriptor, input] of Object.entries(post.inputs)) {
          if (input.type !== "File" && input.type !== "FileBatch") continue;
          const slot = node.outputSlots?.find((s) => s.descriptor === descriptor);
          if (slot?.type !== "File" || slot.isBatch !== (input.type === "FileBatch"))
            issue(
              `Post-hook file '${descriptor}' requires a matching main output slot on '${node.id}'`,
            );
        }
        nodes.push({
          type: "Script",
          id: node.id,
          name: `${node.name} (post)`,
          ...post,
          schedulingStrategy,
          requirements: node.requirements,
          inputSlots: stageInputs(mainId, post.inputs),
        });
        links.push({ fromId: mainId, toId: node.id, slotRelations: [] });
      }
    } else {
      nodes.push(node);
    }
  }
  if (!entries.size) return { ...spec, nodeDrafts: nodes };
  return {
    nodeDrafts: nodes.map((node) =>
      node.type === "Switch"
        ? {
            ...node,
            cases: node.cases.map((branch) => ({
              ...branch,
              to: entries.get(branch.to) ?? branch.to,
            })),
            default: node.default && (entries.get(node.default) ?? node.default),
          }
        : node,
    ),
    nodeRelations: [
      ...spec.nodeRelations.map((link) => ({ ...link, toId: entries.get(link.toId) ?? link.toId })),
      ...links,
    ],
  };
}
