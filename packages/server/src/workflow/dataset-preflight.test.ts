import { describe, expect, test } from "bun:test";
import { AppError, ErrorCode, usecase, workflowDsl } from "@kuintessence/shared";
import { createDatasetPreflight, type DatasetPreflightDeps } from "./dataset-preflight";

const USECASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOFTWARE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKFLOW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const dataset = {
  source: "data-market" as const,
  assetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  versionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  manifestDigest: "sha256:dataset",
  selectedEntries: ["train.csv"],
};

function pkg() {
  return usecase.GovernedUsecasePackageSchema.parse({
    usecase: { commandFile: "train", inputSlots: [] },
    software: { kind: "Bare" },
    arguments: [],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
    description: "Dataset training",
    domain: "ML",
    tags: [],
    citations: [],
    softwareRef: { source: "official-upstream", name: "trainer", version: "1.0" },
    inputs: [{ descriptor: "trainingData", type: "Dataset" }],
    outputs: [],
    resources: {},
    materialMappings: [],
    dataRequirements: [],
    licensedMaterials: [],
    licenseRequirements: [],
  });
}

function ungovernedPkg() {
  return usecase.MaterializationPackageSchema.parse({
    usecase: { commandFile: "echo", inputSlots: [] },
    software: { kind: "Bare" },
    arguments: [],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
  });
}

function leaf(
  id: string,
  contents: typeof dataset | undefined = dataset,
): Extract<workflowDsl.WorkflowNode, { type: "SoftwareUsecaseComputing" }> {
  const node = workflowDsl.WorkflowNodeSchema.parse({
    type: "SoftwareUsecaseComputing",
    id,
    name: id,
    usecaseVersionId: USECASE_ID,
    softwareVersionId: SOFTWARE_ID,
    inputSlots: [
      ...(contents
        ? [{ type: "Dataset", descriptor: "trainingData", optional: false, contents }]
        : []),
    ],
  });
  if (node.type !== "SoftwareUsecaseComputing") {
    throw new Error("Dataset preflight leaf must be a software usecase node");
  }
  return node;
}

function workflow(nodeDrafts: workflowDsl.WorkflowNode[]): workflowDsl.Workflow {
  return {
    name: "dataset-preflight",
    parameters: [],
    spec: { nodeDrafts, nodeRelations: [] },
  };
}

function deps(overrides: Partial<DatasetPreflightDeps> = {}): DatasetPreflightDeps {
  return {
    loadUsecasePackage: async () => pkg(),
    assertUsecaseExecutionAccess: async () => {},
    resolveWorkflowVersion: async () => null,
    verifyAccess: async () => true,
    validateUsecase: async () => {},
    ...overrides,
  };
}

const principal = { userId: "ffffffff-ffff-4fff-8fff-ffffffffffff", orgId: null };

describe("Dataset workflow preflight", () => {
  test("validates top-level Dataset slots after checking actor access", async () => {
    const accessCalls: Array<Parameters<DatasetPreflightDeps["verifyAccess"]>[0]> = [];
    const usecaseAccessCalls: Array<
      Parameters<DatasetPreflightDeps["assertUsecaseExecutionAccess"]>[0]
    > = [];
    const validations: Record<string, unknown>[] = [];
    const validate = createDatasetPreflight(
      deps({
        verifyAccess: async (input) => {
          accessCalls.push(input);
          return true;
        },
        assertUsecaseExecutionAccess: async (input) => {
          usecaseAccessCalls.push(input);
        },
        validateUsecase: async (input) => {
          validations.push(input.dataInputs);
        },
      }),
    );

    await validate(workflow([leaf("top")]), principal);

    expect(accessCalls).toHaveLength(1);
    expect(usecaseAccessCalls).toEqual([
      { usecaseVersionId: USECASE_ID, requester: { userId: principal.userId, orgId: null } },
    ]);
    expect(validations).toEqual([{ trainingData: dataset }]);
  });

  test("recurses through Loop and Inline SubWorkflow nodes", async () => {
    const validatedNodes: string[] = [];
    const validate = createDatasetPreflight(
      deps({
        validateUsecase: async (input) => {
          validatedNodes.push(Object.keys(input.dataInputs)[0] ?? "missing");
        },
      }),
    );
    const nested = workflow([
      {
        type: "Loop",
        id: "loop",
        name: "loop",
        mode: "ForEach",
        maxIterations: 1,
        over: { expr: "[]", lang: "cel" },
        body: { nodeDrafts: [leaf("loop_leaf")], nodeRelations: [] },
      },
      {
        type: "SubWorkflow",
        id: "inline",
        name: "inline",
        maxDepth: 1,
        ref: { kind: "Inline", body: { nodeDrafts: [leaf("inline_leaf")], nodeRelations: [] } },
      },
    ]);

    await validate(nested, principal);

    expect(validatedNodes).toEqual(["trainingData", "trainingData"]);
  });

  test("recurses through ByVersion once and breaks cycles", async () => {
    const resolved: string[] = [];
    let validations = 0;
    const validate = createDatasetPreflight(
      deps({
        resolveWorkflowVersion: async (id) => {
          resolved.push(id);
          return workflow([
            leaf("referenced"),
            {
              type: "SubWorkflow",
              id: "cycle",
              name: "cycle",
              maxDepth: 1,
              ref: { kind: "ByVersion", workflowVersionId: WORKFLOW_ID },
            },
          ]);
        },
        validateUsecase: async () => {
          validations += 1;
        },
      }),
    );

    await validate(
      workflow([
        {
          type: "SubWorkflow",
          id: "by-version",
          name: "by-version",
          maxDepth: 1,
          ref: { kind: "ByVersion", workflowVersionId: WORKFLOW_ID },
        },
      ]),
      principal,
    );

    expect(resolved).toEqual([WORKFLOW_ID]);
    expect(validations).toBe(1);
  });

  test("surfaces missing required Datasets from the selection validator", async () => {
    const validate = createDatasetPreflight(
      deps({
        validateUsecase: async () => {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "DATASET_INPUT_REQUIRED: trainingData",
            422,
          );
        },
      }),
    );

    await expect(validate(workflow([leaf("missing", undefined)]), principal)).rejects.toThrow(
      "DATASET_INPUT_REQUIRED: trainingData",
    );
  });

  test("rejects revoked or forged Dataset references before selection validation", async () => {
    let validated = false;
    const validate = createDatasetPreflight(
      deps({
        verifyAccess: async () => false,
        validateUsecase: async () => {
          validated = true;
        },
      }),
    );

    await expect(validate(workflow([leaf("forged")]), principal)).rejects.toMatchObject({
      statusCode: 403,
      message: "Not authorized to use the selected Data Market version",
    });
    expect(validated).toBe(false);
  });

  test("rejects ungoverned usecase packages before creating a run", async () => {
    const validate = createDatasetPreflight(
      deps({
        loadUsecasePackage: async () => ungovernedPkg(),
      }),
    );

    await expect(validate(workflow([leaf("ungoverned", undefined)]), principal)).rejects.toThrow(
      "Workflow execution requires a governed usecase package with a software selector",
    );
  });
});
