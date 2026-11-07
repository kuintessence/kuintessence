import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../utils/canonical-json";
import { WorkflowSchema } from "../workflow-dsl";
import { NODE_COLLECTED_KEY, type NodeExecutor, runWorkflow } from "./engine";
import {
  WorkflowExecutionInterrupted,
  WorkflowExecutionWaiting,
  type WorkflowJournal,
  type WorkflowJournalEntry,
  WorkflowNodeWaiting,
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

describe("durable external waiting", () => {
  test("checkpoints independent branches and leaves waiting descendants unfinished", async () => {
    const { journal, entries } = memoryJournal();
    const definition = wf(
      [work("remote"), work("independent"), work("downstream"), work("tail")],
      [edge("remote", "downstream"), edge("downstream", "tail")],
    );
    let ready = false;
    const calls: string[] = [];
    const executor: NodeExecutor = async (node) => {
      calls.push(node.id);
      if (node.id === "remote" && !ready) throw new WorkflowNodeWaiting("REMOTE_WAITING");
      return { status: "Succeeded", values: { out: 7 } };
    };
    await expect(runWorkflow(definition, executor, { journal })).rejects.toMatchObject({
      invocations: [{ path: JSON.stringify(["node", "remote"]), reason: "REMOTE_WAITING" }],
      retryable: true,
    });
    expect(calls).toEqual(["remote", "independent"]);
    expect(entries.has(JSON.stringify(["node", "remote"]))).toBe(false);
    expect(entries.has(JSON.stringify(["node", "downstream"]))).toBe(false);
    ready = true;
    const result = await runWorkflow(definition, executor, { journal });
    expect(result.status).toEqual({
      remote: "Succeeded",
      independent: "Succeeded",
      downstream: "Succeeded",
      tail: "Succeeded",
    });
    expect(calls).toEqual(["remote", "independent", "remote", "downstream", "tail"]);
  });

  test("ForEach retains waiting concurrency slots, completes siblings and restores each dynamic invocation", async () => {
    const { journal } = memoryJournal();
    const definition = wf([loop([work("work"), work("sibling")], 2), work("outside")]);
    const calls: string[] = [];
    const ready = new Set<number>();
    const executor: NodeExecutor = async (node, ctx, invocation) => {
      const index = (ctx.loop as { index?: number } | undefined)?.index;
      calls.push(invocation?.path ?? "missing");
      if (node.id === "work" && index !== undefined && !ready.has(index))
        throw new WorkflowNodeWaiting("DATA_WAITING");
      return { status: "Succeeded", values: { out: index ?? 0 } };
    };
    const path = (i: number, id = "work") =>
      JSON.stringify(["node", "loop", "iteration", i, "node", id]);
    await expect(runWorkflow(definition, executor, { journal })).rejects.toBeInstanceOf(
      WorkflowExecutionWaiting,
    );
    expect(calls).toContain(path(0));
    expect(calls).toContain(path(1));
    expect(calls).not.toContain(path(2));
    expect(calls).toContain(path(0, "sibling"));
    expect(calls).toContain(JSON.stringify(["node", "outside"]));
    ready.add(0);
    await expect(runWorkflow(definition, executor, { journal })).rejects.toBeInstanceOf(
      WorkflowExecutionWaiting,
    );
    expect(calls).toContain(path(2));
    ready.add(1);
    ready.add(2);
    const result = await runWorkflow(definition, executor, { journal });
    expect(result.values.loop?.values.all).toEqual([0, 1, 2]);
    for (let i = 0; i < 3; i++)
      expect(calls.filter((value) => value === path(i, "sibling"))).toHaveLength(1);
    expect(calls.filter((value) => value === JSON.stringify(["node", "outside"]))).toHaveLength(1);
  });

  test("nested SubWorkflow While and Switch preserve paths and never choose branches from missing results", async () => {
    const { journal } = memoryJournal();
    const definition = wf([
      {
        id: "sub",
        name: "sub",
        type: "SubWorkflow",
        maxDepth: 2,
        ref: {
          kind: "Inline",
          body: {
            nodeDrafts: [
              {
                id: "while",
                name: "while",
                type: "Loop",
                mode: "While",
                maxIterations: 3,
                until: { expr: "nodes.work.values.out == 2" },
                body: { nodeDrafts: [work("work")] },
                outputs: [{ descriptor: "last", from: { node: "work", output: "out" } }],
              },
              {
                id: "choose",
                name: "choose",
                type: "Switch",
                cases: [{ when: { expr: "nodes.while.values.last == 2" }, to: "yes" }],
                default: "no",
              },
              work("yes"),
              work("no"),
              work("innerSibling"),
            ],
            nodeRelations: [edge("while", "choose")],
          },
        },
      },
      work("outside"),
    ]);
    let ready = false;
    const calls: string[] = [];
    const executor: NodeExecutor = async (node, ctx, invocation) => {
      calls.push(invocation?.path ?? "missing");
      const iteration = (ctx.loop as { iteration?: number } | undefined)?.iteration;
      if (node.id === "work" && iteration === 1 && !ready)
        throw new WorkflowNodeWaiting("RESULT_WAITING");
      return { status: "Succeeded", values: { out: (iteration ?? 0) + 1 } };
    };
    const expectedPath = JSON.stringify([
      "node",
      "sub",
      "subworkflow",
      "node",
      "while",
      "iteration",
      1,
      "node",
      "work",
    ]);
    await expect(runWorkflow(definition, executor, { journal })).rejects.toMatchObject({
      invocations: [{ path: expectedPath, reason: "RESULT_WAITING" }],
    });
    expect(calls.some((path) => path.endsWith('"yes"]'))).toBe(false);
    expect(calls.some((path) => path.endsWith('"no"]'))).toBe(false);
    ready = true;
    expect((await runWorkflow(definition, executor, { journal })).status.sub).toBe("Succeeded");
    expect(calls.filter((path) => path.endsWith('"innerSibling"]'))).toHaveLength(1);
    expect(calls.filter((path) => path.endsWith('"outside"]'))).toHaveLength(1);
    expect(calls.filter((path) => path.endsWith('"yes"]'))).toHaveLength(1);
    expect(calls.some((path) => path.endsWith('"no"]'))).toBe(false);
  });

  test("input references wait without being checkpointed as skipped and infrastructure loss still halts work", async () => {
    const { journal, entries } = memoryJournal();
    const definition = wf([
      work("remote"),
      {
        ...work("consumer"),
        inputSlots: [{ type: "Text", descriptor: "in", from: { node: "remote", output: "out" } }],
      },
      work("database"),
      work("after"),
    ]);
    const calls: string[] = [];
    await expect(
      runWorkflow(
        definition,
        async (node) => {
          calls.push(node.id);
          if (node.id === "remote") throw new WorkflowNodeWaiting("LEDGER_WAITING");
          if (node.id === "database")
            throw new WorkflowExecutionInterrupted("Database unavailable");
          return { status: "Succeeded" };
        },
        { journal },
      ),
    ).rejects.toThrow("Database unavailable");
    expect(calls).toEqual(["remote", "database"]);
    expect(entries.has(JSON.stringify(["node", "consumer"]))).toBe(false);
    await expect(
      runWorkflow(wf([work("remote")]), async () => {
        throw new WorkflowNodeWaiting("REMOTE_WAITING");
      }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
