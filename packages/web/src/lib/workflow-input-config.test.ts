import { describe, expect, test } from "vitest";
import {
  applyWorkflowInputConfiguration,
  extractWorkflowInputModel,
  resolveWorkflowDatasetBinding,
  resolveWorkflowInputModel,
  sameWorkflowDatasetInput,
  smartMatchWorkflowFiles,
  type WorkflowDatasetCandidate,
  type WorkflowFileCandidate,
} from "./workflow-input-config";
import { yamlToGraph } from "./yaml-graph-sync";

const SCRIPT_WORKFLOW = `name: transform
parameters:
  - name: threshold
    type: double
    required: true
spec:
  nodeDrafts:
    - type: Script
      id: convert
      name: 轨迹转换
      source:
        type: AssetRevision
        assetId: 3f2504e0-4f89-41d3-9a0c-0305e82c3302
        revision: 2
        sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      runtimeProfileId: 3f2504e0-4f89-41d3-9a0c-0305e82c3303
      executionIdentity:
        type: MappedAuto
      inputs:
        trajectory:
          type: File
          required: true
        options:
          type: JSON
          required: true
      outputs: {}
      inputSlots:
        - descriptor: trajectory
          type: File
          optional: false
          isBatch: false
          expectedFileName: traj.xtc
        - descriptor: options
          type: Text
          optional: false
  nodeRelations: []
`;

const TRAJECTORY: WorkflowFileCandidate = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3304",
  name: "traj.xtc",
  path: "project/轨迹转换/traj.xtc",
  size: 1024,
  sha256: "b".repeat(64),
  source: "cloud",
};

const DATASET: WorkflowDatasetCandidate = {
  assetId: "3f2504e0-4f89-41d3-9a0c-0305e82c3310",
  manifestDigest: "sha256:trajectory",
  selectedEntries: [],
  source: "data-market",
  versionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3311",
};

const DATASET_WORKFLOW = `name: dataset-workflow
parameters: []
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: preprocess
      name: Trajectory preprocessing
      usecaseVersionId: 3f2504e0-4f89-41d3-9a0c-0305e82c3312
      softwareVersionId: 3f2504e0-4f89-41d3-9a0c-0305e82c3313
      inputSlots:
        - descriptor: trajectory
          type: Dataset
          optional: false
          contents: null
    - type: SoftwareUsecaseComputing
      id: analyze
      name: Trajectory analysis
      usecaseVersionId: 3f2504e0-4f89-41d3-9a0c-0305e82c3314
      softwareVersionId: 3f2504e0-4f89-41d3-9a0c-0305e82c3315
      inputSlots:
        - descriptor: trajectory
          type: Dataset
          optional: false
          contents: null
  nodeRelations: []
`;

const VERSION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3320";
const BY_VERSION_WORKFLOW = `name: parent
parameters: []
spec:
  nodeDrafts:
    - type: SubWorkflow
      id: external
      name: External workflow
      maxDepth: 2
      ref:
        kind: ByVersion
        workflowVersionId: ${VERSION_ID}
  nodeRelations: []
`;

describe("workflow input configuration", () => {
  test("collects workflow parameters and unbound script inputs", () => {
    const model = extractWorkflowInputModel(SCRIPT_WORKFLOW);

    expect(model.values.map((value) => value.key)).toEqual([
      "param:threshold",
      "slot:convert:options",
    ]);
    expect(model.files).toHaveLength(1);
    expect(model.files[0]?.expectedFileName).toBe("traj.xtc");
  });

  test("smart matching uses task directory and expected filename", () => {
    const model = extractWorkflowInputModel(SCRIPT_WORKFLOW);
    const bindings = smartMatchWorkflowFiles(model.files, [TRAJECTORY], {});

    expect(bindings["slot:convert:trajectory"]?.[0]?.id).toBe(TRAJECTORY.id);
  });

  test("writes parameter defaults, text bindings, and file metadata back to YAML", () => {
    const model = extractWorkflowInputModel(SCRIPT_WORKFLOW);
    const yaml = applyWorkflowInputConfiguration(
      SCRIPT_WORKFLOW,
      model,
      {
        "param:threshold": "0.75",
        "slot:convert:options": '{"stride": 10}',
      },
      { "slot:convert:trajectory": [TRAJECTORY] },
    );
    const parsed = yamlToGraph(yaml);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.graph.header.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "threshold", default: 0.75 }),
        expect.objectContaining({ name: "convert_options", default: { stride: 10 } }),
      ]),
    );
    const script = parsed.graph.nodes[0]?.data.raw;
    expect(script?.type).toBe("Script");
    if (script?.type !== "Script") return;
    const fileSlot = script.inputSlots?.find((slot) => slot.descriptor === "trajectory");
    const textSlot = script.inputSlots?.find((slot) => slot.descriptor === "options");
    expect(fileSlot?.type === "File" ? fileSlot.contents?.[0]?.fileMetadataId : null).toBe(
      TRAJECTORY.id,
    );
    expect(textSlot?.type === "Text" ? textSlot.from : null).toEqual({
      param: "convert_options",
    });
  });

  test("omits file inputs already supplied by a slot relation", () => {
    const connected = SCRIPT_WORKFLOW.replace(
      "  nodeRelations: []",
      `    - type: NoAction
      id: producer
      name: 上游结果
      outputSlots:
        - descriptor: trajectory
          type: File
          optional: false
          origin: CollectedOut
          isBatch: false
  nodeRelations:
    - fromId: producer
      toId: convert
      slotRelations:
        - fromSlot: trajectory
          toSlot: trajectory
          transferStrategy:
            type: Network`,
    );

    const model = extractWorkflowInputModel(connected);

    expect(model.files).toHaveLength(0);
  });

  test("uses slot metadata for parameter-bound text inputs", () => {
    const configured = SCRIPT_WORKFLOW.replace(
      "          optional: false\n  nodeRelations: []",
      `          optional: false
          description: JSON options for trajectory conversion
          from:
            param: convert_options
  nodeRelations: []`,
    ).replace(
      "parameters:\n  - name: threshold",
      "parameters:\n  - name: convert_options\n    type: json\n    required: true\n  - name: threshold",
    );

    const model = extractWorkflowInputModel(configured);
    const options = model.values.find((requirement) => requirement.name === "convert_options");

    expect(options?.key).toBe("param:convert_options");
    expect(options?.label).toBe("轨迹转换 / options");
    expect(options?.description).toBe("JSON options for trajectory conversion");
  });

  test("keeps Dataset bindings distinct by node and writes immutable references into YAML", () => {
    const model = extractWorkflowInputModel(DATASET_WORKFLOW);

    expect(model.datasets.map((requirement) => requirement.key)).toEqual([
      "dataset:preprocess:trajectory",
      "dataset:analyze:trajectory",
    ]);
    expect(model.datasets[0]).toMatchObject({
      descriptor: "trajectory",
      nodeName: "Trajectory preprocessing",
      usecaseVersionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3312",
    });

    const yaml = applyWorkflowInputConfiguration(
      DATASET_WORKFLOW,
      model,
      {},
      {},
      { "dataset:preprocess:trajectory": DATASET },
    );
    const parsed = yamlToGraph(yaml);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const preprocess = parsed.graph.nodes.find((node) => node.id === "preprocess")?.data.raw;
    const analyze = parsed.graph.nodes.find((node) => node.id === "analyze")?.data.raw;
    const preprocessSlot =
      preprocess && "inputSlots" in preprocess
        ? preprocess.inputSlots?.find((slot) => slot.descriptor === "trajectory")
        : undefined;
    const analyzeSlot =
      analyze && "inputSlots" in analyze
        ? analyze.inputSlots?.find((slot) => slot.descriptor === "trajectory")
        : undefined;
    expect(preprocessSlot?.type === "Dataset" ? preprocessSlot.contents : null).toEqual(DATASET);
    expect(analyzeSlot?.type === "Dataset" ? analyzeSlot.contents : null).toBeNull();
  });

  test("keeps an explicit Dataset clear instead of restoring the YAML fallback", () => {
    expect(resolveWorkflowDatasetBinding({ dataset: null }, "dataset", DATASET)).toBeNull();
  });

  test("compares the complete immutable Dataset reference during verification", () => {
    expect(sameWorkflowDatasetInput(DATASET, { ...DATASET })).toBe(true);
    expect(
      sameWorkflowDatasetInput(DATASET, { ...DATASET, manifestDigest: "sha256:replacement" }),
    ).toBe(false);
    expect(
      sameWorkflowDatasetInput(DATASET, {
        ...DATASET,
        selectedEntries: ["trajectory/frame-001.xtc"],
      }),
    ).toBe(false);
    expect(sameWorkflowDatasetInput(DATASET, { ...DATASET, targetPath: "inputs/data" })).toBe(
      false,
    );
  });

  test("preserves a frozen Dataset when the binding map has not initialized its key", () => {
    const frozen = DATASET_WORKFLOW.replaceAll(
      "contents: null",
      `contents:\n            source: data-market\n            assetId: ${DATASET.assetId}\n            versionId: ${DATASET.versionId}\n            manifestDigest: ${DATASET.manifestDigest}\n            selectedEntries: []`,
    );
    const model = extractWorkflowInputModel(frozen);
    const yaml = applyWorkflowInputConfiguration(frozen, model, {}, {}, {});
    const restored = extractWorkflowInputModel(yaml);

    expect(restored.datasets[0]?.bound).toEqual(DATASET);
  });

  test("does not expose Inline SubWorkflow Text slots as runnable parent parameters", () => {
    const inline = `name: inline-text
parameters: []
spec:
  nodeDrafts:
    - type: SubWorkflow
      id: child
      name: Child workflow
      maxDepth: 1
      ref:
        kind: Inline
        body:
          nodeDrafts:
            - type: NoAction
              id: consume
              name: Consume
              inputSlots:
                - type: Text
                  descriptor: threshold
                  optional: false
          nodeRelations: []
  nodeRelations: []
`;

    expect(extractWorkflowInputModel(inline).values).toEqual([]);
  });

  test("extracts and writes Dataset bindings inside Loop and Inline SubWorkflow scopes", () => {
    const nested = `name: nested-dataset
parameters: []
spec:
  nodeDrafts:
    - type: Loop
      id: sweep
      name: Parameter sweep
      mode: ForEach
      maxIterations: 2
      over:
        expr: "[1]"
        lang: cel
      body:
        nodeDrafts:
          - type: SoftwareUsecaseComputing
            id: preprocess
            name: Trajectory preprocessing
            usecaseVersionId: 3f2504e0-4f89-41d3-9a0c-0305e82c3312
            softwareVersionId: 3f2504e0-4f89-41d3-9a0c-0305e82c3313
            inputSlots:
              - descriptor: trajectory
                type: Dataset
                optional: false
                contents: null
        nodeRelations: []
  nodeRelations: []
`;
    const model = extractWorkflowInputModel(nested);

    expect(model.datasets.map((requirement) => requirement.key)).toContain(
      "dataset:sweep/preprocess:trajectory",
    );
    expect(model.datasets.find((item) => item.nodeId === "sweep/preprocess")?.nodeName).toBe(
      "Parameter sweep / Trajectory preprocessing",
    );

    const yaml = applyWorkflowInputConfiguration(
      nested,
      model,
      {},
      {},
      {
        "dataset:sweep/preprocess:trajectory": DATASET,
      },
    );
    const parsed = yamlToGraph(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const loop = parsed.graph.nodes.find((node) => node.id === "sweep")?.data.raw;
    expect(loop?.type).toBe("Loop");
    if (loop?.type !== "Loop") return;
    const leaf = loop.body.nodeDrafts[0];
    const slot =
      leaf && "inputSlots" in leaf
        ? leaf.inputSlots?.find((item) => item.descriptor === "trajectory")
        : undefined;
    expect(slot?.type === "Dataset" ? slot.contents : null).toEqual(DATASET);
  });

  test("allows a ByVersion subworkflow whose Dataset binding is already frozen", async () => {
    const frozen = DATASET_WORKFLOW.replaceAll(
      "contents: null",
      `contents:\n            source: data-market\n            assetId: ${DATASET.assetId}\n            versionId: ${DATASET.versionId}\n            manifestDigest: ${DATASET.manifestDigest}\n            selectedEntries: []`,
    );
    const model = await resolveWorkflowInputModel(BY_VERSION_WORKFLOW, async (id) => {
      expect(id).toBe(VERSION_ID);
      return { yamlContent: frozen };
    });

    expect(model.datasets).toEqual([]);
    expect(model.unresolvedSubworkflowRefs).toEqual([]);
  });

  test("blocks an immutable ByVersion subworkflow with an unbound required Dataset", async () => {
    const model = await resolveWorkflowInputModel(BY_VERSION_WORKFLOW, async () => ({
      yamlContent: DATASET_WORKFLOW,
    }));

    expect(model.datasets).toEqual([]);
    expect(model.unresolvedSubworkflowRefs).toEqual([
      { reason: "unbound-dataset", workflowVersionId: VERSION_ID },
    ]);
  });

  test("treats an omitted required Dataset contents field in a ByVersion workflow as unbound", async () => {
    const omittedContents = DATASET_WORKFLOW.replace("          contents: null\n", "");
    const model = await resolveWorkflowInputModel(BY_VERSION_WORKFLOW, async () => ({
      yamlContent: omittedContents,
    }));

    expect(model.unresolvedSubworkflowRefs).toEqual([
      { reason: "unbound-dataset", workflowVersionId: VERSION_ID },
    ]);
  });

  test("distinguishes an unreadable ByVersion workflow version from invalid YAML", async () => {
    const unavailable = await resolveWorkflowInputModel(BY_VERSION_WORKFLOW, async () => {
      throw new Error("registry unavailable");
    });
    const invalid = await resolveWorkflowInputModel(BY_VERSION_WORKFLOW, async () => ({
      yamlContent: "name: [",
    }));

    expect(unavailable.unresolvedSubworkflowRefs).toEqual([
      { reason: "unavailable", workflowVersionId: VERSION_ID },
    ]);
    expect(invalid.unresolvedSubworkflowRefs).toEqual([
      { reason: "invalid", workflowVersionId: VERSION_ID },
    ]);
  });

  test("deduplicates ByVersion fetches and blocks reference cycles", async () => {
    const nested = BY_VERSION_WORKFLOW.replace("name: parent", "name: child");
    const duplicated = BY_VERSION_WORKFLOW.replace(
      "  nodeRelations: []",
      `    - type: SubWorkflow
      id: duplicate
      name: Duplicate reference
      maxDepth: 2
      ref:
        kind: ByVersion
        workflowVersionId: ${VERSION_ID}
  nodeRelations: []`,
    );
    let calls = 0;
    const model = await resolveWorkflowInputModel(duplicated, async () => {
      calls += 1;
      return { yamlContent: nested };
    });

    expect(calls).toBe(1);
    expect(model.unresolvedSubworkflowRefs).toEqual([
      { reason: "cycle", workflowVersionId: VERSION_ID },
    ]);
  });
});
