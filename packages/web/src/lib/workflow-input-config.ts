import { workflowDsl } from "@kuintessence/shared/browser";
import { type GraphHeader, type GraphNode, graphToYaml, yamlToGraph } from "./yaml-graph-sync";

export interface WorkflowFileCandidate {
  id: string;
  name: string;
  path: string;
  size: number;
  sha256?: string;
  source: "cloud" | "local";
  rootPath?: string;
  localFile?: File;
}

export interface WorkflowFileRequirement {
  key: string;
  nodeId: string;
  nodeName: string;
  descriptor: string;
  description: string | null;
  expectedFileName: string | null;
  optional: boolean;
  batch: boolean;
  bound: WorkflowFileCandidate[];
}

export interface WorkflowValueRequirement {
  key: string;
  name: string;
  label: string;
  type: unknown;
  required: boolean;
  description: string | null;
  initialValue: string;
  nodeId?: string;
  descriptor?: string;
}

export interface WorkflowDatasetCandidate {
  assetId: string;
  manifestDigest: string;
  selectedEntries: string[];
  source: "data-market";
  targetPath?: string;
  versionId: string;
}

export interface WorkflowDatasetRequirement {
  key: string;
  nodeId: string;
  nodeName: string;
  descriptor: string;
  optional: boolean;
  usecaseVersionId: string | null;
  bound: WorkflowDatasetCandidate | null;
}

export interface WorkflowSubworkflowBlock {
  reason: "cycle" | "invalid" | "unavailable" | "unbound-dataset";
  workflowVersionId: string;
}

export interface WorkflowInputModel {
  datasets: WorkflowDatasetRequirement[];
  files: WorkflowFileRequirement[];
  unresolvedSubworkflowRefs: WorkflowSubworkflowBlock[];
  values: WorkflowValueRequirement[];
}

export type WorkflowVersionLoader = (workflowVersionId: string) => Promise<{ yamlContent: string }>;

export function resolveWorkflowDatasetBinding(
  bindings: Record<string, WorkflowDatasetCandidate | null>,
  key: string,
  fallback: WorkflowDatasetCandidate | null,
): WorkflowDatasetCandidate | null {
  return Object.hasOwn(bindings, key) ? (bindings[key] ?? null) : fallback;
}

/** Compare the complete immutable Data Market reference, not just its version id. */
export function sameWorkflowDatasetInput(
  left: WorkflowDatasetCandidate,
  right: WorkflowDatasetCandidate,
): boolean {
  if (
    left.source !== right.source ||
    left.assetId !== right.assetId ||
    left.versionId !== right.versionId ||
    left.manifestDigest !== right.manifestDigest ||
    (left.targetPath ?? null) !== (right.targetPath ?? null) ||
    left.selectedEntries.length !== right.selectedEntries.length
  ) {
    return false;
  }
  const leftEntries = [...left.selectedEntries].sort();
  const rightEntries = [...right.selectedEntries].sort();
  return leftEntries.every((entry, index) => entry === rightEntries[index]);
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function hasDynamicBinding(slot: Record<string, unknown>): boolean {
  return slot.from !== undefined || slot.sources !== undefined;
}

export function extractWorkflowInputModel(yaml: string): WorkflowInputModel {
  const parsed = yamlToGraph(yaml);
  if (!parsed.ok) return { datasets: [], files: [], unresolvedSubworkflowRefs: [], values: [] };
  const values: WorkflowValueRequirement[] = parsed.graph.header.parameters.map((parameter) => ({
    key: `param:${parameter.name}`,
    name: parameter.name,
    label: parameter.name,
    type: parameter.type,
    required: parameter.required,
    description: parameter.description ?? null,
    initialValue: displayValue(parameter.default),
  }));
  const files: WorkflowFileRequirement[] = [];
  const datasets: WorkflowDatasetRequirement[] = [];
  const unresolvedSubworkflowRefs: WorkflowSubworkflowBlock[] = [];
  collectNodeInputs(
    parsed.graph.nodes.map((node) => node.data.raw),
    parsed.graph.edges.flatMap((edge) =>
      (edge.slotRelations ?? []).map((relation) => ({
        toId: edge.target,
        toSlot: relation.toSlot,
      })),
    ),
    [],
    [],
    true,
    values,
    files,
    datasets,
    unresolvedSubworkflowRefs,
  );

  return { datasets, files, unresolvedSubworkflowRefs, values };
}

/**
 * Resolves immutable ByVersion references solely to determine whether their
 * already-frozen Dataset slots are runnable. Parent workflow inputs cannot
 * override those slots, so they deliberately never become picker requirements.
 */
export async function resolveWorkflowInputModel(
  yaml: string,
  loadWorkflowVersion: WorkflowVersionLoader,
): Promise<WorkflowInputModel> {
  const model = extractWorkflowInputModel(yaml);
  if (model.unresolvedSubworkflowRefs.length === 0) return model;

  const parsed = yamlToGraph(yaml);
  if (!parsed.ok) return model;

  const blocks: WorkflowSubworkflowBlock[] = [];
  const fetched = new Map<
    string,
    Promise<
      { kind: "invalid" | "unavailable" } | { kind: "ready"; nodes: workflowDsl.WorkflowNode[] }
    >
  >();
  const visitedWorkflowVersions = new Set<string>();

  const loadNodes = (
    workflowVersionId: string,
  ): Promise<
    { kind: "invalid" | "unavailable" } | { kind: "ready"; nodes: workflowDsl.WorkflowNode[] }
  > => {
    const existing = fetched.get(workflowVersionId);
    if (existing) return existing;
    const request = loadWorkflowVersion(workflowVersionId)
      .then((template) => {
        const child = yamlToGraph(template.yamlContent);
        return child.ok
          ? { kind: "ready" as const, nodes: child.graph.nodes.map((node) => node.data.raw) }
          : { kind: "invalid" as const };
      })
      .catch(() => ({ kind: "unavailable" as const }));
    fetched.set(workflowVersionId, request);
    return request;
  };

  const addBlock = (block: WorkflowSubworkflowBlock): void => {
    if (
      !blocks.some(
        (candidate) =>
          candidate.workflowVersionId === block.workflowVersionId &&
          candidate.reason === block.reason,
      )
    ) {
      blocks.push(block);
    }
  };

  const inspectNodes = async (
    nodes: workflowDsl.WorkflowNode[],
    ancestors: ReadonlySet<string>,
    referencedVersionId: string | null,
  ): Promise<void> => {
    for (const node of nodes) {
      if ("inputSlots" in node) {
        const hasUnboundDataset = node.inputSlots?.some(
          (slot) =>
            slot.type === "Dataset" &&
            !slot.optional &&
            (slot.contents === undefined || slot.contents === null),
        );
        if (hasUnboundDataset && referencedVersionId) {
          addBlock({ reason: "unbound-dataset", workflowVersionId: referencedVersionId });
        }
      }
      if (node.type === "Loop") {
        await inspectNodes(node.body.nodeDrafts, ancestors, referencedVersionId);
      } else if (node.type === "SubWorkflow" && node.ref.kind === "Inline") {
        await inspectNodes(node.ref.body.nodeDrafts, ancestors, referencedVersionId);
      } else if (node.type === "SubWorkflow" && node.ref.kind === "ByVersion") {
        const workflowVersionId = node.ref.workflowVersionId;
        if (ancestors.has(workflowVersionId)) {
          addBlock({ reason: "cycle", workflowVersionId });
          continue;
        }
        if (visitedWorkflowVersions.has(workflowVersionId)) continue;
        visitedWorkflowVersions.add(workflowVersionId);
        const child = await loadNodes(workflowVersionId);
        if (child.kind !== "ready") {
          addBlock({ reason: child.kind, workflowVersionId });
          continue;
        }
        await inspectNodes(
          child.nodes,
          new Set([...ancestors, workflowVersionId]),
          workflowVersionId,
        );
      }
    }
  };

  await inspectNodes(
    parsed.graph.nodes.map((node) => node.data.raw),
    new Set(),
    null,
  );
  return { ...model, unresolvedSubworkflowRefs: blocks };
}

function collectNodeInputs(
  nodes: workflowDsl.WorkflowNode[],
  relations: Array<{ toId: string; toSlot: string }>,
  scope: string[],
  parentNames: string[],
  collectTextValues: boolean,
  values: WorkflowValueRequirement[],
  files: WorkflowFileRequirement[],
  datasets: WorkflowDatasetRequirement[],
  unresolvedSubworkflowRefs: WorkflowSubworkflowBlock[],
): void {
  const connectedInputs = new Set(
    relations.map((relation) => `${relation.toId}:${relation.toSlot}`),
  );
  for (const raw of nodes) {
    const nodePath = [...scope, raw.id];
    const scopedId = nodePath.join("/");
    const nodeName = [...parentNames, raw.name].join(" / ");
    if ("inputSlots" in raw && raw.inputSlots) {
      for (const slot of raw.inputSlots) {
        const key = `slot:${scopedId}:${slot.descriptor}`;
        if (slot.type === "Dataset") {
          const contents = slot.contents?.source === "data-market" ? slot.contents : null;
          datasets.push({
            key: `dataset:${scopedId}:${slot.descriptor}`,
            nodeId: scopedId,
            nodeName,
            descriptor: slot.descriptor,
            optional: slot.optional,
            usecaseVersionId:
              raw.type === "SoftwareUsecaseComputing" ? (raw.usecaseVersionId ?? null) : null,
            bound: contents,
          });
          continue;
        }
        if (connectedInputs.has(`${raw.id}:${slot.descriptor}`)) continue;
        if (slot.type === "File" && !hasDynamicBinding(slot)) {
          files.push({
            key,
            nodeId: scopedId,
            nodeName,
            descriptor: slot.descriptor,
            description: slot.description ?? null,
            expectedFileName: slot.expectedFileName ?? null,
            optional: slot.optional,
            batch: slot.isBatch,
            bound: (slot.contents ?? []).map((file) => ({
              id: file.fileMetadataId,
              name: file.fileMetadataName,
              path: file.fileMetadataName,
              size: file.size,
              sha256: file.hash,
              source: "cloud",
            })),
          });
        }
        if (!collectTextValues || slot.type !== "Text" || slot.sources !== undefined) continue;
        const parameterBinding = slot.from && "param" in slot.from ? slot.from.param : undefined;
        if (slot.from !== undefined && !parameterBinding) continue;
        const scriptInput = raw.type === "Script" ? raw.inputs[slot.descriptor] : undefined;
        const name = parameterBinding ?? parameterName(scopedId, slot.descriptor);
        const parameterKey = parameterBinding ? `param:${parameterBinding}` : key;
        const existingIndex = values.findIndex((requirement) => requirement.name === name);
        const requirement: WorkflowValueRequirement = {
          key: parameterKey,
          name,
          label: `${nodeName} / ${slot.descriptor}`,
          type: scriptInput?.type === "JSON" ? "json" : "string",
          required: !slot.optional,
          description: slot.description ?? null,
          initialValue: "",
          nodeId: scopedId,
          descriptor: slot.descriptor,
        };
        if (existingIndex >= 0) {
          const current = values[existingIndex];
          values[existingIndex] = {
            ...requirement,
            type: current?.type ?? requirement.type,
            initialValue: current?.initialValue ?? requirement.initialValue,
          };
        } else {
          values.push(requirement);
        }
      }
    }
    if (raw.type === "Loop") {
      collectNodeInputs(
        raw.body.nodeDrafts,
        slotTargets(raw.body.nodeRelations),
        nodePath,
        [...parentNames, raw.name],
        collectTextValues,
        values,
        files,
        datasets,
        unresolvedSubworkflowRefs,
      );
    } else if (raw.type === "SubWorkflow" && raw.ref.kind === "Inline") {
      collectNodeInputs(
        raw.ref.body.nodeDrafts,
        slotTargets(raw.ref.body.nodeRelations),
        nodePath,
        [...parentNames, raw.name],
        false,
        values,
        files,
        datasets,
        unresolvedSubworkflowRefs,
      );
    } else if (raw.type === "SubWorkflow" && raw.ref.kind === "ByVersion") {
      unresolvedSubworkflowRefs.push({
        reason: "unavailable",
        workflowVersionId: raw.ref.workflowVersionId,
      });
    }
  }
}

function slotTargets(
  relations: workflowDsl.NodeRelation[],
): Array<{ toId: string; toSlot: string }> {
  return relations.flatMap((relation) =>
    relation.slotRelations.map((slot) => ({ toId: relation.toId, toSlot: slot.toSlot })),
  );
}

function parameterName(nodeId: string, descriptor: string): string {
  const slug = `${nodeId}_${descriptor}`.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(slug) ? slug : `input_${slug}`;
}

function coerceValue(value: string, type: unknown): unknown {
  if (value === "") return undefined;
  if (type === "int") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`'${value}' is not an integer`);
    return parsed;
  }
  if (type === "double") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`'${value}' is not a number`);
    return parsed;
  }
  if (type === "bool") {
    if (value !== "true" && value !== "false") throw new Error(`'${value}' is not a boolean`);
    return value === "true";
  }
  if (type === "json" || typeof type === "object") return JSON.parse(value);
  return value;
}

export function applyWorkflowInputConfiguration(
  yaml: string,
  model: WorkflowInputModel,
  values: Record<string, string>,
  bindings: Record<string, WorkflowFileCandidate[]>,
  datasetBindings: Record<string, WorkflowDatasetCandidate | null> = {},
): string {
  const parsed = yamlToGraph(yaml);
  if (!parsed.ok) throw new Error(parsed.message);
  const valueByKey = new Map(model.values.map((requirement) => [requirement.key, requirement]));
  const valueBySlot = new Map(
    model.values
      .filter((requirement) => requirement.nodeId && requirement.descriptor)
      .map((requirement) => [`slot:${requirement.nodeId}:${requirement.descriptor}`, requirement]),
  );
  const parameterByName = new Map(
    parsed.graph.header.parameters.map((parameter) => [parameter.name, parameter]),
  );

  for (const requirement of model.values) {
    if (requirement.nodeId && !parameterByName.has(requirement.name)) {
      parameterByName.set(requirement.name, {
        name: requirement.name,
        type: requirement.type as GraphHeader["parameters"][number]["type"],
        required: requirement.required,
        description: requirement.description,
      });
    }
  }

  const parameters = [...parameterByName.values()].map((parameter) => {
    const requirement = model.values.find((candidate) => candidate.name === parameter.name);
    if (!requirement) return parameter;
    const nextDefault = coerceValue(values[requirement.key] ?? "", parameter.type);
    const { default: _default, ...rest } = parameter;
    return nextDefault === undefined ? rest : { ...rest, default: nextDefault };
  });
  const nodes = parsed.graph.nodes.map((node) =>
    applyNodeConfiguration(node, valueByKey, valueBySlot, bindings, datasetBindings, []),
  );
  return graphToYaml({ ...parsed.graph.header, parameters }, nodes, parsed.graph.edges);
}

function applyNodeConfiguration(
  node: GraphNode,
  valueByKey: Map<string, WorkflowValueRequirement>,
  valueBySlot: Map<string, WorkflowValueRequirement>,
  bindings: Record<string, WorkflowFileCandidate[]>,
  datasetBindings: Record<string, WorkflowDatasetCandidate | null>,
  scope: string[],
): GraphNode {
  const raw = applyRawNodeConfiguration(
    node.data.raw,
    valueByKey,
    valueBySlot,
    bindings,
    datasetBindings,
    scope,
  );
  return { ...node, data: { ...node.data, raw } };
}

function applyRawNodeConfiguration(
  raw: workflowDsl.WorkflowNode,
  valueByKey: Map<string, WorkflowValueRequirement>,
  valueBySlot: Map<string, WorkflowValueRequirement>,
  bindings: Record<string, WorkflowFileCandidate[]>,
  datasetBindings: Record<string, WorkflowDatasetCandidate | null>,
  scope: string[],
): workflowDsl.WorkflowNode {
  const nodePath = [...scope, raw.id];
  const scopedId = nodePath.join("/");
  let configured: workflowDsl.WorkflowNode = raw;
  if ("inputSlots" in raw && raw.inputSlots) {
    const inputSlots = raw.inputSlots.map((slot) => {
      const key = `slot:${scopedId}:${slot.descriptor}`;
      if (slot.type === "Dataset") {
        const datasetKey = `dataset:${scopedId}:${slot.descriptor}`;
        if (!Object.hasOwn(datasetBindings, datasetKey)) return slot;
        const contents = datasetBindings[datasetKey] ?? null;
        const { from: _from, select: _select, sources: _sources, ...rest } = slot;
        return { ...rest, contents };
      }
      if (slot.type === "File") {
        const assigned = bindings[key] ?? [];
        if (assigned.length === 0) return slot;
        const { from: _from, select: _select, sources: _sources, ...rest } = slot;
        return {
          ...rest,
          contents: assigned.map((file) => {
            if (!file.sha256) throw new Error(`File '${file.name}' has not been uploaded`);
            return {
              fileMetadataId: file.id,
              fileMetadataName: file.name,
              hash: file.sha256,
              size: file.size,
            };
          }),
        };
      }
      const valueRequirement = valueBySlot.get(key) ?? valueByKey.get(key);
      if (!valueRequirement) return slot;
      const { contents: _contents, select: _select, sources: _sources, ...rest } = slot;
      return { ...rest, from: { param: valueRequirement.name } };
    });
    configured = workflowDsl.WorkflowNodeSchema.parse({ ...raw, inputSlots });
  }
  if (configured.type === "Loop") {
    configured = {
      ...configured,
      body: {
        ...configured.body,
        nodeDrafts: configured.body.nodeDrafts.map((child) =>
          applyRawNodeConfiguration(
            child,
            valueByKey,
            valueBySlot,
            bindings,
            datasetBindings,
            nodePath,
          ),
        ),
      },
    };
  } else if (configured.type === "SubWorkflow" && configured.ref.kind === "Inline") {
    configured = {
      ...configured,
      ref: {
        ...configured.ref,
        body: {
          ...configured.ref.body,
          nodeDrafts: configured.ref.body.nodeDrafts.map((child) =>
            applyRawNodeConfiguration(
              child,
              valueByKey,
              valueBySlot,
              bindings,
              datasetBindings,
              nodePath,
            ),
          ),
        },
      },
    };
  }
  return workflowDsl.WorkflowNodeSchema.parse(configured);
}

function normalized(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9一-鿿]/g, "");
}

function matchScore(requirement: WorkflowFileRequirement, file: WorkflowFileCandidate): number {
  const expected = normalized(requirement.expectedFileName ?? requirement.descriptor);
  const filename = normalized(file.name);
  const path = normalized(file.path);
  const node = normalized(requirement.nodeName || requirement.nodeId);
  let score = 0;
  if (filename === expected) score += 100;
  else if (filename.includes(expected) || expected.includes(filename)) score += 55;
  if (node && path.includes(node)) score += 35;
  if (path.includes(normalized(requirement.nodeId))) score += 20;
  return score;
}

export function smartMatchWorkflowFiles(
  requirements: WorkflowFileRequirement[],
  candidates: WorkflowFileCandidate[],
  current: Record<string, WorkflowFileCandidate[]>,
): Record<string, WorkflowFileCandidate[]> {
  const next = { ...current };
  const used = new Set(Object.values(current).flatMap((files) => files.map((file) => file.id)));
  for (const requirement of requirements) {
    if ((next[requirement.key]?.length ?? 0) > 0) continue;
    const ranked = candidates
      .filter((file) => !used.has(file.id))
      .map((file) => ({ file, score: matchScore(requirement, file) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    const selected = requirement.batch
      ? ranked.filter((entry) => entry.score === ranked[0]?.score).map((entry) => entry.file)
      : ranked[0]
        ? [ranked[0].file]
        : [];
    if (selected.length > 0) {
      next[requirement.key] = selected;
      for (const file of selected) used.add(file.id);
    }
  }
  return next;
}
