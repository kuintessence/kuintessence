import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { UsecaseExecutorDeps } from "@kuintessence/shared";
import { createWorkflowRunner } from "./runner";

const TEMPLATE_DIR = join(import.meta.dir, "../../../../examples/workflows");

const readTemplate = (name: string): Promise<string> => readFile(join(TEMPLATE_DIR, name), "utf8");

/**
 * A fake executor general enough to drive every gallery template's leaf
 * SoftwareUsecaseComputing node to Succeeded. Each leaf binds a `script` Text
 * slot; we declare a matching usecase input slot (ArgRef) so the bound value
 * materializes into the command, and a `result` value output extracted from a
 * synthetic collected `out` bundle so loop/reduce gathers have something to
 * read. submitJob always "completes" and returns that bundle.
 */
const fakeDeps: UsecaseExecutorDeps = {
  resolvePackage: async () => ({
    usecase: {
      commandFile: "run.sh",
      inputSlots: [
        {
          kind: "Text",
          descriptor: "script",
          refMaterials: [{ kind: "ArgRef", descriptor: "script", sort: 0 }],
        },
      ],
    },
    software: { kind: "Bare" },
    arguments: [{ descriptor: "script", valueFormat: "-c {}" }],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [
      {
        descriptor: "result",
        type: "string",
        from: { collectedOutDescriptor: "out" },
        extract: { kind: "Regex", pattern: "sum=([0-9.]+)", group: 1 },
      },
    ],
  }),
  submitJob: async () => ({
    jobId: "fake-job",
    status: "completed",
    collected: { out: "sum=1\nmetric=1\n" },
    collectedFiles: {
      result: {
        fileMetadataId: "fake-result-file",
        fileMetadataName: "result.txt",
      },
    },
  }),
};

const run = createWorkflowRunner(fakeDeps);

describe("gallery workflow templates execute through the workflow engine", () => {
  test("hello: the single usecase node runs to Succeeded", async () => {
    const result = await run(await readTemplate("hello.yaml"));
    expect(result.status.hello).toBe("Succeeded");
    expect(result.values.hello?.values.result).toBe("1");
  });

  test("two-node-pipeline: both nodes in the relation run to Succeeded", async () => {
    const result = await run(await readTemplate("two-node-pipeline.yaml"));
    expect(result.status.greet).toBe("Succeeded");
    expect(result.status.respond).toBe("Succeeded");
  });

  test("fanout-dag: the fan-out and both branches run to Succeeded", async () => {
    const result = await run(await readTemplate("fanout-dag.yaml"));
    expect(result.status.prepare).toBe("Succeeded");
    expect(result.status.analyze_a).toBe("Succeeded");
    expect(result.status.analyze_b).toBe("Succeeded");
  });

  test("conditional-switch: the Switch routes to exactly the chosen branch", async () => {
    const result = await run(await readTemplate("conditional-switch.yaml"));
    expect(result.status.route).toBe("Succeeded");
    // mode defaults to 'fast' -> fast_path is chosen and runs; slow_path is skipped.
    expect(result.status.fast_path).toBe("Succeeded");
    expect(result.status.slow_path).toBe("Skipped");
  });

  test("subworkflow-inline: the SubWorkflow node and its feeder run to Succeeded", async () => {
    const result = await run(await readTemplate("subworkflow-inline.yaml"));
    expect(result.status.prepare).toBe("Succeeded");
    expect(result.status.nested).toBe("Succeeded");
  });
});

describe("gallery control-flow templates execute end-to-end", () => {
  test("param-sweep: string(params.threshold) binds and the node runs", async () => {
    const result = await run(await readTemplate("param-sweep.yaml"));
    expect(result.status.sweep).toBe("Succeeded");
  });

  test("loop-foreach: the ForEach loop over a CEL list literal runs", async () => {
    const result = await run(await readTemplate("loop-foreach.yaml"));
    expect(result.status.per_item).toBe("Succeeded");
  });

  test("scatter-gather: the loop scatters and ExtractTable gathers a real CSV", async () => {
    const result = await run(await readTemplate("scatter-gather.yaml"));
    expect(result.status.scatter).toBe("Succeeded");
    expect(result.status.gather).toBe("Succeeded");
    // One header row + one row per scattered iteration (over ['a','b','c']);
    // shard_result from the node's value output, metric regex'd from the log.
    expect(result.values.gather?.values.table).toBe("shard_result,metric\n1,1\n1,1\n1,1\n");
  });
});
