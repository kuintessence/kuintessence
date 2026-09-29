import { describe, expect, test } from "bun:test";
import * as workflowDsl from "../workflow-dsl";
import { REQUIRED_COLLECTED_OUTPUTS_KEY, runWorkflow } from "./engine";
import { SPACK_EXECUTION_PLACEHOLDER } from "./spack-execution";
import {
  createUsecaseExecutor,
  type JobSubmission,
  type UsecaseExecutorDeps,
} from "./usecase-executor";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USECASE_PACKAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const node = workflowDsl.WorkflowNodeSchema.parse({
  type: "SoftwareUsecaseComputing",
  id: "solve",
  name: "solve",
  usecaseVersionId: UUID,
  softwareVersionId: UUID,
  inputSlots: [{ type: "Text", descriptor: "endTime", from: { expr: "params.endTime" } }],
});

const deps = (capture: { spec?: JobSubmission }): UsecaseExecutorDeps => ({
  resolvePackage: async () => ({
    usecasePackageId: USECASE_PACKAGE_ID,
    usecase: {
      commandFile: "simpleFoam",
      inputSlots: [
        {
          kind: "Text",
          descriptor: "endTime",
          refMaterials: [{ kind: "ArgRef", descriptor: "endTime", sort: 0 }],
        },
      ],
    },
    software: { kind: "Spack", name: "openfoam", argumentList: [] },
    arguments: [{ descriptor: "endTime", valueFormat: "-endTime {}" }],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [
      {
        descriptor: "residual",
        type: "double",
        from: { collectedOutDescriptor: "log" },
        extract: { kind: "Regex", pattern: "residual = ([0-9.eE+-]+)", group: 1 },
      },
    ],
  }),
  submitJob: async (spec) => {
    capture.spec = spec;
    return { jobId: "j1", status: "completed", collected: { log: "final residual = 0.001\n" } };
  },
});

describe("createUsecaseExecutor", () => {
  test("fails closed when named asset references were not frozen before execution", async () => {
    const executor = createUsecaseExecutor(deps({}));

    await expect(
      executor(
        {
          type: "SoftwareUsecaseComputing",
          id: "named-ref",
          name: "Named reference",
          usecaseRef: {
            source: "platform-fork",
            name: "gromacs.mdrun",
            version: "1.0.0",
          },
          softwareRef: {
            source: "platform-fork",
            name: "gromacs",
            version: "2025.2",
          },
        },
        {},
      ),
    ).rejects.toThrow("must resolve named asset references before execution");
  });

  test("materializes the command from the resolved package and bound slot value", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    await exec(node, { params: { endTime: "500" }, nodes: {} });
    expect(capture.spec?.nodeId).toBe("solve");
    expect(capture.spec?.usecasePackageId).toBe(USECASE_PACKAGE_ID);
    expect(capture.spec?.command).toBe(
      'eval "$(spack load --sh openfoam)" && simpleFoam -endTime 500',
    );
    expect(capture.spec?.envVars).toEqual({});
  });

  test("carries the frozen Spack requirement into JobSubmission", async () => {
    const capture: { spec?: JobSubmission } = {};
    const base = deps(capture);
    const exec = createUsecaseExecutor({
      ...base,
      resolvePackage: async () => ({
        ...(await base.resolvePackage(UUID, UUID)),
        softwareRequirements: [{ name: "vasp", version: "6.5.1", installable: false }],
      }),
    });
    await exec(node, { params: { endTime: "500" }, nodes: {} });
    expect(capture.spec?.softwareRequirements).toEqual([
      { name: "vasp", version: "6.5.1", installable: false },
    ]);
  });

  test("defers production activation with the full spec and a Bare-materialized command", async () => {
    const capture: { spec?: JobSubmission } = {};
    const base = deps(capture);
    const exec = createUsecaseExecutor({
      ...base,
      deferSpackActivation: true,
      resolvePackage: async () => ({
        ...(await base.resolvePackage(UUID, UUID)),
        software: {
          kind: "Spack",
          name: "openfoam@2406",
          argumentList: ["+mpi", "%gcc@13"],
        },
      }),
    });

    await exec(node, { params: { endTime: "500; echo unsafe" }, nodes: {} });

    expect(capture.spec?.command).toBe(SPACK_EXECUTION_PLACEHOLDER);
    expect(capture.spec?.command).not.toContain("simpleFoam");
    expect(capture.spec?.spackExecution).toEqual({
      spec: "openfoam@2406 +mpi %gcc@13",
      command: "simpleFoam -endTime '500; echo unsafe'",
    });
  });

  test("production deferral leaves other facilities unchanged", async () => {
    for (const software of [
      { kind: "Bare" as const },
      { kind: "Singularity" as const, image: "solver", tag: "1" },
    ]) {
      const capture: { spec?: JobSubmission } = {};
      const base = deps(capture);
      const exec = createUsecaseExecutor({
        ...base,
        deferSpackActivation: true,
        resolvePackage: async () => ({
          ...(await base.resolvePackage(UUID, UUID)),
          software,
        }),
      });
      await exec(node, { params: { endTime: "500" }, nodes: {} });
      expect(capture.spec?.spackExecution).toBeUndefined();
      expect(capture.spec?.command).toBe(
        software.kind === "Bare"
          ? "simpleFoam -endTime 500"
          : "apptainer exec solver:1 simpleFoam -endTime 500",
      );
    }
  });

  test("forwards node-level Dataset bindings to the submitted job without materializing them", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    const dataset = {
      source: "data-market" as const,
      assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      versionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      selectedEntries: ["mesh/cavity.msh"],
      targetPath: "inputs/mesh",
    };
    const withDataset = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [
        { type: "Text", descriptor: "endTime", from: { expr: "params.endTime" } },
        { type: "Dataset", descriptor: "mesh", contents: dataset },
      ],
    });

    await exec(withDataset, { params: { endTime: "500" }, nodes: {} });

    expect(capture.spec?.dataInputs).toEqual({ mesh: dataset });
    expect(capture.spec?.inputStaging).toEqual([]);
    expect(capture.spec?.command).toBe(
      'eval "$(spack load --sh openfoam)" && simpleFoam -endTime 500',
    );
  });

  test("extracts typed values from the collected output", async () => {
    const exec = createUsecaseExecutor(deps({}));
    const res = await exec(node, { params: { endTime: "500" }, nodes: {} });
    expect(res.status).toBe("Succeeded");
    expect(res.values?.residual).toBe(0.001);
  });

  test("maps node.requirements (cpuCores / maxWallTime) into the job resources", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    const withReqs = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      requirements: { cpuCores: 8, maxWallTime: 3600 },
      inputSlots: [{ type: "Text", descriptor: "endTime", from: { expr: "params.endTime" } }],
    });
    await exec(withReqs, { params: { endTime: "500" }, nodes: {} });
    expect(capture.spec?.resources).toEqual({ cpus: 8, wallTimeSec: 3600 });
  });

  test("maps a Manual schedulingStrategy queue into the submitted job", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    const queueId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const withQueue = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      schedulingStrategy: { type: "Manual", queues: [queueId] },
      inputSlots: [{ type: "Text", descriptor: "endTime", from: { expr: "params.endTime" } }],
    });

    await exec(withQueue, { params: { endTime: "500" }, nodes: {} });

    expect(
      (capture.spec as { schedulingStrategy?: { queueId?: string } } | undefined)
        ?.schedulingStrategy,
    ).toEqual({
      queueId,
    });
  });

  test("maps a Prefer schedulingStrategy queue list into the submitted job", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    const firstQueueId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const secondQueueId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const withPreferredQueues = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      schedulingStrategy: { type: "Prefer", queues: [firstQueueId, secondQueueId] },
      inputSlots: [{ type: "Text", descriptor: "endTime", from: { expr: "params.endTime" } }],
    });

    await exec(withPreferredQueues, { params: { endTime: "500" }, nodes: {} });

    expect(capture.spec?.schedulingStrategy).toEqual({
      preferredQueueIds: [firstQueueId, secondQueueId],
    });
  });

  test("passes a materialized StdinRef text value to the submitted job", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor({
      resolvePackage: async () => ({
        usecase: {
          commandFile: "cat",
          inputSlots: [
            {
              kind: "Text",
              descriptor: "stdin",
              refMaterials: [{ kind: "StdinRef", descriptor: "stdin" }],
            },
          ],
        },
        software: { kind: "Bare" },
        arguments: [],
        environments: [],
        filesomeInputs: [],
        filesomeOutputs: [],
        valueOutputs: [],
      }),
      submitJob: async (spec) => {
        capture.spec = spec;
        return { jobId: "j-stdin", status: "completed", collected: {} };
      },
    });
    const stdinNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "sum",
      name: "sum",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [{ type: "Text", descriptor: "stdin", from: { expr: "params.stdin" } }],
    });

    await exec(stdinNode, { params: { stdin: "1\n2\n3\n" }, nodes: {} });

    expect(capture.spec?.stdinText).toBe("1\n2\n3\n");
  });

  test("resolves a FirstAvailable input from consumer-side sources", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    const selectNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [
        {
          type: "Text",
          descriptor: "endTime",
          sources: [
            { node: "small", output: "endTime" },
            { node: "large", output: "endTime" },
          ],
          select: "FirstAvailable",
        },
      ],
    });

    await exec(selectNode, {
      params: {},
      nodes: {
        small: { status: "Skipped", values: { endTime: "100" } },
        large: { status: "Succeeded", values: { endTime: "750" } },
      },
    });

    expect(capture.spec?.command).toBe(
      'eval "$(spack load --sh openfoam)" && simpleFoam -endTime 750',
    );
  });

  test("ignores failed nodes when resolving consumer-side sources", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    const selectNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [
        {
          type: "Text",
          descriptor: "endTime",
          sources: [
            { node: "failed", output: "endTime" },
            { node: "good", output: "endTime" },
          ],
          select: "FirstAvailable",
        },
      ],
    });

    await exec(selectNode, {
      params: {},
      nodes: {
        failed: { status: "Failed", values: { endTime: "100" } },
        good: { status: "Succeeded", values: { endTime: "750" } },
      },
    });

    expect(capture.spec?.command).toBe(
      'eval "$(spack load --sh openfoam)" && simpleFoam -endTime 750',
    );
  });

  test("resolves an expression select input by source index", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    const selectNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [
        {
          type: "Text",
          descriptor: "endTime",
          sources: [
            { node: "small", output: "endTime" },
            { node: "large", output: "endTime" },
          ],
          select: { expr: "1" },
        },
      ],
    });

    await exec(selectNode, {
      params: {},
      nodes: {
        small: { status: "Succeeded", values: { endTime: "100" } },
        large: { status: "Succeeded", values: { endTime: "750" } },
      },
    });

    expect(capture.spec?.command).toBe(
      'eval "$(spack load --sh openfoam)" && simpleFoam -endTime 750',
    );
  });

  test("does not stringify an absent direct binding as an input value", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    const optionalNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [
        {
          type: "Text",
          descriptor: "endTime",
          from: { node: "producer", output: "endTime" },
          optional: true,
        },
      ],
    });

    await expect(
      exec(optionalNode, {
        params: {},
        nodes: { producer: { status: "Succeeded", values: {} } },
      }),
    ).rejects.toThrow('materialize: input "endTime" expected a text value');
    expect(capture.spec).toBeUndefined();
  });

  test("does not stringify structured values into Text inputs", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    const textNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [
        {
          type: "Text",
          descriptor: "endTime",
          from: { node: "producer", output: "archive" },
        },
      ],
    });

    await expect(
      exec(textNode, {
        params: {},
        nodes: {
          producer: {
            status: "Succeeded",
            values: {
              archive: {
                fileMetadataId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
                fileMetadataName: "archive.tar.gz",
              },
            },
          },
        },
      }),
    ).rejects.toThrow('input "endTime" expected a scalar text value');
    expect(capture.spec).toBeUndefined();
  });

  test("passes batched File input contents as multiple staging entries", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor({
      resolvePackage: async () => ({
        usecase: {
          commandFile: "consume-batch",
          inputSlots: [
            {
              kind: "File",
              descriptor: "inputs",
              refMaterials: [{ kind: "FileInputRef", descriptor: "inputFiles" }],
            },
          ],
        },
        software: { kind: "Bare" },
        arguments: [],
        environments: [],
        filesomeInputs: [
          { descriptor: "inputFiles", fileKind: { kind: "Batched", pattern: "inputs/*.txt" } },
        ],
        filesomeOutputs: [],
        valueOutputs: [],
      }),
      submitJob: async (spec) => {
        capture.spec = spec;
        return { jobId: "j-batch", status: "completed", collected: {} };
      },
    });
    const batchNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "batch",
      name: "batch",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [
        {
          type: "File",
          descriptor: "inputs",
          isBatch: true,
          contents: [
            {
              fileMetadataId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
              fileMetadataName: "a.txt",
              hash: "sha-a",
              size: 5,
            },
            {
              fileMetadataId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
              fileMetadataName: "b.txt",
              hash: "sha-b",
              size: 4,
            },
          ],
        },
      ],
    });

    await exec(batchNode, { params: {}, nodes: {} });

    expect(capture.spec?.inputStaging).toEqual([
      { fileMetadataId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", stagePath: "inputs/a.txt" },
      { fileMetadataId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", stagePath: "inputs/b.txt" },
    ]);
  });

  test("a node's valueOutputsOverride replaces the package's value outputs", async () => {
    const exec = createUsecaseExecutor(deps({}));
    const overridden = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [{ type: "Text", descriptor: "endTime", from: { expr: "params.endTime" } }],
      valueOutputsOverride: [
        {
          descriptor: "iterations",
          type: "double",
          from: { collectedOutDescriptor: "log" },
          extract: { kind: "Regex", pattern: "residual = ([0-9.]+)", group: 1 },
        },
      ],
    });
    const res = await exec(overridden, { params: { endTime: "500" }, nodes: {} });
    // The override descriptor is produced; the package's "residual" is not.
    expect(res.values?.iterations).toBe(0.001);
    expect(res.values?.residual).toBeUndefined();
  });

  test("collects only value sources and declared file outputs", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor({
      resolvePackage: async () => ({
        usecase: { commandFile: "produce", inputSlots: [] },
        software: { kind: "Bare" },
        arguments: [],
        environments: [],
        filesomeInputs: [],
        filesomeOutputs: [
          { descriptor: "metrics", fileKind: { kind: "Normal", name: "metrics.txt" } },
          { descriptor: "archive", fileKind: { kind: "Normal", name: "result.tar.gz" } },
          { descriptor: "unused", fileKind: { kind: "Normal", name: "debug.bin" } },
        ],
        valueOutputs: [
          {
            descriptor: "energy",
            type: "double",
            from: { collectedOutDescriptor: "metrics" },
            extract: { kind: "Regex", pattern: "energy=([0-9.]+)", group: 1 },
          },
        ],
      }),
      submitJob: async (spec) => {
        capture.spec = spec;
        return {
          jobId: "j-output-selection",
          status: "completed",
          collected: { metrics: "energy=1" },
          collectedFiles: {
            archive: {
              fileMetadataId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              fileMetadataName: "result.tar.gz",
            },
          },
        };
      },
    });
    const outputNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "produce",
      name: "produce",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      outputSlots: [
        {
          type: "File",
          descriptor: "archive",
          optional: false,
          origin: "UsecaseOut",
          isBatch: false,
        },
      ],
    });

    await exec(outputNode, { params: {}, nodes: {} });

    expect(capture.spec?.expectedOutputs).toEqual([
      { descriptor: "metrics", path: "metrics.txt", isBatch: false },
      { descriptor: "archive", path: "result.tar.gz", isBatch: false, pathsOnly: true },
    ]);
    expect(capture.spec?.fileOutputDescriptors).toEqual(["archive"]);
  });

  test("keeps content collection for a descriptor used as both a value and file output", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor({
      resolvePackage: async () => ({
        usecase: { commandFile: "produce", inputSlots: [] },
        software: { kind: "Bare" },
        arguments: [],
        environments: [],
        filesomeInputs: [],
        filesomeOutputs: [
          { descriptor: "report", fileKind: { kind: "Normal", name: "report.txt" } },
        ],
        valueOutputs: [
          {
            descriptor: "energy",
            type: "double",
            from: { collectedOutDescriptor: "report" },
            extract: { kind: "Regex", pattern: "energy=([0-9.]+)", group: 1 },
          },
        ],
      }),
      submitJob: async (spec) => {
        capture.spec = spec;
        return {
          jobId: "j-dual-output",
          status: "completed",
          collected: { report: "energy=2" },
          collectedFiles: {
            report: {
              fileMetadataId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              fileMetadataName: "report.txt",
            },
          },
        };
      },
    });
    const outputNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "produce",
      name: "produce",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      outputSlots: [
        {
          type: "File",
          descriptor: "report",
          optional: false,
          origin: "UsecaseOut",
          isBatch: false,
        },
      ],
    });

    const result = await exec(outputNode, { params: {}, nodes: {} });

    expect(capture.spec?.expectedOutputs).toEqual([
      { descriptor: "report", path: "report.txt", isBatch: false },
    ]);
    expect(capture.spec?.fileOutputDescriptors).toEqual(["report"]);
    expect(result.values?.energy).toBe(2);
  });

  test("collects a raw descriptor required by downstream Reduce ExtractTable", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor({
      resolvePackage: async () => ({
        usecase: { commandFile: "solve", inputSlots: [] },
        software: { kind: "Bare" },
        arguments: [],
        environments: [],
        filesomeInputs: [],
        filesomeOutputs: [
          { descriptor: "solverLog", fileKind: { kind: "Normal", name: "solver.log" } },
        ],
        valueOutputs: [],
      }),
      submitJob: async (spec) => {
        capture.spec = spec;
        return {
          jobId: "j-reduce-raw",
          status: "completed",
          collected: { solverLog: "Cl=1" },
        };
      },
    });

    const rawNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "raw",
      name: "raw",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
    });

    await exec(rawNode, {
      params: {},
      nodes: {},
      [REQUIRED_COLLECTED_OUTPUTS_KEY]: ["solverLog"],
    });

    expect(capture.spec?.expectedOutputs).toEqual([
      { descriptor: "solverLog", path: "solver.log", isBatch: false },
    ]);
  });

  test("supports empty batched File contents as an empty input list", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor({
      resolvePackage: async () => ({
        usecase: {
          commandFile: "consume-empty-batch",
          inputSlots: [
            {
              kind: "File",
              descriptor: "inputs",
              refMaterials: [{ kind: "FileInputRef", descriptor: "inputFiles" }],
            },
          ],
        },
        software: { kind: "Bare" },
        arguments: [],
        environments: [],
        filesomeInputs: [
          { descriptor: "inputFiles", fileKind: { kind: "Batched", pattern: "inputs/*.txt" } },
        ],
        filesomeOutputs: [],
        valueOutputs: [],
      }),
      submitJob: async (spec) => {
        capture.spec = spec;
        return { jobId: "j-empty-batch", status: "completed", collected: {} };
      },
    });
    const batchNode = workflowDsl.WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "batchEmpty",
      name: "batchEmpty",
      usecaseVersionId: UUID,
      softwareVersionId: UUID,
      inputSlots: [
        {
          type: "File",
          descriptor: "inputs",
          isBatch: true,
          contents: [],
        },
      ],
    });

    await exec(batchNode, { params: {}, nodes: {} });

    expect(capture.spec?.inputStaging).toEqual([]);
  });

  test("projects collected file outputs into downstream File inputs", async () => {
    const calls: JobSubmission[] = [];
    const exec = createUsecaseExecutor({
      resolvePackage: async (_usecaseVersionId, softwareVersionId) => {
        if (softwareVersionId === "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") {
          return {
            usecase: {
              commandFile: "consume",
              inputSlots: [
                {
                  kind: "File",
                  descriptor: "archive",
                  refMaterials: [{ kind: "FileInputRef", descriptor: "archive" }],
                },
              ],
            },
            software: { kind: "Bare" },
            arguments: [],
            environments: [],
            filesomeInputs: [
              { descriptor: "archive", fileKind: { kind: "Normal", name: "upstream.tar.gz" } },
            ],
            filesomeOutputs: [],
            valueOutputs: [],
          };
        }
        return {
          usecase: { commandFile: "produce", inputSlots: [] },
          software: { kind: "Bare" },
          arguments: [],
          environments: [],
          filesomeInputs: [],
          filesomeOutputs: [
            { descriptor: "archive", fileKind: { kind: "Normal", name: "relaxed.tar.gz" } },
          ],
          valueOutputs: [],
        };
      },
      submitJob: async (spec) => {
        calls.push(spec);
        return {
          jobId: `job-${spec.nodeId}`,
          status: "completed",
          collected: {},
          ...(spec.nodeId === "produce"
            ? {
                collectedFiles: {
                  archive: {
                    fileMetadataId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
                    fileMetadataName: "relaxed.tar.gz",
                  },
                },
              }
            : {}),
        };
      },
    });
    const wfDoc = workflowDsl.WorkflowSchema.parse({
      name: "file-edge",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "produce",
            name: "produce",
            usecaseVersionId: UUID,
            softwareVersionId: UUID,
            outputSlots: [
              {
                type: "File",
                descriptor: "archive",
                origin: "UsecaseOut",
                isBatch: false,
              },
            ],
          },
          {
            type: "SoftwareUsecaseComputing",
            id: "consume",
            name: "consume",
            usecaseVersionId: UUID,
            softwareVersionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            inputSlots: [
              {
                type: "File",
                descriptor: "archive",
                from: { node: "produce", output: "archive" },
                isBatch: false,
              },
            ],
          },
        ],
        nodeRelations: [{ fromId: "produce", toId: "consume", slotRelations: [] }],
      },
    });

    const result = await runWorkflow(wfDoc, exec);

    expect(result.status.produce).toBe("Succeeded");
    expect(result.status.consume).toBe("Succeeded");
    expect(calls[1]?.inputStaging).toEqual([
      {
        fileMetadataId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        stagePath: "upstream.tar.gz",
      },
    ]);
  });

  test("fails when a declared File output is not collected", async () => {
    const exec = createUsecaseExecutor({
      resolvePackage: async () => ({
        usecase: { commandFile: "produce", inputSlots: [] },
        software: { kind: "Bare" },
        arguments: [],
        environments: [],
        filesomeInputs: [],
        filesomeOutputs: [
          { descriptor: "archive", fileKind: { kind: "Normal", name: "archive.tar.gz" } },
        ],
        valueOutputs: [],
      }),
      submitJob: async () => ({
        jobId: "job-produce",
        status: "completed",
        collected: {},
        collectedFiles: {},
      }),
    });
    const wfDoc = workflowDsl.WorkflowSchema.parse({
      name: "missing-file-output",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "produce",
            name: "produce",
            usecaseVersionId: UUID,
            softwareVersionId: UUID,
            outputSlots: [
              {
                type: "File",
                descriptor: "archive",
                origin: "UsecaseOut",
                isBatch: false,
              },
            ],
          },
        ],
      },
    });

    const result = await runWorkflow(wfDoc, exec);

    expect(result.status.produce).toBe("Failed");
    expect(result.values.produce?.values.archive).toBeUndefined();
  });

  test("projects collected batched file outputs into downstream File[] inputs", async () => {
    const calls: JobSubmission[] = [];
    const exec = createUsecaseExecutor({
      resolvePackage: async (_usecaseVersionId, softwareVersionId) => {
        if (softwareVersionId === "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") {
          return {
            usecase: {
              commandFile: "consume",
              inputSlots: [
                {
                  kind: "File",
                  descriptor: "chunks",
                  refMaterials: [{ kind: "FileInputRef", descriptor: "chunks" }],
                },
              ],
            },
            software: { kind: "Bare" },
            arguments: [],
            environments: [],
            filesomeInputs: [
              { descriptor: "chunks", fileKind: { kind: "Batched", pattern: "inputs/*.txt" } },
            ],
            filesomeOutputs: [],
            valueOutputs: [],
          };
        }
        return {
          usecase: { commandFile: "produce", inputSlots: [] },
          software: { kind: "Bare" },
          arguments: [],
          environments: [],
          filesomeInputs: [],
          filesomeOutputs: [
            { descriptor: "chunks", fileKind: { kind: "Batched", pattern: "chunks/*.txt" } },
          ],
          valueOutputs: [],
        };
      },
      submitJob: async (spec) => {
        calls.push(spec);
        return {
          jobId: `job-${spec.nodeId}`,
          status: "completed",
          collected: {},
          ...(spec.nodeId === "produce"
            ? {
                collectedFiles: {
                  chunks: [
                    {
                      fileMetadataId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
                      fileMetadataName: "a.txt",
                    },
                    {
                      fileMetadataId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
                      fileMetadataName: "b.txt",
                    },
                  ],
                },
              }
            : {}),
        };
      },
    });
    const wfDoc = workflowDsl.WorkflowSchema.parse({
      name: "batch-file-edge",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "produce",
            name: "produce",
            usecaseVersionId: UUID,
            softwareVersionId: UUID,
            outputSlots: [
              {
                type: "File",
                descriptor: "chunks",
                origin: "UsecaseOut",
                isBatch: true,
              },
            ],
          },
          {
            type: "SoftwareUsecaseComputing",
            id: "consume",
            name: "consume",
            usecaseVersionId: UUID,
            softwareVersionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            inputSlots: [
              {
                type: "File",
                descriptor: "chunks",
                from: { node: "produce", output: "chunks" },
                isBatch: true,
              },
            ],
          },
        ],
        nodeRelations: [{ fromId: "produce", toId: "consume", slotRelations: [] }],
      },
    });

    const result = await runWorkflow(wfDoc, exec);

    expect(result.status.produce).toBe("Succeeded");
    expect(result.status.consume).toBe("Succeeded");
    expect(calls[1]?.inputStaging).toEqual([
      {
        fileMetadataId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        stagePath: "inputs/a.txt",
      },
      {
        fileMetadataId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        stagePath: "inputs/b.txt",
      },
    ]);
  });

  test("names the job after the node for observability", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    await exec(node, { params: { endTime: "500" }, nodes: {} });
    expect(capture.spec?.name).toBe("solve");
  });

  test("omits resources when the node declares no requirements", async () => {
    const capture: { spec?: JobSubmission } = {};
    const exec = createUsecaseExecutor(deps(capture));
    await exec(node, { params: { endTime: "500" }, nodes: {} });
    expect(capture.spec?.resources).toBeUndefined();
  });

  test("a scheduler reason marks the failed job node with useful details", async () => {
    const failing = deps({});
    failing.submitJob = async () => ({
      jobId: "j1",
      status: "failed",
      collected: {},
      reason: "LAMMPS input command failed",
      exitCode: 2,
    });
    const exec = createUsecaseExecutor(failing);
    const res = await exec(node, { params: { endTime: "500" }, nodes: {} });
    expect(res.status).toBe("Failed");
    expect(res.failure).toEqual({
      message: "LAMMPS input command failed",
      jobId: "j1",
      exitCode: 2,
    });
  });

  test("a NoAction node is a no-op success", async () => {
    const exec = createUsecaseExecutor(deps({}));
    const noop = workflowDsl.WorkflowNodeSchema.parse({ type: "NoAction", id: "n", name: "n" });
    const res = await exec(noop, { params: {}, nodes: {} });
    expect(res.status).toBe("Succeeded");
  });

  test("Script and Milestone nodes fail fast instead of silently succeeding", async () => {
    const exec = createUsecaseExecutor(deps({}));
    const script = workflowDsl.WorkflowNodeSchema.parse({
      type: "Script",
      id: "script",
      name: "script",
      source: { type: "Inline", language: "python", content: "print('not wired')" },
      runtimeProfileId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });
    const milestone = workflowDsl.WorkflowNodeSchema.parse({
      type: "Milestone",
      id: "gate",
      name: "gate",
      url: "https://example.invalid",
      customMessage: "manual gate",
    });

    await expect(exec(script, { params: {}, nodes: {} })).resolves.toMatchObject({
      status: "Failed",
      values: {},
    });
    await expect(exec(milestone, { params: {}, nodes: {} })).resolves.toMatchObject({
      status: "Failed",
      values: {},
    });
  });

  test("end-to-end: the engine drives the usecase executor (params -> CEL -> materialize -> extract)", async () => {
    const exec = createUsecaseExecutor(deps({}));
    const wfDoc = workflowDsl.WorkflowSchema.parse({
      name: "w",
      parameters: [{ name: "endTime", type: "string", default: "500" }],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "solve",
            name: "solve",
            usecaseVersionId: UUID,
            softwareVersionId: UUID,
            inputSlots: [{ type: "Text", descriptor: "endTime", from: { expr: "params.endTime" } }],
          },
        ],
      },
    });
    const r = await runWorkflow(wfDoc, exec);
    expect(r.status.solve).toBe("Succeeded");
    expect(r.values.solve?.values.residual).toBe(0.001);
  });
});
