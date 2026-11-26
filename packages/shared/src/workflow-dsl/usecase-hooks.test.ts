import { describe, expect, test } from "bun:test";
import { runWorkflow } from "../workflow/engine";
import { WorkflowExecutionInterrupted, type WorkflowJournalEntry } from "../workflow/journal";
import { createUsecaseExecutor } from "../workflow/usecase-executor";
import { validateWorkflow } from "./validate";
import { WorkflowSchema } from "./workflow";

const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const pinned = {
  source: { type: "AssetRevision", assetId: uuid, revision: 1, sha256: "a".repeat(64) },
  runtimeProfileId: uuid,
};
const hooks = {
  pre: { ...pinned, outputs: { data: { type: "JSON" } } },
  post: { ...pinned, inputs: { result: { type: "File" } }, outputs: { final: { type: "Text" } } },
};
const usecase = {
  name: "Process",
  id: "work",
  type: "SoftwareUsecaseComputing",
  softwareVersionId: uuid,
  usecaseVersionId: uuid,
  hooks,
  outputSlots: [{ type: "File", descriptor: "result", isBatch: false, origin: "UsecaseOut" }],
};
const after = {
  type: "NoAction",
  name: "After",
  id: "after",
  inputSlots: [{ type: "Text", descriptor: "answer", from: { node: "work", output: "final" } }],
};
const link = { fromId: "work", toId: "after", slotRelations: [] };
const parse = (nodes: unknown[], links: unknown[] = []) =>
  WorkflowSchema.parse({ name: "example", spec: { nodeDrafts: nodes, nodeRelations: links } });

describe("workflow usecase hooks", () => {
  test("materializes JSON input, publishes the main file and resumes at the post-hook", async () => {
    const workflow = parse([after, usecase]);
    expect(validateWorkflow(workflow)).toEqual([]);
    expect(WorkflowSchema.parse(JSON.parse(JSON.stringify(workflow)))).toEqual(workflow);
    const entries = new Map<string, WorkflowJournalEntry>();
    const journal = {
      read: async (key: string) => entries.get(key) ?? null,
      write: async (key: string, v: WorkflowJournalEntry) => {
        entries.set(key, v);
      },
    };
    const file = { fileMetadataId: uuid, fileMetadataName: "answer.txt" };
    const calls: string[] = [];
    let interrupt = true;
    const execute = createUsecaseExecutor({
      resolvePackage: async () => ({
        usecase: {
          commandFile: "process",
          inputSlots: [
            {
              kind: "Text",
              descriptor: "data",
              refMaterials: [{ kind: "ArgRef", descriptor: "data", sort: 0 }],
            },
          ],
        },
        software: { kind: "Bare" },
        arguments: [{ descriptor: "data", valueFormat: "{}" }],
        environments: [],
        filesomeInputs: [],
        filesomeOutputs: [
          { descriptor: "result", fileKind: { kind: "Normal", name: "answer.txt" } },
        ],
        valueOutputs: [],
      }),
      submitJob: async (spec) => {
        calls.push(spec.nodeId);
        expect(spec.command).toContain('{"count":2}');
        expect(spec.fileOutputDescriptors).toContain("result");
        return {
          jobId: "fixture-job",
          status: "completed",
          collected: {},
          collectedFiles: { result: file },
        };
      },
      executeScript: async (node, ctx) => {
        calls.push(node.id);
        if (node.id === "work__pre") return { status: "Succeeded", values: { data: { count: 2 } } };
        if (interrupt) {
          interrupt = false;
          throw new WorkflowExecutionInterrupted("restart");
        }
        expect(node.inputSlots?.[0]?.from).toEqual({ node: "work__main", output: "result" });
        expect(ctx.nodes).toMatchObject({ work__main: { values: { result: file } } });
        return { status: "Succeeded", values: { final: "accepted" } };
      },
    });
    await expect(runWorkflow(workflow, execute, { journal })).rejects.toThrow("restart");
    const result = await runWorkflow(workflow, execute, { journal });
    expect(result.status.after).toBe("Succeeded");
    expect(result.values.work?.values).toEqual({ final: "accepted" });
    expect(calls).toEqual(["work__pre", "work__main", "work", "work"]);
  });

  test("routes external conditions and switch selection to the first stage", async () => {
    const gate = { type: "NoAction", id: "gate", name: "Gate" };
    const choose = {
      type: "Switch",
      id: "choose",
      name: "Choose",
      cases: [{ when: { expr: "false" }, to: "work" }],
      default: "gate",
    };
    for (const workflow of [
      parse([choose, gate, usecase]),
      parse(
        [gate, usecase],
        [{ fromId: "gate", toId: "work", when: { expr: "false" }, slotRelations: [] }],
      ),
      parse([{ ...usecase, when: { expr: "false" } }]),
    ]) {
      const result = await runWorkflow(workflow, async (node) => {
        expect(["work__pre", "work__main", "work"]).not.toContain(node.id);
        return { status: "Succeeded" };
      });
      expect(result.status.work).toBe("Skipped");
    }
    const failed = await runWorkflow(parse([usecase, after], [link]), async () => ({
      status: "Failed",
    }));
    expect(failed.status).toMatchObject({
      work__pre: "Failed",
      work__main: "Cancelled",
      work: "Cancelled",
      after: "Cancelled",
    });
  });

  test("expands named hooks and rejects mixed script or runtime bindings", () => {
    const named = {
      scriptRef: { source: "platform-fork", name: "normalize", version: "2" },
      runtimeContractRef: { name: "python-3.12-stdlib-v1", version: "1" },
    };
    const withHook = (pre: unknown) => parse([{ ...usecase, hooks: { pre } }]);
    expect(withHook(named).spec.nodeDrafts[0]).toMatchObject({
      type: "Script",
      id: "work__pre",
      ...named,
    });
    for (const invalid of [
      { ...named, source: pinned.source },
      { ...named, runtimeProfileId: uuid },
      { scriptRef: named.scriptRef, runtimeProfileId: uuid },
      { source: pinned.source, runtimeContractRef: named.runtimeContractRef },
      { scriptRef: named.scriptRef },
    ]) {
      expect(() => withHook(invalid)).toThrow();
    }
  });

  test("expands one-sided hooks in nested scopes and rejects unsafe or ambiguous declarations", () => {
    const nested = parse([
      {
        type: "Loop",
        mode: "ForEach",
        name: "Each",
        id: "each",
        over: { expr: "[1]" },
        maxIterations: 1,
        body: { nodeDrafts: [{ ...usecase, hooks: { pre: pinned } }] },
      },
    ]);
    const loop = nested.spec.nodeDrafts[0];
    expect(loop?.type === "Loop" && loop.body.nodeDrafts.map((n) => n.id)).toEqual([
      "work__pre",
      "work",
    ]);
    expect(
      parse([{ ...usecase, hooks: { post: pinned } }]).spec.nodeDrafts.map((n) => n.id),
    ).toEqual(["work__main", "work"]);
    expect(() => parse([usecase, { ...after, id: "work__main" }])).toThrow("already in use");
    expect(() => parse([{ ...usecase, outputSlots: [] }])).toThrow("matching main output");
    expect(() =>
      parse([{ ...usecase, hooks: { pre: { ...pinned, inputs: { sample: { type: "Text" } } } } }]),
    ).toThrow("requires an input slot");
    expect(() =>
      parse([
        {
          ...usecase,
          hooks: {
            pre: { ...pinned, source: { type: "Inline", language: "bash", content: "true" } },
          },
        },
      ]),
    ).toThrow();
  });
});
