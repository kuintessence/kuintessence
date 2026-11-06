import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../utils/canonical-json";
import { WorkflowSchema } from "../workflow-dsl";
import { NODE_COLLECTED_KEY, type NodeExecutor, runWorkflow } from "./engine";
import {
  WorkflowExecutionInterrupted,
  type WorkflowJournal,
  type WorkflowJournalEntry,
} from "./journal";

const work = (id: string) => ({ id, name: id, type: "NoAction" });
const wf = (nodes: unknown[], relations: unknown[] = []) =>
  WorkflowSchema.parse({
    name: "Journal test",
    parameters: [],
    spec: { nodeDrafts: nodes, nodeRelations: relations },
  });
const edge = (fromId: string, toId: string) => ({ fromId, toId, slotRelations: [] });
const loop = (body = [work("work")], maxParallel = 1) => ({
  id: "loop",
  name: "loop",
  type: "Loop",
  mode: "ForEach",
  over: { expr: "[10, 20, 30]" },
  maxIterations: 3,
  maxParallel,
  body: { nodeDrafts: body },
  outputs: [{ descriptor: "all", from: { node: "work", output: "out" }, aggregate: "Collect" }],
});

function memoryJournal() {
  const entries = new Map<string, WorkflowJournalEntry>();
  const journal: WorkflowJournal = {
    read: async (key) => structuredClone(entries.get(key) ?? null),
    write: async (key, entry) => {
      const saved = entries.get(key);
      if (saved && canonicalJson(saved) !== canonicalJson(entry)) throw new Error("immutable");
      entries.set(key, structuredClone(entry));
    },
  };
  return { journal, entries };
}

describe("workflow durable journal", () => {
  test("restores completed leaves and Switch choice without rerunning effects", async () => {
    const { journal } = memoryJournal();
    const definition = wf(
      [
        work("input"),
        {
          id: "choose",
          name: "choose",
          type: "Switch",
          cases: [{ when: { expr: "nodes.input.values.ok" }, to: "yes" }],
          default: "no",
        },
        work("yes"),
        work("no"),
      ],
      [edge("input", "choose")],
    );
    const calls: string[] = [];
    let stop = true;
    const executor: NodeExecutor = async (node) => {
      if (node.id === "yes" && stop) throw new WorkflowExecutionInterrupted("restart");
      calls.push(node.id);
      return { status: "Succeeded", values: { ok: true } };
    };
    await expect(runWorkflow(definition, executor, { journal })).rejects.toThrow("restart");
    stop = false;
    const result = await runWorkflow(definition, executor, { journal });
    expect(calls).toEqual(["input", "yes"]);
    expect(result.status).toEqual({
      input: "Succeeded",
      choose: "Succeeded",
      yes: "Succeeded",
      no: "Skipped",
    });
  });

  test("ForEach resumes partial iterations and preserves collected text for Reduce", async () => {
    const { journal } = memoryJournal();
    const definition = wf(
      [
        loop(),
        {
          id: "table",
          name: "table",
          type: "Reduce",
          from: { loop: "loop", output: "all" },
          reducer: {
            kind: "ExtractTable",
            columns: [{ name: "text", type: "string", source: { collectedOut: "log" } }],
          },
          output: { kind: "SingleFile", descriptor: "csv" },
        },
      ],
      [edge("loop", "table")],
    );
    const calls: string[] = [];
    let stop = true;
    const executor: NodeExecutor = async (_node, ctx, invocation) => {
      const { index, item } = ctx.loop as { index: number; item: number };
      if (index === 1 && stop) throw new WorkflowExecutionInterrupted("restart");
      calls.push(invocation?.path ?? "missing");
      return {
        status: "Succeeded",
        values: { out: item, [NODE_COLLECTED_KEY]: { log: String(item) } },
      };
    };
    await expect(runWorkflow(definition, executor, { journal })).rejects.toThrow("restart");
    stop = false;
    const result = await runWorkflow(definition, executor, { journal });
    expect(calls).toEqual(
      [0, 1, 2].map((i) => JSON.stringify(["node", "loop", "iteration", i, "node", "work"])),
    );
    expect(result.values.table?.values.csv).toBe("text\n10\n20\n30\n");
    expect(result.values.loop?.values).toEqual({ all: [10, 20, 30] });
  });

  test("While reconstructs previous outputs without replaying finished iterations", async () => {
    const { journal } = memoryJournal();
    const definition = wf([
      {
        id: "loop",
        name: "loop",
        type: "Loop",
        mode: "While",
        maxIterations: 4,
        until: { expr: "nodes.work.values.out >= 3" },
        body: { nodeDrafts: [work("work")] },
        outputs: [{ descriptor: "out", from: { node: "work", output: "out" } }],
      },
    ]);
    const calls: number[] = [];
    let stop = true;
    const executor: NodeExecutor = async (_node, ctx) => {
      const state = ctx.loop as { iteration: number; previous?: { values: { out: number } } };
      if (state.iteration === 1 && stop) throw new WorkflowExecutionInterrupted("restart");
      calls.push(state.iteration);
      return { status: "Succeeded", values: { out: (state.previous?.values.out ?? 0) + 1 } };
    };
    await expect(runWorkflow(definition, executor, { journal })).rejects.toThrow("restart");
    stop = false;
    const result = await runWorkflow(definition, executor, { journal });
    expect(calls).toEqual([0, 1, 2]);
    expect(result.values.loop?.values.out).toBe(3);
  });

  test("pins referenced definitions and separates repeated sub-workflow invocations", async () => {
    const { journal } = memoryJournal();
    const sub = (id: string) => ({
      id,
      name: id,
      type: "SubWorkflow",
      maxDepth: 4,
      ref: { kind: "ByVersion", workflowVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    });
    const definition = wf([sub("a"), sub("b")]);
    let resolved = 0;
    let stop = true;
    const paths: string[] = [];
    const executor: NodeExecutor = async (node, _ctx, invocation) => {
      if (node.id === "end" && stop) throw new WorkflowExecutionInterrupted("restart");
      paths.push(invocation?.path ?? "missing");
      return { status: "Succeeded" };
    };
    const resolveWorkflowVersion = async () => {
      resolved++;
      return wf([work("start"), work("end")]);
    };
    await expect(
      runWorkflow(definition, executor, { journal, resolveWorkflowVersion }),
    ).rejects.toThrow("restart");
    stop = false;
    const result = await runWorkflow(definition, executor, {
      journal,
      resolveWorkflowVersion: async () => {
        throw new Error("live template changed");
      },
    });
    expect(result.status).toEqual({ a: "Succeeded", b: "Succeeded" });
    expect(resolved).toBe(1);
    expect(paths).toEqual(
      ["a", "b"].flatMap((id) =>
        ["start", "end"].map((nodeId) =>
          JSON.stringify(["node", id, "subworkflow", "node", nodeId]),
        ),
      ),
    );
  });

  test("rejects changed input definitions before executing any resumed step", async () => {
    const { journal } = memoryJournal();
    await runWorkflow(wf([work("a")]), async () => ({ status: "Succeeded" }), { journal });
    let executed = false;
    await expect(
      runWorkflow(
        wf([work("b")]),
        async () => {
          executed = true;
          return { status: "Succeeded" };
        },
        { journal },
      ),
    ).rejects.toThrow("definition changed");
    expect(executed).toBe(false);
  });

  test("failed checkpoint writes never become Failed node results", async () => {
    for (const nodes of [
      [work("a")],
      [
        {
          id: "a",
          name: "a",
          type: "Generate",
          rule: { kind: "Enumeration", values: [1] },
          output: { descriptor: "items", as: "List" },
        },
      ],
    ]) {
      const { journal, entries } = memoryJournal();
      const write = journal.write;
      journal.write = async (key, entry) => {
        if (entry.kind === "node") throw new Error("database unavailable");
        await write(key, entry);
      };
      await expect(
        runWorkflow(wf(nodes), async () => ({ status: "Succeeded" }), { journal }),
      ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
      expect([...entries.values()].some((entry) => entry.kind === "node")).toBe(false);
    }
  });

  test("an in-flight checkpoint read cannot start a new effect after a sibling interrupts", async () => {
    const { journal } = memoryJournal();
    let releaseRead: () => void = () => {};
    const pendingRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let announceRead: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    const read = journal.read;
    journal.read = async (key) => {
      if (key === JSON.stringify(["node", "loop", "iteration", 1, "node", "work"])) {
        announceRead();
        await pendingRead;
      }
      return read(key);
    };
    const calls: number[] = [];
    const result = runWorkflow(
      wf([loop(undefined, 2)]),
      async (_node, ctx) => {
        const { index } = ctx.loop as { index: number };
        calls.push(index);
        await readStarted;
        throw new WorkflowExecutionInterrupted("checkpoint failure in sibling");
      },
      { journal },
    );
    const caught = result.then(
      () => null,
      (error: unknown) => error,
    );
    await readStarted;
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseRead();
    expect(await caught).toBeInstanceOf(WorkflowExecutionInterrupted);
    expect(calls).toEqual([0]);
  });

  test("transient sub-workflow resolution failure leaves the invocation resumable", async () => {
    const { journal } = memoryJournal();
    const definition = wf([
      {
        id: "sub",
        name: "sub",
        type: "SubWorkflow",
        maxDepth: 4,
        ref: { kind: "ByVersion", workflowVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      },
    ]);
    const executor: NodeExecutor = async () => ({ status: "Succeeded" });
    await expect(
      runWorkflow(definition, executor, {
        journal,
        resolveWorkflowVersion: async () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
    const result = await runWorkflow(definition, executor, {
      journal,
      resolveWorkflowVersion: async () => wf([work("child")]),
    });
    expect(result.status.sub).toBe("Succeeded");
  });

  test("concurrent ForEach drains active siblings and stops scheduling new iterations on interruption", async () => {
    let releaseSibling: () => void = () => {};
    const sibling = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let announceSibling: () => void = () => {};
    const siblingStarted = new Promise<void>((resolve) => {
      announceSibling = resolve;
    });
    const calls: number[] = [];
    let finished = false;
    const result = runWorkflow(wf([loop([work("work"), work("after")], 2)]), async (_node, ctx) => {
      const { index } = ctx.loop as { index: number };
      calls.push(index);
      if (index === 0) {
        await siblingStarted;
        throw new WorkflowExecutionInterrupted("lease lost");
      }
      announceSibling();
      await sibling;
      finished = true;
      return { status: "Succeeded", values: { out: index } };
    });
    const caught = result.then(
      () => null,
      (error: unknown) => error,
    );
    await siblingStarted;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finished).toBe(false);
    releaseSibling();
    expect(await caught).toBeInstanceOf(WorkflowExecutionInterrupted);
    expect(finished).toBe(true);
    expect(calls).toEqual([0, 1]);
  });
});
