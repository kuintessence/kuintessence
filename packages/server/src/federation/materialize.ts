import {
  DatasetSchema,
  type SoftwareAssetPayload,
  usecase,
  workflowDsl,
} from "@kuintessence/shared";
import {
  type FederationAssetRef,
  type FederationEnvironmentLock,
  type FederationInputManifest,
  type FederationReceivedInputFiles,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { parseWorkflowYaml } from "../workflow/parser";

interface LocalSoftware {
  kind: "software";
  asset: {
    id: string;
    name: string;
    source: string;
    version: string;
    providerOrgId: string | null;
  };
  revision: { id: string; revision: number };
  payload: SoftwareAssetPayload;
}
type ResolvedAsset = {
  local: LocalSoftware | { kind: "dataset"; asset: { id: string }; version: { id: string } };
};
type Node = workflowDsl.WorkflowNode;

export class FederationMaterializationError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Federation template ${path}: ${reason}`);
    this.name = "FederationMaterializationError";
  }
}

/** A receiver-local projection, not a dispatch permit. Original signed payloads remain unchanged. */
export interface FederationWorkflowProjection {
  workflow: workflowDsl.Workflow;
  /** ByVersion IDs below are pinned asset revision IDs, resolved only from this snapshot. */
  workflowVersions: Record<string, workflowDsl.Workflow>;
}

export async function materializeFederationWorkflow(input: {
  template: FederationAssetRef;
  inputs: FederationInputManifest;
  environment: FederationEnvironmentLock;
  receivedInputs?: FederationReceivedInputFiles;
  resolve(reference: FederationAssetRef): Promise<ResolvedAsset>;
}): Promise<FederationWorkflowProjection> {
  const { inputs, environment } = input;
  const versions = new Map<string, workflowDsl.Workflow>();
  const pending = new Map<string, LocalSoftware>();
  const usedDatasets = new Set<string>();
  const receivedFiles = new Map(
    (input.receivedInputs?.inputs ?? []).map((selected) => [selected.descriptor, selected]),
  );
  const usedFiles = new Set<string>();
  const fileContents = (selected: FederationReceivedInputFiles["inputs"][number]) =>
    selected.files.map((file) => ({
      fileMetadataId: file.fileId,
      fileMetadataName: file.path,
      ...(selected.type === "FileBatch" ? { relativePath: file.path } : {}),
      hash: file.sha256,
      size: file.sizeBytes,
    }));
  let nodeCount = 0;
  const fail = (path: string, reason: string): never => {
    throw new FederationMaterializationError(path, reason);
  };
  async function software(reference: FederationAssetRef, path: string): Promise<LocalSoftware> {
    const { local } = await input.resolve(reference);
    if (local.kind !== "software") return fail(path, "expected a software asset revision");
    return local;
  }
  function binding(
    kind: FederationAssetRef["kind"],
    id: string | undefined,
    selector: workflowDsl.AssetSelector | undefined,
    path: string,
  ): FederationAssetRef {
    const matches = inputs.bindings.filter(
      (candidate) =>
        candidate.asset.kind === kind &&
        (id
          ? candidate.sourceRevisionId === id
          : selector &&
            candidate.sourceSelector &&
            federationCanonicalJson(selector) ===
              federationCanonicalJson(candidate.sourceSelector)),
    );
    if (matches.length !== 1 || !matches[0]) return fail(path, "explicit pinned binding required");
    return matches[0].asset;
  }
  function readWorkflow(local: LocalSoftware, path: string) {
    if (local.payload.kind !== "workflow-template" || !local.payload.yamlContent)
      return fail(path, "workflow revision must contain its YAML definition");
    try {
      const workflow = parseWorkflowYaml(local.payload.yamlContent);
      // A foreign template cannot opt out of the receiver's static validation.
      const skipped = workflow.advanced?.skipStaticValidation;
      workflow.advanced = { skipStaticValidation: false };
      const errors = skipped ? workflowDsl.validateWorkflow(workflow) : [];
      if (errors.length) return fail(path, "workflow failed static validation");
      return workflow;
    } catch (error) {
      if (error instanceof FederationMaterializationError) throw error;
      return fail(path, "invalid workflow definition");
    }
  }
  async function slots(slots: workflowDsl.NodeInputSlot[] | undefined, path: string) {
    if (!slots) return undefined;
    return Promise.all(
      slots.map(async (slot) => {
        const field = `${path}.inputs.${slot.descriptor}`;
        if (slot.type === "Dataset") {
          const selected = inputs.datasets.find((entry) => entry.descriptor === slot.descriptor);
          if (!selected) {
            if (slot.optional && !slot.contents) return slot;
            return fail(field, "signed dataset selection required");
          }
          const { local } = await input.resolve(selected.asset);
          if (local.kind !== "dataset") return fail(field, "expected a dataset version");
          usedDatasets.add(selected.descriptor);
          return {
            ...slot,
            contents: DatasetSchema.parse({
              source: "data-market",
              assetId: local.asset.id,
              versionId: local.version.id,
              manifestDigest: selected.asset.digest,
              selectedEntries: selected.selectedEntries,
              ...(selected.targetPath ? { targetPath: selected.targetPath } : {}),
            }),
          };
        }
        if (slot.contents?.length)
          return fail(field, "source-local file or text record IDs are not portable");
        if (slot.type === "File" && !slot.sources && (!slot.from || "param" in slot.from)) {
          const selected = receivedFiles.get(slot.descriptor);
          if (selected) {
            if (
              (slot.from && "param" in slot.from && slot.from.param !== slot.descriptor) ||
              (slot.isBatch ? "FileBatch" : "File") !== selected.type
            )
              return fail(field, "received file selection does not match the declared slot");
            usedFiles.add(selected.descriptor);
            return { ...slot, from: undefined, contents: fileContents(selected) };
          }
        }
        // File expressions/parameters can smuggle a sender's file ID into the local file service.
        // Until artifact provenance is checked at runtime, only typed upstream outputs are accepted.
        if (slot.type === "File" && slot.from && !("node" in slot.from))
          return fail(field, "file inputs must reference an upstream file output");
        return slot;
      }),
    );
  }
  function runtime(
    node: Pick<Extract<Node, { type: "Script" }>, "runtimeProfileId" | "runtimeContractRef">,
    path: string,
  ) {
    if (!environment.sandboxRuntime)
      return fail(path, "sandbox runtime digest required in environment lock");
    const contract =
      node.runtimeContractRef ??
      environment.runtimeBindings?.find((entry) => entry.sourceProfileId === node.runtimeProfileId)
        ?.contract;
    if (!contract)
      return fail(path, "source runtime profile requires an explicit runtime contract binding");
    return contract;
  }
  function localPolicy(node: Node, path: string) {
    if (
      "schedulingStrategy" in node &&
      node.schedulingStrategy &&
      node.schedulingStrategy.type !== "Auto"
    )
      fail(`${path}.schedulingStrategy`, "source queue IDs require receiver policy; use Auto");
    if (node.type !== "Script") return;
    for (const [descriptor, input] of Object.entries(node.inputs)) {
      const slot = node.inputSlots?.find((candidate) => candidate.descriptor === descriptor);
      if (
        (input.type === "File" || input.type === "FileBatch") &&
        slot?.from &&
        !("node" in slot.from) &&
        !(slot.type === "File" && "param" in slot.from && receivedFiles.has(descriptor))
      )
        fail(`${path}.inputs.${descriptor}`, "file inputs must reference an upstream file output");
    }
    for (const [descriptor, declaration] of Object.entries(node.inputs)) {
      const slot = node.inputSlots?.find((slot) => slot.descriptor === descriptor);
      if (
        receivedFiles.has(descriptor) &&
        slot?.type === "File" &&
        declaration.type !== (slot.isBatch ? "FileBatch" : "File")
      )
        fail(`${path}.inputs.${descriptor}`, "file slot differs from the script I/O contract");
    }
    if (node.executionIdentity.type !== "Inherit")
      fail(
        `${path}.executionIdentity`,
        "must inherit the agreement's restricted execution identity",
      );
    if (node.placementConstraint?.clusterIds.length || node.placementConstraint?.siteIds.length)
      fail(`${path}.placementConstraint`, "source-local placement IDs are not portable");
    for (const [name, output] of Object.entries(node.outputs))
      if (output.locality.type === "TargetSite" || output.locality.type === "TargetStorage")
        fail(`${path}.outputs.${name}.locality`, "source-local output destination is not portable");
  }
  async function spec(
    source: workflowDsl.WorkflowSpec,
    path: string,
    depth = 0,
  ): Promise<workflowDsl.WorkflowSpec> {
    if (depth > 32) return fail(path, "workflow nesting exceeds 32 levels");
    const nodes: Node[] = [];
    for (const node of source.nodeDrafts) {
      const field = `${path}.${node.id}`;
      if (++nodeCount > 10000) return fail(field, "workflow exceeds 10000 nodes");
      localPolicy(node, field);
      const base = { ...node, externalId: undefined };
      switch (node.type) {
        case "Federation":
          return fail(field, "Onward federation delegation requires separate authorization");
        case "SoftwareUsecaseComputing": {
          const usecaseRef = binding(
            "usecase",
            node.usecaseVersionId,
            node.usecaseRef,
            `${field}.usecase`,
          );
          const softwareRef = binding(
            "software",
            node.softwareVersionId,
            node.softwareRef,
            `${field}.software`,
          );
          if (
            !environment.software.some(
              (entry) =>
                federationCanonicalJson(entry.asset) === federationCanonicalJson(softwareRef),
            )
          )
            return fail(
              `${field}.software`,
              "software revision is missing from the environment lock",
            );
          const [uc, sw] = await Promise.all([
            software(usecaseRef, field),
            software(softwareRef, field),
          ]);
          if (uc.payload.kind !== "usecase" || sw.payload.kind !== "spack-package")
            return fail(field, "usecase/software asset kind mismatch");
          const pkg = usecase.GovernedUsecasePackageSchema.safeParse(uc.payload.spec);
          if (!pkg.success) return fail(field, "usecase revision must contain a governed package");
          const selectorBinding = inputs.bindings.find(
            (entry) =>
              entry.sourceSelector &&
              federationCanonicalJson(entry.sourceSelector) ===
                federationCanonicalJson(pkg.data.softwareRef) &&
              federationCanonicalJson(entry.asset) === federationCanonicalJson(softwareRef),
          );
          // Without an explicit selector alias, an unchanged public selector must match locally.
          const selector = pkg.data.softwareRef;
          if (
            !selectorBinding &&
            (selector.source !== sw.asset.source ||
              selector.name !== sw.asset.name ||
              selector.version !== sw.asset.version ||
              (selector.providerOrgId ?? null) !== sw.asset.providerOrgId)
          )
            return fail(
              field,
              "usecase software selector does not match its pinned software binding",
            );
          nodes.push(
            workflowDsl.WorkflowNodeSchema.parse({
              ...base,
              usecaseRef: undefined,
              softwareRef: undefined,
              usecaseVersionId: uc.revision.id,
              softwareVersionId: sw.revision.id,
              frozenAssetRevisions: {
                usecase: {
                  assetId: uc.asset.id,
                  revisionId: uc.revision.id,
                  revision: uc.revision.revision,
                },
                software: {
                  assetId: sw.asset.id,
                  revisionId: sw.revision.id,
                  revision: sw.revision.revision,
                },
              },
              inputSlots: await slots(node.inputSlots, field),
            }),
          );
          break;
        }
        case "Script": {
          let source = node.source;
          const contract = runtime(node, `${field}.runtime`);
          if (!source || source.type === "AssetRevision") {
            const ref = binding(
              "script",
              source?.assetRevisionId,
              node.scriptRef,
              `${field}.source`,
            );
            const script = await software(ref, field);
            if (script.payload.kind !== "sandbox-script")
              return fail(field, "expected a script revision");
            if (
              (script.payload.runtimeContractRef || script.payload.runtimeProfileId) &&
              federationCanonicalJson(runtime(script.payload, `${field}.runtime`)) !==
                federationCanonicalJson(contract)
            )
              return fail(
                `${field}.runtime`,
                "runtime contract differs from the pinned script revision",
              );
            if (
              source &&
              (source.sha256 !== script.payload.sha256 ||
                source.assetId !== ref.id ||
                String(source.revision) !== ref.revision)
            )
              return fail(
                `${field}.source`,
                "script source identity or content hash differs from binding",
              );
            source = {
              type: "AssetRevision",
              assetId: script.asset.id,
              assetRevisionId: script.revision.id,
              revision: script.revision.revision,
              sha256: script.payload.sha256,
            };
          }
          nodes.push(
            workflowDsl.WorkflowNodeSchema.parse({
              ...base,
              source,
              scriptRef: undefined,
              runtimeProfileId: undefined,
              runtimeContractRef: contract,
              inputSlots: await slots(node.inputSlots, field),
            }),
          );
          break;
        }
        case "Loop":
          nodes.push({
            ...node,
            externalId: undefined,
            body: await spec(node.body, field, depth + 1),
          });
          break;
        case "SubWorkflow": {
          if (node.ref.kind === "Inline") {
            nodes.push({
              ...node,
              externalId: undefined,
              ref: { kind: "Inline", body: await spec(node.ref.body, field, depth + 1) },
            });
          } else {
            const ref = binding("workflow", node.ref.workflowVersionId, undefined, `${field}.ref`);
            const local = await software(ref, field);
            if (!versions.has(local.revision.id)) pending.set(local.revision.id, local);
            nodes.push({
              ...node,
              externalId: undefined,
              ref: { kind: "ByVersion", workflowVersionId: local.revision.id },
            });
          }
          break;
        }
        case "Milestone":
          return fail(field, "Milestone execution is not supported by the existing executor");
        case "Reduce":
          if (node.reducer.kind === "Command")
            return fail(field, "Command reducer is not supported by the existing executor");
          nodes.push(base);
          break;
        case "NoAction":
          nodes.push({
            ...node,
            externalId: undefined,
            inputSlots: await slots(node.inputSlots, field),
          });
          break;
        default:
          nodes.push(base);
      }
    }
    return { ...source, nodeDrafts: nodes };
  }

  const root = await software(input.template, "template");
  let workflow: workflowDsl.Workflow;
  if (input.template.kind === "workflow") {
    workflow = readWorkflow(root, "template");
  } else if (input.template.kind === "script" && root.payload.kind === "sandbox-script") {
    const payload = root.payload;
    const contract = runtime(payload, "template.runtime");
    const inputSlots = Object.entries(payload.inputs).map(([descriptor, value]) => {
      if (value.type === "File" || value.type === "FileBatch") {
        const selected = receivedFiles.get(descriptor);
        if (!selected) {
          if (value.required)
            return fail(`template.inputs.${descriptor}`, "received file input required");
          return null;
        }
        if (selected.type !== value.type)
          return fail(
            `template.inputs.${descriptor}`,
            "received file type differs from script I/O contract",
          );
        usedFiles.add(descriptor);
        return {
          type: "File",
          descriptor,
          isBatch: value.type === "FileBatch",
          contents: fileContents(selected),
          optional: !value.required,
        };
      }
      return { type: "Text", descriptor, from: { param: descriptor }, optional: !value.required };
    });
    const wrapped = workflowDsl.WorkflowSchema.safeParse({
      name: root.asset.name,
      parameters: Object.entries(payload.inputs)
        .filter(([, value]) => value.type !== "File" && value.type !== "FileBatch")
        .map(([name, value]) => ({
          name,
          type: value.type === "JSON" ? "json" : "string",
          required: value.required,
        })),
      spec: {
        nodeDrafts: [
          {
            id: "script",
            name: root.asset.name,
            type: "Script",
            source: {
              type: "AssetRevision",
              assetId: root.asset.id,
              assetRevisionId: root.revision.id,
              revision: root.revision.revision,
              sha256: payload.sha256,
            },
            runtimeContractRef: contract,
            executionIdentity: payload.executionIdentity,
            inputs: payload.inputs,
            outputs: payload.outputs,
            inputSlots: inputSlots.filter((slot) => slot !== null),
          },
        ],
      },
    });
    if (!wrapped.success)
      return fail(
        "template.inputs",
        "script inputs must have CEL-safe names and valid declarations",
      );
    workflow = wrapped.data;
    // The root is already resolved; only nested template references need source-ID conversion.
    for (const node of workflow.spec.nodeDrafts) localPolicy(node, "template.script");
  } else return fail("template", "only workflows and scripts are executable templates");

  for (const name of Object.keys(inputs.parameters))
    if (!workflow.parameters.some((parameter) => parameter.name === name))
      return fail(`parameters.${name}`, "undeclared parameter");
  workflow.parameters = workflow.parameters.map((parameter) => {
    const received = receivedFiles.get(parameter.name);
    if (received && Object.hasOwn(inputs.parameters, parameter.name))
      return fail(`parameters.${parameter.name}`, "file input cannot also be a scalar override");
    const value = received
      ? received.type === "File"
        ? fileContents(received)[0]
        : fileContents(received)
      : Object.hasOwn(inputs.parameters, parameter.name)
        ? inputs.parameters[parameter.name]
        : parameter.default;
    if (value === undefined && parameter.required)
      return fail(`parameters.${parameter.name}`, "required parameter missing");
    if (value !== undefined && !parameterMatches(parameter.type, value))
      return fail(`parameters.${parameter.name}`, "parameter type mismatch");
    return { ...parameter, ...(value === undefined ? {} : { default: value }) };
  });
  if (input.template.kind === "workflow") {
    // Mark before traversing so self-recursive versions remain bounded by engine maxDepth.
    versions.set(root.revision.id, workflow);
    workflow = { ...workflow, id: root.revision.id, spec: await spec(workflow.spec, "spec") };
    versions.set(root.revision.id, workflow);
  }
  for (const [id, local] of pending) {
    if (versions.has(id)) continue;
    const child = readWorkflow(local, `versions.${id}`);
    versions.set(id, child);
    versions.set(id, { ...child, id, spec: await spec(child.spec, `versions.${id}.spec`) });
  }
  for (const selected of inputs.datasets)
    if (!usedDatasets.has(selected.descriptor))
      return fail(
        `datasets.${selected.descriptor}`,
        "dataset is not consumed by any template slot",
      );
  for (const descriptor of receivedFiles.keys())
    if (!usedFiles.has(descriptor))
      return fail(`files.${descriptor}`, "received input is not consumed by a declared file slot");
  const errors = workflowDsl.validateWorkflow(workflow);
  if (errors.length) return fail("template", "materialized workflow failed static validation");
  return { workflow, workflowVersions: Object.fromEntries(versions) };
}

function parameterMatches(type: workflowDsl.ValueType, value: unknown): boolean {
  if (typeof type === "object") {
    if ("list" in type)
      return Array.isArray(value) && value.every((item) => parameterMatches(type.list, item));
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((item) => parameterMatches(type.map, item))
    );
  }
  switch (type) {
    case "int":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "double":
      return typeof value === "number" && Number.isFinite(value);
    case "bool":
      return typeof value === "boolean";
    case "json":
      return true;
    default:
      return typeof value === "string";
  }
}
