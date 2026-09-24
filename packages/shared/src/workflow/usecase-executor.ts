import type { JobStatusName } from "../constants/job-status";
import * as usecase from "../usecase";
import * as workflowDsl from "../workflow-dsl";
import {
  NODE_COLLECTED_KEY,
  type NodeExecutionResult,
  type NodeExecutor,
  REQUIRED_COLLECTED_OUTPUTS_KEY,
} from "./engine";
import {
  SPACK_EXECUTION_PLACEHOLDER,
  type SpackExecution,
  SpackExecutionSchema,
} from "./spack-execution";

type CelValue = workflowDsl.CelValue;

/** The usecase/software package data needed to materialize a node into a task. */
export interface ResolvedPackage {
  usecasePackageId?: string;
  usecase: { commandFile: string; inputSlots: usecase.UsecaseInputSlot[] };
  software: usecase.SoftwareSpec;
  arguments: usecase.ArgumentMaterial[];
  environments: usecase.EnvironmentMaterial[];
  filesomeInputs: usecase.FilesomeInputMaterial[];
  filesomeOutputs: usecase.FilesomeOutputMaterial[];
  valueOutputs: workflowDsl.ValueOutput[];
  licensedMaterials?: usecase.MaterializedTask["licensedMaterials"];
  softwareRequirements?: Array<{
    assetId?: string;
    name: string;
    version?: string;
    installable: boolean;
  }>;
}

export interface JobSubmission {
  nodeId: string;
  usecasePackageId?: string;
  /** Human-readable job name (the node's name) for the jobs list / audit. */
  name: string;
  command: string;
  spackExecution?: SpackExecution;
  envVars: Record<string, string>;
  dataInputs?: Record<string, workflowDsl.DataInputRef>;
  inputStaging: { fileMetadataId: string; stagePath: string }[];
  expectedOutputs: {
    descriptor: string;
    path: string;
    isBatch: boolean;
    pathsOnly?: boolean;
  }[];
  fileOutputDescriptors?: string[];
  stdinText?: string;
  licensedMaterials?: usecase.MaterializedTask["licensedMaterials"];
  softwareRequirements?: Array<{
    assetId?: string;
    name: string;
    version?: string;
    installable: boolean;
  }>;
  /** Mapped from the node's `requirements`; omitted when the node declares
   *  none, so the submitter falls back to its defaults. */
  resources?: { cpus?: number; wallTimeSec?: number };
  schedulingStrategy?: { queueId: string } | { preferredQueueIds: string[] };
}

/** Package resolution, job dispatch and output collection dependencies. */
export interface UsecaseExecutorDeps {
  /** Production Agents activate Spack through their governed managed installation. */
  deferSpackActivation?: boolean;
  resolvePackage(usecaseVersionId: string, softwareVersionId: string): Promise<ResolvedPackage>;
  submitJob(spec: JobSubmission): Promise<{
    jobId: string;
    status: JobStatusName;
    collected: Record<string, string>;
    collectedFiles?: Record<string, usecase.FileInputValue>;
    errorMessage?: string;
    reason?: string;
    exitCode?: number;
  }>;
  executeScript?(
    node: Extract<workflowDsl.WorkflowNode, { type: "Script" }>,
    ctx: Record<string, CelValue>,
  ): Promise<NodeExecutionResult>;
}

/**
 * Compose the shared materialization pieces into an engine `NodeExecutor`:
 * resolvePackage -> materialize -> wrapCommand -> submitJob -> extractValues.
 * The engine (engine) handles control flow; this is the per-leaf execution.
 */
export function createUsecaseExecutor(deps: UsecaseExecutorDeps): NodeExecutor {
  return async (node, ctx) => {
    if (node.type === "NoAction") {
      return { status: "Succeeded", values: {} };
    }
    if (node.type === "Script" && deps.executeScript) {
      const result = await deps.executeScript(node, ctx);
      return result.status === "Failed" && !result.failure
        ? { ...result, failure: { message: "Script execution failed." } }
        : result;
    }
    if (node.type !== "SoftwareUsecaseComputing") {
      return {
        status: "Failed",
        values: {},
        failure: { message: `Execution is unavailable for node type '${node.type}'.` },
      };
    }
    if (!node.usecaseVersionId || !node.softwareVersionId) {
      throw new Error(
        `Software usecase node '${node.id}' must resolve named asset references before execution`,
      );
    }
    const pkg = await deps.resolvePackage(node.usecaseVersionId, node.softwareVersionId);
    const inputs = resolveNodeInputs(node, ctx);
    const task = usecase.materialize({
      usecase: pkg.usecase,
      software: pkg.software,
      arguments: pkg.arguments,
      environments: pkg.environments,
      filesomeInputs: pkg.filesomeInputs,
      filesomeOutputs: pkg.filesomeOutputs,
      licensedMaterials: pkg.licensedMaterials,
      inputs,
    });
    const spackExecution =
      deps.deferSpackActivation && task.facility.kind === "Spack"
        ? SpackExecutionSchema.parse({
            spec: [task.facility.name, ...task.facility.argumentList].join(" "),
            command: usecase.wrapCommand({ ...task, facility: { kind: "Bare" } }),
          })
        : undefined;
    const command = spackExecution ? SPACK_EXECUTION_PLACEHOLDER : usecase.wrapCommand(task);
    const dataInputs = collectDatasetInputs(node);
    const resources = mapResources(node.requirements);
    const schedulingStrategy = mapSchedulingStrategy(node.schedulingStrategy);
    const valueOutputs = node.valueOutputsOverride ?? pkg.valueOutputs;
    const fileOutputDescriptors = declaredFileOutputDescriptors(node);
    const contentOutputDescriptors = new Set([
      ...valueOutputs.map((output) => output.from.collectedOutDescriptor),
      ...requiredCollectedOutputs(ctx),
    ]);
    const requiredOutputDescriptors = new Set([
      ...fileOutputDescriptors,
      ...contentOutputDescriptors,
    ]);
    const { status, collected, collectedFiles, errorMessage, reason, exitCode, jobId } =
      await deps.submitJob({
        nodeId: node.id,
        ...(pkg.usecasePackageId ? { usecasePackageId: pkg.usecasePackageId } : {}),
        name: node.name,
        command,
        ...(spackExecution ? { spackExecution } : {}),
        envVars: task.envVars,
        ...(Object.keys(dataInputs).length > 0 ? { dataInputs } : {}),
        inputStaging: task.inputStaging,
        expectedOutputs: task.expectedOutputs
          .filter((output) => requiredOutputDescriptors.has(output.descriptor))
          .map((output) =>
            fileOutputDescriptors.includes(output.descriptor) &&
            !contentOutputDescriptors.has(output.descriptor)
              ? { ...output, pathsOnly: true }
              : output,
          ),
        fileOutputDescriptors,
        ...(task.stdinText !== undefined ? { stdinText: task.stdinText } : {}),
        ...(task.licensedMaterials && task.licensedMaterials.length > 0
          ? { licensedMaterials: task.licensedMaterials }
          : {}),
        ...(pkg.softwareRequirements ? { softwareRequirements: pkg.softwareRequirements } : {}),
        ...(resources ? { resources } : {}),
        ...(schedulingStrategy ? { schedulingStrategy } : {}),
      });
    if (status !== "completed") {
      const message =
        errorMessage?.trim() ||
        reason?.trim() ||
        (exitCode === undefined
          ? `Job ended with status '${status}'.`
          : `Job exited with code ${exitCode}.`);
      return {
        status: "Failed",
        values: {},
        failure: {
          message,
          jobId,
          ...(exitCode !== undefined ? { exitCode } : {}),
        },
      };
    }
    // A node may override the package's value-extraction rules for this use.
    // Surface the raw collected bundle under a reserved key so a downstream
    // `Reduce.ExtractTable` `collectedOut` column can regex it per iteration;
    // the engine strips it from the persisted result.
    return {
      status: "Succeeded",
      values: {
        ...resolveFileOutputs(node, collectedFiles ?? {}),
        ...usecase.extractValues(collected, valueOutputs),
        [NODE_COLLECTED_KEY]: collected,
      },
    };
  };
}

function collectDatasetInputs(
  node: Extract<workflowDsl.WorkflowNode, { type: "SoftwareUsecaseComputing" }>,
): Record<string, workflowDsl.DataInputRef> {
  const dataInputs: Record<string, workflowDsl.DataInputRef> = {};
  for (const slot of node.inputSlots ?? []) {
    if (slot.type === "Dataset" && slot.contents) {
      dataInputs[slot.descriptor] = slot.contents;
    }
  }
  return dataInputs;
}

function requiredCollectedOutputs(ctx: Record<string, CelValue>): string[] {
  const value = ctx[REQUIRED_COLLECTED_OUTPUTS_KEY];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mapSchedulingStrategy(
  strategy: workflowDsl.SchedulingStrategy | undefined,
): JobSubmission["schedulingStrategy"] | undefined {
  if (!strategy || strategy.type === "Auto") {
    return undefined;
  }
  if (strategy.type === "Manual") {
    const queueId = strategy.queues[0];
    return queueId ? { queueId } : undefined;
  }
  const preferredQueueIds = strategy.queues.filter((queueId) => queueId.length > 0);
  return preferredQueueIds.length > 0 ? { preferredQueueIds } : undefined;
}

/** Map the workflow node `requirements` to the job-resource subset the scheduler
 *  understands (cpuCores→cpus, maxWallTime→wallTimeSec). Returns undefined when
 *  no mappable field is present so the submitter keeps its defaults. */
function mapResources(
  reqs: workflowDsl.Requirements | null | undefined,
): { cpus?: number; wallTimeSec?: number } | undefined {
  if (!reqs) {
    return undefined;
  }
  const resources: { cpus?: number; wallTimeSec?: number } = {};
  if (reqs.cpuCores != null) {
    resources.cpus = reqs.cpuCores;
  }
  if (reqs.maxWallTime != null) {
    resources.wallTimeSec = reqs.maxWallTime;
  }
  return resources.cpus === undefined && resources.wallTimeSec === undefined
    ? undefined
    : resources;
}

function resolveNodeInputs(
  node: Extract<workflowDsl.WorkflowNode, { type: "SoftwareUsecaseComputing" }>,
  ctx: Record<string, CelValue>,
): Record<string, string | usecase.FileInputValue> {
  const inputs: Record<string, string | usecase.FileInputValue> = {};
  for (const slot of node.inputSlots ?? []) {
    if (slot.type === "Dataset") {
      continue;
    }
    if (slot.sources && slot.sources.length > 0) {
      const v = resolveSources(slot.sources, slot.select, ctx);
      if (v !== undefined) {
        assignInput(inputs, slot, v);
      }
    } else if (slot.from) {
      const v = resolveBinding(slot.from, ctx);
      if (v !== undefined) {
        assignInput(inputs, slot, v);
      }
    } else if (slot.type === "File") {
      const contents = slot.contents ?? [];
      if (slot.isBatch && contents.length > 0) {
        inputs[slot.descriptor] = contents.map((file) => ({
          fileMetadataId: file.fileMetadataId,
          fileMetadataName: file.fileMetadataName,
        }));
      } else if (slot.isBatch) {
        inputs[slot.descriptor] = [];
      } else {
        const first = contents[0];
        if (first) {
          inputs[slot.descriptor] = {
            fileMetadataId: first.fileMetadataId,
            fileMetadataName: first.fileMetadataName,
          };
        }
      }
    }
  }
  return inputs;
}

function assignInput(
  inputs: Record<string, string | usecase.FileInputValue>,
  slot: workflowDsl.NodeInputSlot,
  value: CelValue,
): void {
  if (slot.type === "Text") {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      inputs[slot.descriptor] = String(value);
      return;
    }
    throw new Error(`workflow: input "${slot.descriptor}" expected a scalar text value`);
  }
  if (slot.type === "Dataset") {
    return;
  }
  if (slot.isBatch && isFileValueArray(value)) {
    inputs[slot.descriptor] = value;
    return;
  }
  if (!slot.isBatch && isFileValue(value)) {
    inputs[slot.descriptor] = value;
    return;
  }
  throw new Error(`workflow: input "${slot.descriptor}" expected a file value`);
}

function isFileValueArray(value: unknown): value is usecase.FileValue[] {
  return Array.isArray(value) && value.every(isFileValue);
}

function resolveFileOutputs(
  node: Extract<workflowDsl.WorkflowNode, { type: "SoftwareUsecaseComputing" }>,
  collectedFiles: Record<string, usecase.FileInputValue>,
): Record<string, usecase.FileInputValue> {
  const outputs: Record<string, usecase.FileInputValue> = {};
  for (const slot of node.outputSlots ?? []) {
    if (slot.type !== "File") {
      continue;
    }
    const file = collectedFiles[slot.descriptor];
    if (file === undefined) {
      throw new Error(`workflow: declared file output "${slot.descriptor}" was not collected`);
    }
    if (slot.isBatch && isFileValueArray(file)) {
      outputs[slot.descriptor] = file;
      continue;
    }
    if (!slot.isBatch && isFileValue(file)) {
      outputs[slot.descriptor] = file;
      continue;
    }
    throw new Error(`workflow: declared file output "${slot.descriptor}" has an invalid shape`);
  }
  return outputs;
}

function declaredFileOutputDescriptors(
  node: Extract<workflowDsl.WorkflowNode, { type: "SoftwareUsecaseComputing" }>,
): string[] {
  return (node.outputSlots ?? [])
    .filter((slot) => slot.type === "File")
    .map((slot) => slot.descriptor);
}

function resolveBinding(from: unknown, ctx: Record<string, CelValue>): CelValue {
  const b = from as Record<string, unknown>;
  if (typeof b.expr === "string") {
    return workflowDsl.evalCel(b.expr, ctx);
  }
  if (typeof b.param === "string") {
    return (ctx.params as Record<string, CelValue>)[b.param];
  }
  if (typeof b.node === "string" && typeof b.output === "string") {
    const nodes = ctx.nodes as Record<string, { values?: Record<string, CelValue> }>;
    return nodes[b.node]?.values?.[b.output];
  }
  return undefined;
}

function resolveSources(
  sources: { node: string; output: string }[],
  select: workflowDsl.NodeInputSlot["select"],
  ctx: Record<string, CelValue>,
): CelValue | undefined {
  if (select !== undefined && typeof select !== "string") {
    const index = resolveSelectIndex(select, sources.length, ctx);
    if (index === undefined) {
      throw new Error("input select expression must evaluate to a valid source index");
    }
    const selected = sources[index];
    const value = selected ? resolveSourceValue(selected, ctx) : undefined;
    if (value === undefined) {
      throw new Error("input select expression selected an unavailable source");
    }
    return value;
  }
  const available = sources
    .map((source) => resolveSourceValue(source, ctx))
    .filter((value) => value !== undefined);
  if (select === "RequireExactlyOne") {
    if (available.length !== 1) {
      throw new Error("input select RequireExactlyOne expected exactly one available source");
    }
    return available[0];
  }
  return available[0];
}

function resolveSelectIndex(
  select: workflowDsl.Expr,
  sourceCount: number,
  ctx: Record<string, CelValue>,
): number | undefined {
  const value = workflowDsl.evalCel(select.expr, ctx);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < sourceCount
    ? value
    : undefined;
}

function resolveSourceValue(
  source: { node: string; output: string },
  ctx: Record<string, CelValue>,
): CelValue | undefined {
  const nodes = ctx.nodes as Record<
    string,
    { status?: string; values?: Record<string, CelValue> } | undefined
  >;
  const node = nodes[source.node];
  if (!node || node.status !== "Succeeded") {
    return undefined;
  }
  return node.values?.[source.output];
}

function isFileValue(value: unknown): value is usecase.FileValue {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<usecase.FileValue>;
  return (
    typeof candidate.fileMetadataId === "string" && typeof candidate.fileMetadataName === "string"
  );
}
