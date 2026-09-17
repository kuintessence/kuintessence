import type { WorkflowNode, WorkflowSpec } from "./node";
import type { Workflow } from "./workflow";

/**
 * Cross-field static checks the Zod schema cannot express: id uniqueness,
 * referential integrity of intra-template references, and acyclicity of the
 * dependency graph. Runs per `WorkflowSpec` scope and recurses into Loop
 * bodies and inline sub-workflow bodies. Returns a list of human-readable
 * problems (empty = valid). Honors `advanced.skipStaticValidation` (D7a).
 *
 * Expression-level reference checks (e.g. `nodes.<id>` inside CEL strings)
 * require a CEL parser and are intentionally out of scope here.
 */
export function validateWorkflow(wf: Workflow): string[] {
  if (wf.advanced?.skipStaticValidation) return [];
  const errors: string[] = [];
  validateParameters(wf, errors);
  validateSpec(wf.spec, "spec", errors, new Set(wf.parameters.map((parameter) => parameter.name)));
  return errors;
}

function validateParameters(wf: Workflow, errors: string[]): void {
  const seen = new Set<string>();
  for (const parameter of wf.parameters) {
    if (seen.has(parameter.name)) {
      errors.push(`workflow: duplicate parameter name "${parameter.name}"`);
    }
    seen.add(parameter.name);
  }
}

function validateSpec(
  spec: WorkflowSpec,
  path: string,
  errors: string[],
  paramNames: ReadonlySet<string>,
): void {
  const nodes = spec.nodeDrafts;
  const ids = new Set<string>();
  const byId = new Map<string, WorkflowNode>();
  for (const n of nodes) {
    if (ids.has(n.id)) {
      errors.push(`${path}: duplicate node id "${n.id}"`);
    }
    ids.add(n.id);
    byId.set(n.id, n);
  }

  for (const rel of spec.nodeRelations) {
    const from = byId.get(rel.fromId);
    const to = byId.get(rel.toId);
    if (!from) {
      errors.push(`${path}: relation fromId references unknown node "${rel.fromId}"`);
    }
    if (!to) {
      errors.push(`${path}: relation toId references unknown node "${rel.toId}"`);
    }
    if (from && to) {
      validateSlotRelations(rel, from, to, path, errors);
    }
  }

  if (hasCycle(ids, spec.nodeRelations)) {
    errors.push(`${path}: dependency graph has a cycle`);
  }

  for (const n of nodes) {
    if ("inputSlots" in n) {
      validateUniqueDescriptors(
        n.inputSlots ?? [],
        (slot) => slot.descriptor,
        `${path}: node "${n.id}" input descriptor`,
        errors,
      );
      for (const slot of n.inputSlots ?? []) {
        if (isNodeOutputRef(slot.from)) {
          validateNodeOutputRef(
            slot.from,
            byId,
            `${path}: node "${n.id}" input "${slot.descriptor}"`,
            errors,
          );
        } else if (isParamRef(slot.from)) {
          validateParamRef(
            slot.from,
            paramNames,
            `${path}: node "${n.id}" input "${slot.descriptor}"`,
            errors,
          );
        }
        for (const source of slot.sources ?? []) {
          validateNodeOutputRef(
            source,
            byId,
            `${path}: node "${n.id}" input "${slot.descriptor}" source`,
            errors,
          );
        }
      }
    }
    validateUniqueDescriptors(
      outputDescriptorItems(n) ?? [],
      (descriptor) => descriptor,
      `${path}: node "${n.id}" output descriptor`,
      errors,
    );

    if (n.type === "Switch") {
      for (const c of n.cases) {
        if (!ids.has(c.to)) {
          errors.push(`${path}: Switch "${n.id}" case target "${c.to}" does not exist`);
        }
      }
      if (n.default !== undefined && !ids.has(n.default)) {
        errors.push(`${path}: Switch "${n.id}" default target "${n.default}" does not exist`);
      }
    } else if (n.type === "Reduce") {
      const target = byId.get(n.from.loop);
      if (!target) {
        errors.push(`${path}: Reduce "${n.id}" references unknown loop "${n.from.loop}"`);
      } else if (target.type !== "Loop") {
        errors.push(`${path}: Reduce "${n.id}" from.loop "${n.from.loop}" is not a Loop node`);
      } else {
        validateLoopOutputRef(n.from.output, target, `${path}: Reduce "${n.id}"`, errors);
        if (n.reducer.kind === "Statistics") {
          validateLoopOutputRef(
            n.reducer.over,
            target,
            `${path}: Reduce "${n.id}" Statistics over`,
            errors,
          );
        } else if (n.reducer.kind === "ExtractTable") {
          const bodyById = nodeMap(target.body);
          for (const column of n.reducer.columns) {
            if (isNodeOutputRef(column.source)) {
              validateNodeOutputRef(
                column.source,
                bodyById,
                `${path}: Reduce "${n.id}" column "${column.name}"`,
                errors,
              );
            }
          }
        }
      }
    } else if (n.type === "Loop") {
      const bodyById = nodeMap(n.body);
      for (const output of n.outputs ?? []) {
        validateNodeOutputRef(
          output.from,
          bodyById,
          `${path}: Loop "${n.id}" output "${output.descriptor}"`,
          errors,
        );
      }
      for (const carry of n.carry ?? []) {
        validateNodeOutputRef(carry.from, bodyById, `${path}: Loop "${n.id}" carry`, errors);
        validateLoopCarryTargetInput(
          carry.to.input,
          n.body,
          `${path}: Loop "${n.id}" carry target`,
          errors,
        );
        if (isNodeOutputRef(carry.initial)) {
          validateNodeOutputRef(
            carry.initial,
            byId,
            `${path}: Loop "${n.id}" carry initial`,
            errors,
          );
        } else if (isParamRef(carry.initial)) {
          validateParamRef(
            carry.initial,
            paramNames,
            `${path}: Loop "${n.id}" carry initial`,
            errors,
          );
        }
      }
      validateSpec(n.body, `${path}.${n.id}.body`, errors, paramNames);
    } else if (n.type === "SubWorkflow") {
      for (const input of n.inputs ?? []) {
        if (isNodeOutputRef(input.from)) {
          validateNodeOutputRef(
            input.from,
            byId,
            `${path}: SubWorkflow "${n.id}" input "${input.to.param}"`,
            errors,
          );
        } else if (isParamRef(input.from)) {
          validateParamRef(
            input.from,
            paramNames,
            `${path}: SubWorkflow "${n.id}" input "${input.to.param}"`,
            errors,
          );
        }
      }
      if (n.ref.kind === "Inline") {
        for (const output of n.outputs ?? []) {
          validateWorkflowOutputRef(
            output.from.workflowOutput,
            n.ref.body,
            `${path}: SubWorkflow "${n.id}" output "${output.descriptor}"`,
            errors,
          );
        }
        validateSpec(
          n.ref.body,
          `${path}.${n.id}.body`,
          errors,
          new Set((n.inputs ?? []).map((input) => input.to.param)),
        );
      }
    } else if (
      n.type === "Generate" &&
      n.rule.kind === "FromFile" &&
      isNodeOutputRef(n.rule.source)
    ) {
      validateNodeOutputRef(
        n.rule.source,
        byId,
        `${path}: Generate "${n.id}" FromFile source`,
        errors,
      );
    }
  }
}

function validateUniqueDescriptors<T>(
  items: ReadonlyArray<T>,
  descriptorOf: (item: T) => string,
  context: string,
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const descriptor = descriptorOf(item);
    if (seen.has(descriptor)) {
      errors.push(`${context} "${descriptor}" is duplicated`);
    }
    seen.add(descriptor);
  }
}

function nodeMap(spec: WorkflowSpec): Map<string, WorkflowNode> {
  return new Map(spec.nodeDrafts.map((node) => [node.id, node]));
}

function isNodeOutputRef(value: unknown): value is { node: string; output: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { node?: unknown; output?: unknown };
  return typeof candidate.node === "string" && typeof candidate.output === "string";
}

function isParamRef(value: unknown): value is { param: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { param?: unknown };
  return typeof candidate.param === "string";
}

function validateParamRef(
  ref: { param: string },
  paramNames: ReadonlySet<string>,
  context: string,
  errors: string[],
): void {
  if (!paramNames.has(ref.param)) {
    errors.push(`${context} references unknown parameter "${ref.param}"`);
  }
}

function validateNodeOutputRef(
  ref: { node: string; output: string },
  nodes: ReadonlyMap<string, WorkflowNode>,
  context: string,
  errors: string[],
): void {
  const node = nodes.get(ref.node);
  if (!node) {
    errors.push(`${context} references unknown node "${ref.node}"`);
    return;
  }
  const outputs = declaredOutputDescriptors(node);
  if (outputs !== undefined && !outputs.has(ref.output)) {
    errors.push(`${context} references unknown output "${ref.output}" on node "${ref.node}"`);
  }
}

function validateLoopOutputRef(
  output: string,
  loop: Extract<WorkflowNode, { type: "Loop" }>,
  context: string,
  errors: string[],
): void {
  const outputs = new Set((loop.outputs ?? []).map((item) => item.descriptor));
  if (!outputs.has(output)) {
    errors.push(`${context} references unknown Loop output "${output}" on loop "${loop.id}"`);
  }
}

function validateWorkflowOutputRef(
  workflowOutput: string,
  spec: WorkflowSpec,
  context: string,
  errors: string[],
): void {
  const nodes = nodeMap(spec);
  const sameNode = nodes.get(workflowOutput);
  if (sameNode) {
    const outputs = declaredOutputDescriptors(sameNode);
    if (outputs === undefined || outputs.has(workflowOutput) || outputs.size === 1) {
      return;
    }
  }

  let hasUnknownOutputNode = false;
  let matches = 0;
  for (const node of spec.nodeDrafts) {
    const outputs = declaredOutputDescriptors(node);
    if (outputs === undefined) {
      hasUnknownOutputNode = true;
    } else if (outputs.has(workflowOutput)) {
      matches += 1;
    }
  }

  if (matches === 1) {
    return;
  }
  if (matches > 1) {
    errors.push(`${context} references ambiguous workflow output "${workflowOutput}"`);
    return;
  }
  if (!hasUnknownOutputNode) {
    errors.push(`${context} references unknown workflow output "${workflowOutput}"`);
  }
}

function validateLoopCarryTargetInput(
  input: string,
  body: WorkflowSpec,
  context: string,
  errors: string[],
): void {
  const inputs = declaredWorkflowInputDescriptors(body);
  if (inputs !== undefined && !inputs.has(input)) {
    errors.push(`${context} references unknown body input "${input}"`);
  }
}

function declaredWorkflowInputDescriptors(spec: WorkflowSpec): Set<string> | undefined {
  const inputs = new Set<string>();
  for (const node of spec.nodeDrafts) {
    const nodeInputs = declaredInputDescriptors(node);
    if (nodeInputs === undefined) {
      return undefined;
    }
    for (const descriptor of nodeInputs) {
      inputs.add(descriptor);
    }
  }
  return inputs;
}

function validateSlotRelations(
  rel: WorkflowSpec["nodeRelations"][number],
  from: WorkflowNode,
  to: WorkflowNode,
  path: string,
  errors: string[],
): void {
  const sourceOutputs = declaredOutputDescriptors(from);
  const targetInputs = declaredInputDescriptors(to);
  for (const slotRelation of rel.slotRelations) {
    if (sourceOutputs !== undefined && !sourceOutputs.has(slotRelation.fromSlot)) {
      errors.push(
        `${path}: relation ${rel.fromId}->${rel.toId} fromSlot "${slotRelation.fromSlot}" is not declared by node "${rel.fromId}"`,
      );
    }
    if (targetInputs !== undefined && !targetInputs.has(slotRelation.toSlot)) {
      errors.push(
        `${path}: relation ${rel.fromId}->${rel.toId} toSlot "${slotRelation.toSlot}" is not declared by node "${rel.toId}"`,
      );
    }
  }
}

function declaredInputDescriptors(node: WorkflowNode): Set<string> | undefined {
  if (
    node.type === "SoftwareUsecaseComputing" ||
    node.type === "NoAction" ||
    node.type === "Script"
  ) {
    return node.inputSlots === undefined
      ? undefined
      : new Set(node.inputSlots.map((slot) => slot.descriptor));
  }
  if (node.type === "SubWorkflow") {
    return new Set((node.inputs ?? []).map((input) => input.to.param));
  }
  return new Set();
}

function declaredOutputDescriptors(node: WorkflowNode): Set<string> | undefined {
  const descriptors = outputDescriptorItems(node);
  if (descriptors !== undefined) {
    return new Set(descriptors);
  }
  return undefined;
}

function outputDescriptorItems(node: WorkflowNode): string[] | undefined {
  if (node.type === "Generate") {
    return [node.output.descriptor];
  }
  if (node.type === "Reduce") {
    return [node.output.descriptor];
  }
  if (node.type === "Loop") {
    return (node.outputs ?? []).map((output) => output.descriptor);
  }
  if (node.type === "SubWorkflow") {
    return (node.outputs ?? []).map((output) => output.descriptor);
  }
  if (node.type === "Milestone") {
    return [];
  }
  if (node.type === "SoftwareUsecaseComputing") {
    const descriptors = [
      ...(node.outputSlots ?? []).map((slot) => slot.descriptor),
      ...(node.valueOutputsOverride ?? []).map((output) => output.descriptor),
    ];
    if (descriptors.length === 0) {
      return undefined;
    }
    return descriptors;
  }
  if (node.type === "Script") {
    return [
      ...(node.outputSlots ?? []).map((slot) => slot.descriptor),
      ...Object.keys(node.outputs),
    ];
  }
  if (node.type === "NoAction") {
    return (node.outputSlots ?? []).map((slot) => slot.descriptor);
  }
  return [];
}

function hasCycle(
  ids: ReadonlySet<string>,
  rels: ReadonlyArray<{ fromId: string; toId: string }>,
): boolean {
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    adj.set(id, []);
  }
  for (const r of rels) {
    const out = adj.get(r.fromId);
    if (out && ids.has(r.toId)) {
      out.push(r.toId);
    }
  }
  const color = new Map<string, "white" | "gray" | "black">();
  for (const id of ids) {
    color.set(id, "white");
  }
  const dfs = (u: string): boolean => {
    color.set(u, "gray");
    for (const v of adj.get(u) ?? []) {
      const cv = color.get(v);
      if (cv === "gray") {
        return true;
      }
      if (cv === "white" && dfs(v)) {
        return true;
      }
    }
    color.set(u, "black");
    return false;
  };
  for (const id of ids) {
    if (color.get(id) === "white" && dfs(id)) {
      return true;
    }
  }
  return false;
}
