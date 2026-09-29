import { describe, expect, test } from "bun:test";
import { SPACK_EXECUTION_PLACEHOLDER } from "@kuintessence/shared";
import { createJobSubmitter, type JobSubmitterDeps } from "./job-submitter";

describe("createJobSubmitter", () => {
  test("persists only the placeholder and forwards prepared Spack intent transiently", async () => {
    const execution = { spec: "hello@1.0 +mpi", command: "hello --count 2" };
    let dispatched = false;
    const submit = createJobSubmitter({
      prepare: async (spec) => ({ ...spec, spackExecution: execution }),
      submit: async (spec) => {
        expect(spec.command).toBe(SPACK_EXECUTION_PLACEHOLDER);
        expect("spackExecution" in spec).toBe(false);
        return { id: "job-spack" };
      },
      dispatch: async (
        jobId,
        _staging,
        _outputs,
        _stdin,
        _materials,
        _requirements,
        _strategy,
        spackExecution,
      ) => {
        expect(jobId).toBe("job-spack");
        expect(spackExecution).toEqual(execution);
        dispatched = true;
      },
      awaitCompletion: async () => ({ status: "completed", collected: {} }),
    });
    await submit({
      nodeId: "spack",
      name: "spack",
      command: SPACK_EXECUTION_PLACEHOLDER,
      spackExecution: { spec: "hello@1.0", command: "hello" },
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
    });
    expect(dispatched).toBe(true);
  });

  test("submits, dispatches, then awaits completion and returns status + collected outputs", async () => {
    const calls: string[] = [];
    const deps: JobSubmitterDeps = {
      submit: async (spec) => {
        calls.push(`submit:${spec.command}`);
        return { id: "job-1" };
      },
      onSubmitted: async (nodeId, jobId) => {
        calls.push(`submitted:${nodeId}:${jobId}`);
      },
      dispatch: async (jobId, staging, expected, stdinText) => {
        calls.push(`dispatch:${jobId}:${staging.length}:${expected.length}:${stdinText ?? ""}`);
      },
      awaitCompletion: async (jobId) => {
        calls.push(`await:${jobId}`);
        return { status: "completed", collected: { log: "residual = 0.001" } };
      },
    };
    const submit = createJobSubmitter(deps);
    const r = await submit({
      nodeId: "solve",
      name: "solve",
      command: "spack load of && simpleFoam",
      envVars: { OMP_NUM_THREADS: "8" },
      inputStaging: [{ fileMetadataId: "fm-1", stagePath: "mesh.tar.gz" }],
      expectedOutputs: [],
      fileOutputDescriptors: [],
      stdinText: "1\n2\n",
    });
    expect(r.jobId).toBe("job-1");
    expect(r.status).toBe("completed");
    expect(r.collected).toEqual({ log: "residual = 0.001" });
    expect(calls).toEqual([
      "submit:spack load of && simpleFoam",
      "submitted:solve:job-1",
      "dispatch:job-1:1:0:1\n2\n",
      "await:job-1",
    ]);
  });

  test("surfaces a terminal failure status from the agent", async () => {
    const deps: JobSubmitterDeps = {
      submit: async () => ({ id: "job-2" }),
      dispatch: async () => {},
      awaitCompletion: async () => ({
        status: "failed",
        collected: {},
        errorMessage: "Exit 7",
        reason: "Node failure",
        exitCode: 7,
      }),
    };
    const submit = createJobSubmitter(deps);
    const r = await submit({
      nodeId: "boom",
      name: "boom",
      command: "false",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
      fileOutputDescriptors: [],
    });
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toBe("Exit 7");
    expect(r.reason).toBe("Node failure");
    expect(r.exitCode).toBe(7);
  });

  test("passes schedulingStrategy to job submission", async () => {
    let submittedQueueId: string | undefined;
    const deps: JobSubmitterDeps = {
      submit: async (spec) => {
        submittedQueueId = spec.schedulingStrategy?.queueId;
        return { id: "job-queue" };
      },
      dispatch: async () => {},
      awaitCompletion: async () => ({ status: "completed", collected: {} }),
    };
    const submit = createJobSubmitter(deps);
    await submit({
      nodeId: "queued",
      name: "queued",
      command: "true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
      fileOutputDescriptors: [],
      schedulingStrategy: { queueId: "queue-1" },
    });

    expect(submittedQueueId).toBe("queue-1");
  });

  test("passes typed Dataset references to the persisted job submission", async () => {
    let submittedDataInputs: Record<string, unknown> | undefined;
    const deps: JobSubmitterDeps = {
      submit: async (spec) => {
        submittedDataInputs = spec.dataInputs;
        return { id: "job-dataset" };
      },
      dispatch: async () => {},
      awaitCompletion: async () => ({ status: "completed", collected: {} }),
    };
    const submit = createJobSubmitter(deps);
    await submit({
      nodeId: "train",
      name: "train",
      command: "python train.py",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
      fileOutputDescriptors: [],
      dataInputs: {
        trainingData: {
          source: "data-market",
          assetId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          versionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          manifestDigest: "sha256:dataset-manifest",
          selectedEntries: ["train/data.csv"],
        },
      },
    });

    expect(submittedDataInputs).toEqual({
      trainingData: {
        source: "data-market",
        assetId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        versionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        manifestDigest: "sha256:dataset-manifest",
        selectedEntries: ["train/data.csv"],
      },
    });
  });

  test("uses the prepared Dataset submission for persistence, dispatch, and file collection", async () => {
    const preparedDataInputs = {
      trainingData: {
        source: "data-market" as const,
        assetId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        versionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        manifestDigest: "sha256:dataset-manifest",
        selectedEntries: ["train/data.csv"],
        targetPath: "inputs/training",
      },
    };
    const deps: JobSubmitterDeps = {
      prepare: async (spec) => ({
        ...spec,
        dataInputs: preparedDataInputs,
        licensedMaterials: [],
      }),
      submit: async (spec) => {
        expect(spec.dataInputs).toEqual(preparedDataInputs);
        expect(spec.licensedMaterials).toEqual([]);
        return { id: "job-prepared" };
      },
      dispatch: async (_jobId, _staging, _expected, _stdinText, licensedMaterials) => {
        expect(licensedMaterials).toEqual([]);
      },
      awaitCompletion: async () => ({ status: "completed", collected: {} }),
      collectFiles: async (_jobId, spec) => {
        expect(spec.dataInputs).toEqual(preparedDataInputs);
        expect(spec.licensedMaterials).toEqual([]);
        return {};
      },
    };
    const submit = createJobSubmitter(deps);
    await submit({
      nodeId: "train",
      name: "train",
      command: "python train.py",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
      fileOutputDescriptors: [],
      licensedMaterials: [
        {
          selector: "training-data-license",
          targetPath: "inputs/training",
          requiredElements: [],
        },
      ],
    });
  });

  test("passes preferred schedulingStrategy queues to dispatch", async () => {
    let dispatchedPreferredQueueIds: string[] | undefined;
    const deps: JobSubmitterDeps = {
      submit: async () => ({ id: "job-prefer" }),
      dispatch: async (
        _jobId,
        _staging,
        _expected,
        _stdinText,
        _licensedMaterials,
        _softwareRequirements,
        schedulingStrategy,
      ) => {
        dispatchedPreferredQueueIds =
          schedulingStrategy && "preferredQueueIds" in schedulingStrategy
            ? schedulingStrategy.preferredQueueIds
            : undefined;
      },
      awaitCompletion: async () => ({ status: "completed", collected: {} }),
    };
    const submit = createJobSubmitter(deps);
    await submit({
      nodeId: "preferred",
      name: "preferred",
      command: "true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [],
      fileOutputDescriptors: [],
      schedulingStrategy: { preferredQueueIds: ["queue-fast", "queue-backup"] },
    });

    expect(dispatchedPreferredQueueIds).toEqual(["queue-fast", "queue-backup"]);
  });

  test("publishes collected file metadata after successful completion", async () => {
    const deps: JobSubmitterDeps = {
      submit: async () => ({ id: "job-3" }),
      dispatch: async () => {},
      awaitCompletion: async () => ({ status: "completed", collected: {} }),
      collectFiles: async (jobId, spec, collected) => {
        expect(jobId).toBe("job-3");
        expect(spec.fileOutputDescriptors).toEqual(["archive"]);
        expect(collected.archive).toBeUndefined();
        return {
          archive: {
            fileMetadataId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            fileMetadataName: "relaxed.tar.gz",
          },
        };
      },
    };
    const submit = createJobSubmitter(deps);
    const r = await submit({
      nodeId: "produce",
      name: "produce",
      command: "bash -lc true",
      envVars: {},
      inputStaging: [],
      expectedOutputs: [{ descriptor: "archive", path: "relaxed.tar.gz", isBatch: false }],
      fileOutputDescriptors: ["archive"],
    });

    const archive = r.collectedFiles?.archive;
    expect(Array.isArray(archive)).toBe(false);
    expect(archive && !Array.isArray(archive) ? archive.fileMetadataId : undefined).toBe(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
  });
});
