import { describe, expect, test } from "bun:test";
import type { UsecaseExecutorDeps, WorkflowRunGraph } from "@kuintessence/shared";
import { parseWorkflowYaml } from "./parser";
import { createWorkflowRunner } from "./runner";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DENIED_QUEUE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const deps: UsecaseExecutorDeps = {
  resolvePackage: async () => ({
    usecase: { commandFile: "simpleFoam", inputSlots: [] },
    software: { kind: "Spack", name: "of", argumentList: [] },
    arguments: [],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [
      {
        descriptor: "residual",
        type: "double",
        from: { collectedOutDescriptor: "log" },
        extract: { kind: "Regex", pattern: "r=([0-9.]+)", group: 1 },
      },
    ],
  }),
  submitJob: async () => ({ jobId: "j1", status: "completed", collected: { log: "r=0.002" } }),
};

describe("createWorkflowRunner", () => {
  test("parses, validates and runs a workflow end-to-end", async () => {
    const run = createWorkflowRunner(deps);
    const result = await run(`
name: w
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: solve
      name: solve
      usecaseVersionId: ${UUID}
      softwareVersionId: ${UUID}
`);
    expect(result.status.solve).toBe("Succeeded");
    expect(result.values.solve?.values.residual).toBe(0.002);
  });

  test("calls persistRun with the workflow name + node statuses + graph and returns the runId", async () => {
    const calls: Array<{
      name: string;
      statuses: Record<string, string>;
      graph: WorkflowRunGraph;
    }> = [];
    const run = createWorkflowRunner({
      ...deps,
      persistRun: async (name, result, graph) => {
        calls.push({ name, statuses: result.status, graph });
        return "run-xyz";
      },
    });
    const result = await run(`
name: persisted-wf
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: solve
      name: solve
      usecaseVersionId: ${UUID}
      softwareVersionId: ${UUID}
`);
    expect(result.runId).toBe("run-xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("persisted-wf");
    expect(calls[0]?.statuses.solve).toBe("Succeeded");
    expect(calls[0]?.graph.nodes).toEqual([
      { id: "solve", name: "solve", kind: "SoftwareUsecaseComputing" },
    ]);
    expect(calls[0]?.graph.edges).toEqual([]);
  });

  test("a persistRun failure does not fail an already-executed run (returns result, no runId)", async () => {
    const run = createWorkflowRunner({
      ...deps,
      persistRun: async () => {
        throw new Error("db down");
      },
    });
    const result = await run(
      `name: w\nspec:\n  nodeDrafts:\n    - type: NoAction\n      id: a\n      name: a\n`,
    );
    // The run executed — surface the result; just no runId since persistence failed.
    expect(result.status.a).toBe("Succeeded");
    expect(result.runId).toBeUndefined();
  });

  test("omits runId when no persistRun is wired", async () => {
    const run = createWorkflowRunner(deps);
    const result = await run(
      `name: w\nspec:\n  nodeDrafts:\n    - type: NoAction\n      id: a\n      name: a\n`,
    );
    expect(result.runId).toBeUndefined();
  });

  test("passes SubWorkflow ByVersion through the configured workflow resolver", async () => {
    const workflowVersionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const run = createWorkflowRunner({
      ...deps,
      resolveWorkflowVersion: async (id) => {
        expect(id).toBe(workflowVersionId);
        return parseWorkflowYaml(`
name: child
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: solve
      name: solve
      usecaseVersionId: ${UUID}
      softwareVersionId: ${UUID}
`);
      },
    });
    const result = await run(`
name: parent
spec:
  nodeDrafts:
    - type: SubWorkflow
      id: sub
      name: sub
      maxDepth: 8
      ref:
        kind: ByVersion
        workflowVersionId: ${workflowVersionId}
      outputs:
        - descriptor: refined
          from:
            workflowOutput: residual
`);
    expect(result.status.sub).toBe("Succeeded");
    expect(result.values.sub?.values.refined).toBe(0.002);
  });

  test("records queue authorization denial as node Failed and cancels downstream nodes", async () => {
    const submittedQueueIds: string[] = [];
    const run = createWorkflowRunner({
      ...deps,
      submitJob: async (spec) => {
        const queueId =
          spec.schedulingStrategy && "queueId" in spec.schedulingStrategy
            ? spec.schedulingStrategy.queueId
            : undefined;
        submittedQueueIds.push(queueId ?? "none");
        if (queueId === DENIED_QUEUE_ID) {
          throw new Error("Authorization denied");
        }
        return { jobId: "should-not-run", status: "completed", collected: { log: "r=9" } };
      },
    });

    const result = await run(`
name: queue-authz-denied
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: denied
      name: denied
      usecaseVersionId: ${UUID}
      softwareVersionId: ${UUID}
      schedulingStrategy:
        type: Manual
        queues: [${DENIED_QUEUE_ID}]
    - type: NoAction
      id: downstream
      name: downstream
  nodeRelations:
    - fromId: denied
      toId: downstream
      slotRelations: []
`);

    expect(submittedQueueIds).toEqual([DENIED_QUEUE_ID]);
    expect(result.status.denied).toBe("Failed");
    expect(result.status.downstream).toBe("Cancelled");
    expect(result.values.denied?.values).toEqual({});
    expect(result.values.downstream?.values).toEqual({});
  });

  test("rejects an invalid workflow document", async () => {
    const run = createWorkflowRunner(deps);
    let threw = false;
    try {
      await run('name: ""\nspec:\n  nodeDrafts: []\n');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
