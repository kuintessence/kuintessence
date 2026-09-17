import { describe, expect, test } from "bun:test";
import * as workflowDsl from "../workflow-dsl";
import {
  NODE_COLLECTED_KEY,
  type NodeExecutor,
  REQUIRED_COLLECTED_OUTPUTS_KEY,
  runWorkflow,
} from "./engine";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const suc = (id: string, over: Record<string, unknown> = {}) => ({
  type: "SoftwareUsecaseComputing",
  id,
  name: id,
  usecaseVersionId: UUID,
  softwareVersionId: UUID,
  ...over,
});
const wf = (spec: unknown, params: unknown[] = []) =>
  workflowDsl.WorkflowSchema.parse({ name: "w", parameters: params, spec });

const okExecutor =
  (values: Record<string, Record<string, unknown>> = {}): NodeExecutor =>
  async (node) => ({ status: "Succeeded", values: values[node.id] ?? {} });

describe("runWorkflow — orchestration core", () => {
  test("a throwing executor records the node Failed instead of rejecting the run", async () => {
    const exec: NodeExecutor = async (node) => {
      if (node.id === "b") {
        throw new Error("resolvePackage exploded");
      }
      return { status: "Succeeded", values: {} };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("a"), suc("b"), suc("c")],
        nodeRelations: [
          { fromId: "a", toId: "b", slotRelations: [] },
          { fromId: "b", toId: "c", slotRelations: [] },
        ],
      }),
      exec,
    );
    expect(r.status.a).toBe("Succeeded");
    expect(r.status.b).toBe("Failed");
    expect(r.values.b?.failure?.message).toBe("resolvePackage exploded");
    // Downstream of a failed node is cancelled, as for any other failure.
    expect(r.status.c).toBe("Cancelled");
  });

  test("executes nodes in dependency order", async () => {
    const order: string[] = [];
    const exec: NodeExecutor = async (node) => {
      order.push(node.id);
      return { status: "Succeeded", values: {} };
    };
    await runWorkflow(
      wf({
        nodeDrafts: [suc("c"), suc("a"), suc("b")],
        nodeRelations: [
          { fromId: "a", toId: "b", slotRelations: [] },
          { fromId: "b", toId: "c", slotRelations: [] },
        ],
      }),
      exec,
    );
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("dependency cycles fail unresolved nodes instead of omitting them", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: {} };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("a"), suc("b")],
        nodeRelations: [
          { fromId: "a", toId: "b", slotRelations: [] },
          { fromId: "b", toId: "a", slotRelations: [] },
        ],
      }),
      exec,
    );

    expect(r.status.a).toBe("Failed");
    expect(r.status.b).toBe("Failed");
    expect(called).toEqual([]);
  });

  test("a when=false node is Skipped and its executor is not called", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: {} };
    };
    const r = await runWorkflow(
      wf({ nodeDrafts: [suc("a"), suc("b", { when: { expr: "false" } })] }),
      exec,
    );
    expect(r.status.b).toBe("Skipped");
    expect(called).not.toContain("b");
  });

  test("downstream when can read an upstream node's extracted values", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("up"), suc("down", { when: { expr: "nodes.up.values.ok == true" } })],
        nodeRelations: [{ fromId: "up", toId: "down", slotRelations: [] }],
      }),
      okExecutor({ up: { ok: true } }),
    );
    expect(r.status.down).toBe("Succeeded");
  });

  test("params defaults are visible to guards", async () => {
    const r = await runWorkflow(
      wf({ nodeDrafts: [suc("a", { when: { expr: "params.go == true" } })] }, [
        { name: "go", type: "bool", default: true },
      ]),
      okExecutor(),
    );
    expect(r.status.a).toBe("Succeeded");
  });

  test("parameter defaults are coerced to their declared type", async () => {
    const r = await runWorkflow(
      wf({ nodeDrafts: [suc("a", { when: { expr: "params.go == true" } })] }, [
        { name: "go", type: "bool", default: "true" },
      ]),
      okExecutor(),
    );

    expect(r.status.a).toBe("Succeeded");
  });

  test("invalid parameter defaults fail before execution", async () => {
    await expect(
      runWorkflow(
        wf({ nodeDrafts: [suc("a")] }, [{ name: "limit", type: "double", default: "Infinity" }]),
        okExecutor(),
      ),
    ).rejects.toThrow(/double/);
  });

  test("a when expression error records the node Failed instead of rejecting the run", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("guarded", { when: { expr: "ghost.flag == true" } }), suc("down")],
        nodeRelations: [{ fromId: "guarded", toId: "down", slotRelations: [] }],
      }),
      okExecutor(),
    );

    expect(r.status.guarded).toBe("Failed");
    expect(r.status.down).toBe("Cancelled");
  });

  test("a false nodeRelation when skips the target and does not call its executor", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: {} };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("source"), suc("target")],
        nodeRelations: [
          { fromId: "source", toId: "target", when: { expr: "false" }, slotRelations: [] },
        ],
      }),
      exec,
    );

    expect(r.status.source).toBe("Succeeded");
    expect(r.status.target).toBe("Skipped");
    expect(called).toEqual(["source"]);
  });

  test("a false slotRelation when skips the target and does not call its executor", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: {} };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("source"), suc("target")],
        nodeRelations: [
          {
            fromId: "source",
            toId: "target",
            slotRelations: [
              {
                fromSlot: "out",
                toSlot: "in",
                transferStrategy: { type: "Network" },
                when: { expr: "false" },
              },
            ],
          },
        ],
      }),
      exec,
    );

    expect(r.status.source).toBe("Succeeded");
    expect(r.status.target).toBe("Skipped");
    expect(called).toEqual(["source"]);
  });

  test("a nodeRelation when expression error fails the target without rejecting the run", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: {} };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("source"), suc("target"), suc("down")],
        nodeRelations: [
          {
            fromId: "source",
            toId: "target",
            when: { expr: "ghost.flag == true" },
            slotRelations: [],
          },
          { fromId: "target", toId: "down", slotRelations: [] },
        ],
      }),
      exec,
    );

    expect(r.status.source).toBe("Succeeded");
    expect(r.status.target).toBe("Failed");
    expect(r.status.down).toBe("Cancelled");
    expect(called).toEqual(["source"]);
  });

  test("a slotRelation when expression error fails the target without rejecting the run", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: {} };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("source"), suc("target"), suc("down")],
        nodeRelations: [
          {
            fromId: "source",
            toId: "target",
            slotRelations: [
              {
                fromSlot: "out",
                toSlot: "in",
                transferStrategy: { type: "Network" },
                when: { expr: "ghost.flag == true" },
              },
            ],
          },
          { fromId: "target", toId: "down", slotRelations: [] },
        ],
      }),
      exec,
    );

    expect(r.status.source).toBe("Succeeded");
    expect(r.status.target).toBe("Failed");
    expect(r.status.down).toBe("Cancelled");
    expect(called).toEqual(["source"]);
  });

  test("skip propagates to dependents", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("a", { when: { expr: "false" } }), suc("b")],
        nodeRelations: [{ fromId: "a", toId: "b", slotRelations: [] }],
      }),
      okExecutor(),
    );
    expect(r.status.a).toBe("Skipped");
    expect(r.status.b).toBe("Skipped");
  });

  test("a required input bound to an absent upstream output skips the node", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: {} };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          suc("produce"),
          suc("consume", {
            inputSlots: [
              {
                type: "Text",
                descriptor: "requiredText",
                optional: false,
                from: { node: "produce", output: "missing" },
              },
            ],
          }),
        ],
        nodeRelations: [{ fromId: "produce", toId: "consume", slotRelations: [] }],
      }),
      exec,
    );

    expect(r.status.produce).toBe("Succeeded");
    expect(r.status.consume).toBe("Skipped");
    expect(called).toEqual(["produce"]);
  });

  test("RequireExactlyOne sources fail when multiple upstream outputs are available", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: { out: node.id } };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          suc("left"),
          suc("right"),
          suc("join", {
            inputSlots: [
              {
                type: "Text",
                descriptor: "selected",
                sources: [
                  { node: "left", output: "out" },
                  { node: "right", output: "out" },
                ],
                select: "RequireExactlyOne",
              },
            ],
          }),
        ],
        nodeRelations: [
          { fromId: "left", toId: "join", slotRelations: [] },
          { fromId: "right", toId: "join", slotRelations: [] },
        ],
      }),
      exec,
    );

    expect(r.status.left).toBe("Succeeded");
    expect(r.status.right).toBe("Succeeded");
    expect(r.status.join).toBe("Failed");
    expect(called).toEqual(["left", "right"]);
  });

  test("source readiness ignores failed upstream nodes even when they have values", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      if (node.id === "failed") {
        return { status: "Failed", values: { out: "stale" } };
      }
      return { status: "Succeeded", values: {} };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          suc("failed"),
          suc("join", {
            inputSlots: [
              {
                type: "Text",
                descriptor: "selected",
                sources: [{ node: "failed", output: "out" }],
                select: "FirstAvailable",
              },
            ],
          }),
        ],
      }),
      exec,
    );

    expect(r.status.failed).toBe("Failed");
    expect(r.status.join).toBe("Skipped");
    expect(called).toEqual(["failed"]);
  });

  test("expression-based select marks the node ready when the selected source is available", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: { out: node.id } };
    };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          suc("left"),
          suc("right"),
          suc("join", {
            inputSlots: [
              {
                type: "Text",
                descriptor: "selected",
                sources: [
                  { node: "left", output: "out" },
                  { node: "right", output: "out" },
                ],
                select: { expr: "1" },
              },
            ],
          }),
        ],
        nodeRelations: [
          { fromId: "left", toId: "join", slotRelations: [] },
          { fromId: "right", toId: "join", slotRelations: [] },
        ],
      }),
      exec,
    );

    expect(r.status.left).toBe("Succeeded");
    expect(r.status.right).toBe("Succeeded");
    expect(r.status.join).toBe("Succeeded");
    expect(called).toEqual(["left", "right", "join"]);
  });

  test("a failed node cancels its dependents", async () => {
    const exec: NodeExecutor = async (node) =>
      node.id === "a" ? { status: "Failed", values: {} } : { status: "Succeeded", values: {} };
    const r = await runWorkflow(
      wf({
        nodeDrafts: [suc("a"), suc("b")],
        nodeRelations: [{ fromId: "a", toId: "b", slotRelations: [] }],
      }),
      exec,
    );
    expect(r.status.a).toBe("Failed");
    expect(r.status.b).toBe("Cancelled");
  });
});

describe("runWorkflow — Switch routing", () => {
  const sw = (cases: unknown[], def?: string) => ({
    type: "Switch",
    id: "pick",
    name: "pick",
    cases,
    ...(def === undefined ? {} : { default: def }),
  });

  test("activates the first matching case target and skips the rest", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          sw(
            [
              { when: { expr: "true" }, to: "a" },
              { when: { expr: "true" }, to: "b" },
            ],
            "c",
          ),
          suc("a"),
          suc("b"),
          suc("c"),
        ],
      }),
      okExecutor(),
    );
    expect(r.status.pick).toBe("Succeeded");
    expect(r.status.a).toBe("Succeeded");
    expect(r.status.b).toBe("Skipped");
    expect(r.status.c).toBe("Skipped");
  });

  test("falls back to default when no case matches", async () => {
    const r = await runWorkflow(
      wf({ nodeDrafts: [sw([{ when: { expr: "false" }, to: "a" }], "c"), suc("a"), suc("c")] }),
      okExecutor(),
    );
    expect(r.status.a).toBe("Skipped");
    expect(r.status.c).toBe("Succeeded");
  });

  test("case expression errors fail the Switch instead of rejecting the run", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          sw([{ when: { expr: "ghost.flag == true" }, to: "a" }], "b"),
          suc("a"),
          suc("b"),
        ],
      }),
      okExecutor(),
    );

    expect(r.status.pick).toBe("Failed");
    expect(r.status.a).toBe("Cancelled");
    expect(r.status.b).toBe("Cancelled");
  });

  test("a non-selected branch's dependents are skipped", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          sw([{ when: { expr: "true" }, to: "a" }], "b"),
          suc("a"),
          suc("b"),
          suc("bDown"),
        ],
        nodeRelations: [{ fromId: "b", toId: "bDown", slotRelations: [] }],
      }),
      okExecutor(),
    );
    expect(r.status.b).toBe("Skipped");
    expect(r.status.bDown).toBe("Skipped");
  });

  test("no matching case without a default skips every branch", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          sw([
            { when: { expr: "false" }, to: "a" },
            { when: { expr: "params.mode == 'never'" }, to: "b" },
          ]),
          suc("a"),
          suc("b"),
        ],
      }),
      okExecutor(),
    );
    expect(r.status.pick).toBe("Succeeded");
    expect(r.status.a).toBe("Skipped");
    expect(r.status.b).toBe("Skipped");
  });
});

describe("runWorkflow — Generate + ForEach fan-out", () => {
  const gen = (values: unknown[]) => ({
    type: "Generate",
    id: "gen",
    name: "gen",
    rule: { kind: "Enumeration", values },
    output: { descriptor: "items", as: "List" },
  });
  const sweep = (maxIterations: number) => ({
    type: "Loop",
    id: "sweep",
    name: "sweep",
    mode: "ForEach",
    over: { expr: "nodes.gen.values.items" },
    maxIterations,
    body: { nodeDrafts: [suc("work")] },
    outputs: [
      { descriptor: "results", from: { node: "work", output: "out" }, aggregate: "Collect" },
    ],
  });
  // body executor echoes the current loop item as its output value
  const loopExec: NodeExecutor = async (node, ctx) =>
    node.id === "work"
      ? { status: "Succeeded", values: { out: (ctx as { loop?: { item?: unknown } }).loop?.item } }
      : { status: "Succeeded", values: {} };

  test("Generate produces a list and ForEach collects one result per item", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [gen([1, 2, 3]), sweep(100)],
        nodeRelations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
      }),
      loopExec,
    );
    expect(r.status.gen).toBe("Succeeded");
    expect(r.status.sweep).toBe("Succeeded");
    expect(r.values.sweep?.values.results).toEqual([1, 2, 3]);
  });

  test("Generate fails for Zip axes with mismatched lengths and cancels dependents", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          {
            type: "Generate",
            id: "badZip",
            name: "badZip",
            rule: {
              kind: "Zip",
              axes: [
                { name: "a", kind: "Enumeration", values: [1, 2, 3] },
                { name: "b", kind: "Enumeration", values: [10, 20] },
              ],
            },
            output: { descriptor: "items", as: "List" },
          },
          {
            ...sweep(100),
            over: { expr: "nodes.badZip.values.items" },
          },
        ],
        nodeRelations: [{ fromId: "badZip", toId: "sweep", slotRelations: [] }],
      }),
      loopExec,
    );

    expect(r.status.badZip).toBe("Failed");
    expect(r.status.sweep).toBe("Cancelled");
  });

  test("ForEach honors maxParallel while preserving index-ordered outputs", async () => {
    let active = 0;
    let maxActive = 0;
    const exec: NodeExecutor = async (node, ctx) => {
      if (node.id !== "work") {
        return { status: "Succeeded", values: {} };
      }
      const item = (ctx as { loop?: { item?: number } }).loop?.item ?? 0;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, item === 1 ? 30 : 5));
      active -= 1;
      return { status: "Succeeded", values: { out: item } };
    };

    const r = await runWorkflow(
      wf({
        nodeDrafts: [gen([1, 2, 3, 4]), { ...sweep(100), maxParallel: 2 }],
        nodeRelations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
      }),
      exec,
    );

    expect(r.status.sweep).toBe("Succeeded");
    expect(maxActive).toBe(2);
    expect(r.values.sweep?.values.results).toEqual([1, 2, 3, 4]);
  });

  test("ForEach preserves the failed iteration's job diagnostics", async () => {
    const exec: NodeExecutor = async (node, ctx) => {
      const item = (ctx as { loop?: { item?: number } }).loop?.item;
      if (node.id === "work" && item === 2) {
        return {
          status: "Failed",
          failure: { message: "LAMMPS input failed", jobId: "job-2", exitCode: 2 },
        };
      }
      return { status: "Succeeded", values: { out: item } };
    };

    const result = await runWorkflow(
      wf({
        nodeDrafts: [gen([1, 2, 3]), sweep(100)],
        nodeRelations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
      }),
      exec,
    );

    expect(result.values.sweep?.failure).toEqual({
      message: "ForEach iteration 1, node 'work': LAMMPS input failed",
      jobId: "job-2",
      exitCode: 2,
    });
  });

  test("ForEach fails when the list exceeds maxIterations", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [gen([1, 2, 3]), sweep(2)],
        nodeRelations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
      }),
      loopExec,
    );
    expect(r.status.sweep).toBe("Failed");
  });

  test("ForEach over an empty list succeeds with empty collected outputs", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [gen([]), sweep(100)],
        nodeRelations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
      }),
      loopExec,
    );
    expect(r.status.sweep).toBe("Succeeded");
    expect(r.values.sweep?.values.results).toEqual([]);
  });

  test("ForEach fails when a declared body output is absent", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [gen([1]), sweep(100)],
        nodeRelations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
      }),
      okExecutor({ work: {} }),
    );

    expect(r.status.sweep).toBe("Failed");
    expect(r.values.sweep?.values.results).toBeUndefined();
  });

  test("ForEach fails when over does not evaluate to a list", async () => {
    const r = await runWorkflow(
      wf(
        {
          nodeDrafts: [
            {
              ...sweep(100),
              over: { expr: "params.scalar" },
            },
          ],
          nodeRelations: [],
        },
        [{ name: "scalar", type: "int", default: 42 }],
      ),
      loopExec,
    );
    expect(r.status.sweep).toBe("Failed");
  });

  test("ForEach over expression errors fail the loop instead of rejecting the run", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          {
            ...sweep(100),
            over: { expr: "ghost.items" },
          },
        ],
      }),
      loopExec,
    );

    expect(r.status.sweep).toBe("Failed");
  });

  test("maxIterations expression errors fail the loop instead of rejecting the run", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          gen([1]),
          {
            ...sweep(100),
            maxIterations: { expr: "ghost.limit" },
          },
        ],
        nodeRelations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
      }),
      loopExec,
    );

    expect(r.status.sweep).toBe("Failed");
  });

  test("maxIterations expression resolving to a non-integer fails the loop", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          gen([1]),
          {
            ...sweep(100),
            maxIterations: { expr: "1.5" },
          },
        ],
        nodeRelations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
      }),
      loopExec,
    );

    expect(r.status.sweep).toBe("Failed");
  });

  test("maxIterations expression resolving to zero fails even for empty ForEach input", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          gen([]),
          {
            ...sweep(100),
            maxIterations: { expr: "0" },
          },
        ],
        nodeRelations: [{ fromId: "gen", toId: "sweep", slotRelations: [] }],
      }),
      loopExec,
    );

    expect(r.status.sweep).toBe("Failed");
  });
});

describe("runWorkflow — While convergence", () => {
  const whileLoop = (until: string, maxIterations: number, onExhausted: string) => ({
    type: "Loop",
    id: "loop",
    name: "loop",
    mode: "While",
    until: { expr: until },
    maxIterations,
    onExhausted,
    body: { nodeDrafts: [suc("solve")] },
    outputs: [{ descriptor: "finalResidual", from: { node: "solve", output: "residual" } }],
  });
  // residual decreases 1, 1/2, 1/3, ... with the iteration index
  const conv: NodeExecutor = async (node, ctx) =>
    node.id === "solve"
      ? {
          status: "Succeeded",
          values: {
            residual: 1 / (((ctx as { loop?: { iteration?: number } }).loop?.iteration ?? 0) + 1),
          },
        }
      : { status: "Succeeded", values: {} };

  test("stops once `until` is satisfied and exposes the last output", async () => {
    const r = await runWorkflow(
      wf({ nodeDrafts: [whileLoop("nodes.solve.values.residual <= 0.3", 100, "Fail")] }),
      conv,
    );
    expect(r.status.loop).toBe("Succeeded");
    expect((r.values.loop?.values.finalResidual as number) <= 0.3).toBe(true);
  });

  test("While preserves the failed iteration's job diagnostics", async () => {
    const exec: NodeExecutor = async () => ({
      status: "Failed",
      failure: { message: "Solver diverged", jobId: "job-while", exitCode: 9 },
    });

    const result = await runWorkflow(wf({ nodeDrafts: [whileLoop("false", 3, "Fail")] }), exec);

    expect(result.values.loop?.failure).toEqual({
      message: "While iteration 0, node 'solve': Solver diverged",
      jobId: "job-while",
      exitCode: 9,
    });
  });

  test("onExhausted=Fail when maxIterations is hit without convergence", async () => {
    const r = await runWorkflow(wf({ nodeDrafts: [whileLoop("false", 3, "Fail")] }), conv);
    expect(r.status.loop).toBe("Failed");
  });

  test("onExhausted=SucceedWithLast keeps the last iteration's result", async () => {
    const r = await runWorkflow(
      wf({ nodeDrafts: [whileLoop("false", 3, "SucceedWithLast")] }),
      conv,
    );
    expect(r.status.loop).toBe("Succeeded");
  });

  test("fails when a declared While body output is absent", async () => {
    const r = await runWorkflow(
      wf({ nodeDrafts: [whileLoop("true", 3, "Fail")] }),
      okExecutor({ solve: {} }),
    );

    expect(r.status.loop).toBe("Failed");
    expect(r.values.loop?.values.finalResidual).toBeUndefined();
  });

  test("until expression errors fail the While loop instead of rejecting the run", async () => {
    const r = await runWorkflow(
      wf({ nodeDrafts: [whileLoop("ghost.done == true", 3, "Fail")] }),
      conv,
    );

    expect(r.status.loop).toBe("Failed");
  });

  test("fails when a carry initial binding resolves to an absent output", async () => {
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: node.id === "solve" ? { field: "never" } : {} };
    };

    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          suc("prep"),
          {
            type: "Loop",
            id: "iterate",
            name: "iterate",
            mode: "While",
            maxIterations: 2,
            onExhausted: "Fail",
            until: { expr: "true" },
            carry: [
              {
                from: { node: "solve", output: "field" },
                to: { input: "fieldIn" },
                initial: { node: "prep", output: "missing" },
              },
            ],
            body: { nodeDrafts: [suc("solve")] },
            outputs: [{ descriptor: "finalField", from: { node: "solve", output: "field" } }],
          },
        ],
        nodeRelations: [{ fromId: "prep", toId: "iterate", slotRelations: [] }],
      }),
      exec,
    );

    expect(r.status.iterate).toBe("Failed");
    expect(called).toEqual(["prep"]);
  });

  test("fails when a carry source output is absent after an iteration", async () => {
    const called: number[] = [];
    const exec: NodeExecutor = async (node, ctx) => {
      if (node.id !== "solve") {
        return { status: "Succeeded", values: {} };
      }
      called.push((ctx as { loop?: { iteration?: number } }).loop?.iteration ?? -1);
      return { status: "Succeeded", values: { residual: 1 } };
    };

    const r = await runWorkflow(
      wf(
        {
          nodeDrafts: [
            {
              type: "Loop",
              id: "iterate",
              name: "iterate",
              mode: "While",
              maxIterations: 2,
              onExhausted: "Fail",
              until: { expr: "loop.iteration >= 1" },
              carry: [
                {
                  from: { node: "solve", output: "field" },
                  to: { input: "fieldIn" },
                  initial: { param: "seed" },
                },
              ],
              body: {
                nodeDrafts: [
                  suc("solve", {
                    inputSlots: [{ type: "Text", descriptor: "fieldIn", optional: false }],
                  }),
                ],
              },
              outputs: [
                { descriptor: "finalResidual", from: { node: "solve", output: "residual" } },
              ],
            },
          ],
        },
        [{ name: "seed", type: "string", default: "seed" }],
      ),
      exec,
    );

    expect(r.status.iterate).toBe("Failed");
    expect(called).toEqual([0]);
  });

  test("carry passes the initial value and then the previous iteration output into body inputs", async () => {
    const seenInputs: unknown[] = [];
    const seenBindings: unknown[] = [];
    const exec: NodeExecutor = async (node, ctx) => {
      const slot = "inputSlots" in node ? node.inputSlots?.[0] : undefined;
      seenBindings.push(slot?.from);
      const fieldIn = (ctx as { loop?: { carry?: { fieldIn?: unknown } } }).loop?.carry?.fieldIn;
      seenInputs.push(fieldIn);
      return { status: "Succeeded", values: { field: `${fieldIn}->${seenInputs.length}` } };
    };

    const r = await runWorkflow(
      wf(
        {
          nodeDrafts: [
            {
              type: "Loop",
              id: "iterate",
              name: "iterate",
              mode: "While",
              maxIterations: 4,
              onExhausted: "Fail",
              until: { expr: "loop.iteration >= 1" },
              carry: [
                {
                  from: { node: "solve", output: "field" },
                  to: { input: "fieldIn" },
                  initial: { param: "seed" },
                },
              ],
              body: {
                nodeDrafts: [
                  suc("solve", {
                    inputSlots: [{ type: "Text", descriptor: "fieldIn", optional: false }],
                  }),
                ],
              },
              outputs: [{ descriptor: "finalField", from: { node: "solve", output: "field" } }],
            },
          ],
        },
        [{ name: "seed", type: "string", default: "seed" }],
      ),
      exec,
    );

    expect(r.status.iterate).toBe("Succeeded");
    expect(r.values.iterate?.values.finalField).toBe("seed->1->2");
    expect(seenInputs).toEqual(["seed", "seed->1"]);
    expect(seenBindings).toEqual([{ expr: "loop.carry.fieldIn" }, { expr: "loop.carry.fieldIn" }]);
  });

  test("carry does not overwrite a frozen Dataset literal with the same descriptor", async () => {
    const seenSlots: unknown[] = [];
    const exec: NodeExecutor = async (node) => {
      const slot = "inputSlots" in node ? node.inputSlots?.[0] : undefined;
      seenSlots.push(slot);
      return { status: "Succeeded", values: { dataset: "next" } };
    };
    const dataset = {
      source: "data-market" as const,
      assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      selectedEntries: ["train/data.parquet"],
    };

    const result = await runWorkflow(
      wf(
        {
          nodeDrafts: [
            {
              type: "Loop",
              id: "iterate",
              name: "iterate",
              mode: "While",
              maxIterations: 1,
              onExhausted: "SucceedWithLast",
              until: { expr: "false" },
              carry: [
                {
                  from: { node: "solve", output: "dataset" },
                  to: { input: "trainingData" },
                  initial: { param: "seed" },
                },
              ],
              body: {
                nodeDrafts: [
                  suc("solve", {
                    inputSlots: [
                      {
                        type: "Dataset",
                        descriptor: "trainingData",
                        optional: false,
                        contents: dataset,
                      },
                    ],
                  }),
                ],
              },
            },
          ],
        },
        [{ name: "seed", type: "string", default: "seed" }],
      ),
      exec,
    );

    expect(result.status.iterate).toBe("Succeeded");
    expect(seenSlots).toHaveLength(1);
    expect(seenSlots[0]).toMatchObject({ type: "Dataset", contents: dataset });
    expect(seenSlots[0]).not.toHaveProperty("from");
  });
});

describe("runWorkflow — Reduce", () => {
  const genVals = (values: unknown[]) => ({
    type: "Generate",
    id: "gen",
    name: "gen",
    rule: { kind: "Enumeration", values },
    output: { descriptor: "items", as: "List" },
  });
  const sweepAll = {
    type: "Loop",
    id: "sweep",
    name: "sweep",
    mode: "ForEach",
    over: { expr: "nodes.gen.values.items" },
    maxIterations: 100,
    body: { nodeDrafts: [suc("work")] },
    outputs: [
      { descriptor: "results", from: { node: "work", output: "out" }, aggregate: "Collect" },
    ],
  };
  const reduce = (kind: string) => ({
    type: "Reduce",
    id: "gather",
    name: "gather",
    from: { loop: "sweep", output: "results" },
    reducer: { kind },
    output: { kind: "SingleFile", descriptor: "all" },
  });
  const echo: NodeExecutor = async (node, ctx) =>
    node.id === "work"
      ? { status: "Succeeded", values: { out: (ctx as { loop?: { item?: unknown } }).loop?.item } }
      : { status: "Succeeded", values: {} };

  test("Collect passes the gathered list through", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [genVals([1, 2, 3]), sweepAll, reduce("Collect")],
        nodeRelations: [
          { fromId: "gen", toId: "sweep", slotRelations: [] },
          { fromId: "sweep", toId: "gather", slotRelations: [] },
        ],
      }),
      echo,
    );
    expect(r.values.gather?.values.all).toEqual([1, 2, 3]);
  });

  test("Concat joins the gathered list", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [genVals(["a", "b"]), sweepAll, reduce("Concat")],
        nodeRelations: [
          { fromId: "gen", toId: "sweep", slotRelations: [] },
          { fromId: "sweep", toId: "gather", slotRelations: [] },
        ],
      }),
      echo,
    );
    expect(r.values.gather?.values.all).toBe("ab");
  });

  test("Concat fails on structured gathered values instead of stringifying them", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [genVals([{ item: "a" }]), sweepAll, reduce("Concat")],
        nodeRelations: [
          { fromId: "gen", toId: "sweep", slotRelations: [] },
          { fromId: "sweep", toId: "gather", slotRelations: [] },
        ],
      }),
      echo,
    );

    expect(r.status.gather).toBe("Failed");
    expect(r.values.gather?.values.all).toBeUndefined();
  });

  test("Collect over an empty ForEach output returns an empty list", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [genVals([]), sweepAll, reduce("Collect")],
        nodeRelations: [
          { fromId: "gen", toId: "sweep", slotRelations: [] },
          { fromId: "sweep", toId: "gather", slotRelations: [] },
        ],
      }),
      echo,
    );
    expect(r.status.sweep).toBe("Succeeded");
    expect(r.status.gather).toBe("Succeeded");
    expect(r.values.gather?.values.all).toEqual([]);
  });

  test("Reduce fails when the referenced loop output is absent", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          genVals([1]),
          sweepAll,
          {
            type: "Reduce",
            id: "gather",
            name: "gather",
            from: { loop: "sweep", output: "missing" },
            reducer: { kind: "Collect" },
            output: { kind: "SingleFile", descriptor: "all" },
          },
        ],
        nodeRelations: [
          { fromId: "gen", toId: "sweep", slotRelations: [] },
          { fromId: "sweep", toId: "gather", slotRelations: [] },
        ],
      }),
      echo,
    );
    expect(r.status.gather).toBe("Failed");
  });
});

describe("runWorkflow — SubWorkflow", () => {
  const inlineSub = (id: string, maxDepth: number, body: unknown, onDepthExceeded?: string) => ({
    type: "SubWorkflow",
    id,
    name: id,
    maxDepth,
    ...(onDepthExceeded === undefined ? {} : { onDepthExceeded }),
    ref: { kind: "Inline", body },
  });
  const byVersionSub = (
    id: string,
    workflowVersionId: string,
    over: Record<string, unknown> = {},
  ) => ({
    type: "SubWorkflow",
    id,
    name: id,
    maxDepth: 8,
    ref: { kind: "ByVersion", workflowVersionId },
    ...over,
  });

  test("runs an inline body to completion", async () => {
    const r = await runWorkflow(
      wf({ nodeDrafts: [inlineSub("sub", 8, { nodeDrafts: [suc("inner")] })] }),
      okExecutor(),
    );
    expect(r.status.sub).toBe("Succeeded");
  });

  test("preserves an inline child job's failure diagnostics", async () => {
    const result = await runWorkflow(
      wf({ nodeDrafts: [inlineSub("sub", 8, { nodeDrafts: [suc("inner")] })] }),
      async () => ({
        status: "Failed",
        failure: { message: "OpenFOAM floating point exception", jobId: "job-inner", exitCode: 8 },
      }),
    );

    expect(result.values.sub?.failure).toEqual({
      message: "Sub-workflow, node 'inner': OpenFOAM floating point exception",
      jobId: "job-inner",
      exitCode: 8,
    });
  });

  test("fails when recursion depth exceeds maxDepth", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          inlineSub("outer", 1, {
            nodeDrafts: [inlineSub("innerSub", 1, { nodeDrafts: [suc("x")] })],
          }),
        ],
      }),
      okExecutor(),
    );
    expect(r.status.outer).toBe("Failed");
  });

  test("can succeed with empty values when recursion depth exceeds maxDepth", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          inlineSub("outer", 8, {
            nodeDrafts: [inlineSub("innerSub", 1, { nodeDrafts: [suc("x")] }, "SucceedWithLast")],
          }),
        ],
      }),
      okExecutor(),
    );
    expect(r.status.outer).toBe("Succeeded");
    expect(r.values.outer?.values).toEqual({});
  });

  test("runs a ByVersion body through the resolver and maps declared outputs", async () => {
    const workflowVersionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const child = wf({ nodeDrafts: [suc("inner")] }, [
      { name: "region", type: "string", default: "default-region" },
    ]);
    const exec: NodeExecutor = async (node, ctx) =>
      node.id === "inner"
        ? {
            status: "Succeeded",
            values: { result: (ctx.params as Record<string, unknown>).region },
          }
        : { status: "Succeeded", values: {} };

    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          byVersionSub("sub", workflowVersionId, {
            inputs: [{ to: { param: "region" }, from: { expr: "'north'" } }],
            outputs: [{ descriptor: "refined", from: { workflowOutput: "result" } }],
          }),
        ],
      }),
      exec,
      { resolveWorkflowVersion: async () => child },
    );

    expect(r.status.sub).toBe("Succeeded");
    expect(r.values.sub?.values.refined).toBe("north");
  });

  test("uses ByVersion workflow parameter defaults when no input override is provided", async () => {
    const workflowVersionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const child = wf({ nodeDrafts: [suc("inner")] }, [
      { name: "region", type: "string", default: "default-region" },
    ]);
    const exec: NodeExecutor = async (node, ctx) =>
      node.id === "inner"
        ? {
            status: "Succeeded",
            values: { result: (ctx.params as Record<string, unknown>).region },
          }
        : { status: "Succeeded", values: {} };

    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          byVersionSub("sub", workflowVersionId, {
            outputs: [{ descriptor: "refined", from: { workflowOutput: "result" } }],
          }),
        ],
      }),
      exec,
      { resolveWorkflowVersion: async () => child },
    );

    expect(r.status.sub).toBe("Succeeded");
    expect(r.values.sub?.values.refined).toBe("default-region");
  });

  test("coerces ByVersion workflow parameter defaults before running the child", async () => {
    const workflowVersionId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const child = wf({ nodeDrafts: [suc("inner")] }, [
      { name: "limit", type: "int", default: "42" },
    ]);
    const exec: NodeExecutor = async (node, ctx) =>
      node.id === "inner"
        ? {
            status: "Succeeded",
            values: { result: (ctx.params as Record<string, unknown>).limit },
          }
        : { status: "Succeeded", values: {} };

    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          byVersionSub("sub", workflowVersionId, {
            outputs: [{ descriptor: "refined", from: { workflowOutput: "result" } }],
          }),
        ],
      }),
      exec,
      { resolveWorkflowVersion: async () => child },
    );

    expect(r.status.sub).toBe("Succeeded");
    expect(r.values.sub?.values.refined).toBe(42);
  });

  test("fails when a SubWorkflow input binding resolves to an absent output", async () => {
    const workflowVersionId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const child = wf({ nodeDrafts: [suc("inner")] }, [
      { name: "region", type: "string", default: "default-region" },
    ]);
    const called: string[] = [];
    const exec: NodeExecutor = async (node) => {
      called.push(node.id);
      return { status: "Succeeded", values: {} };
    };

    const r = await runWorkflow(
      wf({
        nodeDrafts: [
          suc("prepare"),
          byVersionSub("sub", workflowVersionId, {
            inputs: [{ to: { param: "region" }, from: { node: "prepare", output: "missing" } }],
            outputs: [{ descriptor: "refined", from: { workflowOutput: "result" } }],
          }),
        ],
        nodeRelations: [{ fromId: "prepare", toId: "sub", slotRelations: [] }],
      }),
      exec,
      { resolveWorkflowVersion: async () => child },
    );

    expect(r.status.prepare).toBe("Succeeded");
    expect(r.status.sub).toBe("Failed");
    expect(called).toEqual(["prepare"]);
  });

  test("fails a ByVersion node when no resolver is configured", async () => {
    const r = await runWorkflow(
      wf({
        nodeDrafts: [byVersionSub("sub", "dddddddd-dddd-dddd-dddd-dddddddddddd")],
      }),
      okExecutor(),
    );
    expect(r.status.sub).toBe("Failed");
  });
});

describe("runWorkflow — Reduce ExtractTable + Statistics", () => {
  const genVals = (values: unknown[]) => ({
    type: "Generate",
    id: "gen",
    name: "gen",
    rule: { kind: "Enumeration", values },
    output: { descriptor: "items", as: "List" },
  });
  const sweep = {
    type: "Loop",
    id: "sweep",
    name: "sweep",
    mode: "ForEach",
    over: { expr: "nodes.gen.values.items" },
    maxIterations: 100,
    body: { nodeDrafts: [suc("work")] },
    outputs: [
      { descriptor: "results", from: { node: "work", output: "out" }, aggregate: "Collect" },
    ],
  };
  const reduce = (
    reducer: unknown,
    output: unknown = { kind: "SingleFile", descriptor: "table" },
  ) => ({
    type: "Reduce",
    id: "gather",
    name: "gather",
    from: { loop: "sweep", output: "results" },
    reducer,
    output,
  });
  const run = (nodeDrafts: unknown[], exec: NodeExecutor) =>
    runWorkflow(
      wf({
        nodeDrafts,
        nodeRelations: [
          { fromId: "gen", toId: "sweep", slotRelations: [] },
          { fromId: "sweep", toId: "gather", slotRelations: [] },
        ],
      }),
      exec,
    );
  // `work` echoes the iteration item's `out` and surfaces a synthetic collected log.
  const compute: NodeExecutor = async (node, ctx) => {
    if (node.id !== "work") {
      return { status: "Succeeded", values: {} };
    }
    const item = (ctx as { loop?: { item?: Record<string, number> } }).loop?.item ?? {};
    return {
      status: "Succeeded",
      values: {
        out: (item.reynolds ?? 0) * 2,
        [NODE_COLLECTED_KEY]: { solverLog: `iter\nCl=${(item.reynolds ?? 0) / 100}\nend\n` },
      },
    };
  };

  test("ExtractTable with loopItem columns produces a CSV (header = column names, one row per iteration)", async () => {
    const r = await run(
      [
        genVals([
          { reynolds: 100, angle: 5 },
          { reynolds: 200, angle: 10 },
        ]),
        sweep,
        reduce({
          kind: "ExtractTable",
          columns: [
            { name: "reynolds", type: "double", source: { loopItem: "reynolds" } },
            { name: "angle", type: "double", source: { loopItem: "angle" } },
          ],
        }),
      ],
      compute,
    );
    expect(r.status.gather).toBe("Succeeded");
    expect(r.values.gather?.values.table).toBe("reynolds,angle\n100,5\n200,10\n");
  });

  test("ExtractTable with a NodeOutputRef column reads the per-iteration node output", async () => {
    const r = await run(
      [
        genVals([{ reynolds: 100 }, { reynolds: 200 }]),
        sweep,
        reduce({
          kind: "ExtractTable",
          columns: [{ name: "doubled", type: "double", source: { node: "work", output: "out" } }],
        }),
      ],
      compute,
    );
    expect(r.values.gather?.values.table).toBe("doubled\n200\n400\n");
  });

  test("ExtractTable with a collectedOut column applies the regex extractor to per-iteration log text", async () => {
    const requiredDescriptors: unknown[] = [];
    const inspectingCompute: NodeExecutor = async (node, ctx) => {
      if (node.id === "work") {
        requiredDescriptors.push(ctx[REQUIRED_COLLECTED_OUTPUTS_KEY]);
      }
      return compute(node, ctx);
    };
    const r = await run(
      [
        genVals([{ reynolds: 100 }, { reynolds: 250 }]),
        sweep,
        reduce({
          kind: "ExtractTable",
          columns: [
            {
              name: "cl",
              type: "double",
              source: { collectedOut: "solverLog" },
              extract: { kind: "Regex", pattern: "Cl=([0-9.]+)", group: 1 },
            },
          ],
        }),
      ],
      inspectingCompute,
    );
    expect(r.values.gather?.values.table).toBe("cl\n1\n2.5\n");
    expect(requiredDescriptors).toEqual([["solverLog"], ["solverLog"]]);
  });

  test("scopes collectedOut requirements to the Loop referenced by Reduce", async () => {
    const requiredByNode: Record<string, unknown[]> = {};
    const inspectingCompute: NodeExecutor = async (node, ctx) => {
      const required = requiredByNode[node.id] ?? [];
      required.push(ctx[REQUIRED_COLLECTED_OUTPUTS_KEY]);
      requiredByNode[node.id] = required;
      return {
        status: "Succeeded",
        values: {
          out: 1,
          [NODE_COLLECTED_KEY]: { solverLog: "Cl=1\n" },
        },
      };
    };
    const loop = (id: string, workId: string) => ({
      ...sweep,
      id,
      name: id,
      body: { nodeDrafts: [suc(workId)] },
      outputs: [
        { descriptor: "results", from: { node: workId, output: "out" }, aggregate: "Collect" },
      ],
    });
    const gatherA = {
      ...reduce({
        kind: "ExtractTable",
        columns: [
          {
            name: "cl",
            type: "double",
            source: { collectedOut: "solverLog" },
            extract: { kind: "Regex", pattern: "Cl=([0-9.]+)", group: 1 },
          },
        ],
      }),
      from: { loop: "sweepA", output: "results" },
    };

    const result = await runWorkflow(
      wf({
        nodeDrafts: [genVals([1]), loop("sweepA", "workA"), loop("sweepB", "workB"), gatherA],
        nodeRelations: [
          { fromId: "gen", toId: "sweepA", slotRelations: [] },
          { fromId: "gen", toId: "sweepB", slotRelations: [] },
          { fromId: "sweepA", toId: "gather", slotRelations: [] },
        ],
      }),
      inspectingCompute,
    );

    expect(result.status.gather).toBe("Succeeded");
    expect(requiredByNode.workA).toEqual([["solverLog"]]);
    expect(requiredByNode.workB).toEqual([[]]);
  });

  test("Statistics computes metrics over a loop output series", async () => {
    const r = await run(
      [
        genVals([{ reynolds: 50 }, { reynolds: 100 }, { reynolds: 150 }, { reynolds: 200 }]),
        sweep,
        reduce({ kind: "Statistics", over: "results", metrics: ["mean", "min", "max", "median"] }),
      ],
      compute,
    );
    // out = reynolds*2 → [100,200,300,400]; mean 250, min 100, max 400, median 250
    expect(r.values.gather?.values.table).toBe(
      "metric,value\nmean,250\nmin,100\nmax,400\nmedian,250\n",
    );
  });

  test("Statistics over an empty loop output fails instead of emitting NaN", async () => {
    const r = await run(
      [genVals([]), sweep, reduce({ kind: "Statistics", over: "results", metrics: ["mean"] })],
      compute,
    );

    expect(r.status.gather).toBe("Failed");
    expect(r.values.gather?.values).toEqual({});
  });

  test("Statistics over a non-finite loop output fails instead of emitting Infinity", async () => {
    const r = await run(
      [
        genVals([{ reynolds: Number.POSITIVE_INFINITY }]),
        sweep,
        reduce({ kind: "Statistics", over: "results", metrics: ["mean"] }),
      ],
      compute,
    );

    expect(r.status.gather).toBe("Failed");
    expect(r.values.gather?.values).toEqual({});
  });

  test("reserved per-iteration keys ($rows/$collected) are stripped from the persisted result", async () => {
    const r = await run(
      [
        genVals([{ reynolds: 100 }]),
        sweep,
        reduce({
          kind: "ExtractTable",
          columns: [{ name: "r", type: "double", source: { loopItem: "reynolds" } }],
        }),
      ],
      compute,
    );
    expect(Object.keys(r.values.sweep?.values ?? {})).not.toContain("$rows");
    // a top-level leaf's surfaced collected bundle is also stripped
    const top = await runWorkflow(wf({ nodeDrafts: [suc("solo")] }), async () => ({
      status: "Succeeded",
      values: { metric: 1, [NODE_COLLECTED_KEY]: { log: "x" } },
    }));
    expect(top.values.solo?.values.metric).toBe(1);
    expect(Object.keys(top.values.solo?.values ?? {})).not.toContain(NODE_COLLECTED_KEY);
  });
});
