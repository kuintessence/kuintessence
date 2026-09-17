import { describe, expect, test } from "bun:test";
import { WorkflowNodeSchema, WorkflowSpecSchema } from "./node";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const suc = (id: string) => ({
  type: "SoftwareUsecaseComputing",
  id,
  name: id,
  usecaseVersionId: UUID,
  softwareVersionId: UUID,
});

describe("WorkflowNodeSchema — node variants", () => {
  test("accepts a SoftwareUsecaseComputing node", () => {
    expect(WorkflowNodeSchema.parse(suc("solve")).type).toBe("SoftwareUsecaseComputing");
  });

  test("accepts name references but rejects mixing them with UUID references", () => {
    const named = WorkflowNodeSchema.parse({
      type: "SoftwareUsecaseComputing",
      id: "solve",
      name: "solve",
      usecaseRef: { source: "official-upstream", name: "gromacs-mdp", version: "1.0.0" },
      softwareRef: { source: "official-upstream", name: "gromacs", version: "2025.2" },
    });
    expect(named.type).toBe("SoftwareUsecaseComputing");
    expect(() => WorkflowNodeSchema.parse({ ...named, usecaseVersionId: UUID })).toThrow();
  });

  test("accepts a Generate node", () => {
    const r = WorkflowNodeSchema.parse({
      type: "Generate",
      id: "gen",
      name: "gen",
      rule: { kind: "Enumeration", values: [1, 2] },
      output: { descriptor: "list", as: "List" },
    });
    expect(r.type).toBe("Generate");
  });

  test("accepts a Switch node", () => {
    const r = WorkflowNodeSchema.parse({
      type: "Switch",
      id: "pick",
      name: "pick",
      cases: [{ when: { expr: "x < 1" }, to: "small" }],
      default: "large",
    });
    expect(r.type).toBe("Switch");
  });

  test("rejects a hyphenated node id", () => {
    expect(() => WorkflowNodeSchema.parse({ ...suc("a"), id: "a-b" })).toThrow();
  });

  test("accepts an optional externalId UUID alongside the slug id", () => {
    expect(WorkflowNodeSchema.parse({ ...suc("solve"), externalId: UUID }).type).toBe(
      "SoftwareUsecaseComputing",
    );
  });

  test("rejects Dataset inputs on nodes that cannot deliver them", () => {
    const inputSlots = [{ type: "Dataset", descriptor: "trainingData" }];
    expect(() =>
      WorkflowNodeSchema.parse({ type: "NoAction", id: "noop", name: "noop", inputSlots }),
    ).toThrow("Dataset input slots are only supported on SoftwareUsecaseComputing nodes");
    expect(() =>
      WorkflowNodeSchema.parse({
        type: "Script",
        id: "script",
        name: "script",
        source: {
          type: "AssetRevision",
          assetId: UUID,
          revision: 1,
          sha256: "a".repeat(64),
        },
        runtimeProfileId: UUID,
        inputSlots,
      }),
    ).toThrow("Dataset input slots are only supported on SoftwareUsecaseComputing nodes");
  });
});

describe("WorkflowNodeSchema — Loop (bounded, recursive body)", () => {
  const body = { nodeDrafts: [suc("inner")] };

  test("accepts a While loop with until", () => {
    const r = WorkflowNodeSchema.parse({
      type: "Loop",
      id: "iter",
      name: "iter",
      mode: "While",
      maxIterations: 100,
      until: { expr: "nodes.inner.values.r <= 1e-5" },
      body,
    });
    expect(r.type).toBe("Loop");
  });

  test("rejects a While loop missing until", () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        type: "Loop",
        id: "i",
        name: "i",
        mode: "While",
        maxIterations: 5,
        body,
      }),
    ).toThrow();
  });

  test("accepts a ForEach loop with over", () => {
    const r = WorkflowNodeSchema.parse({
      type: "Loop",
      id: "sweep",
      name: "sweep",
      mode: "ForEach",
      over: { expr: "nodes.gen.values.list" },
      maxIterations: 5000,
      body,
    });
    expect(r.type).toBe("Loop");
  });

  test("rejects a ForEach loop missing over", () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        type: "Loop",
        id: "s",
        name: "s",
        mode: "ForEach",
        maxIterations: 5,
        body,
      }),
    ).toThrow();
  });

  test("rejects a ForEach loop with maxParallel=0", () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        type: "Loop",
        id: "s",
        name: "s",
        mode: "ForEach",
        over: { expr: "[]" },
        maxIterations: 5,
        maxParallel: 0,
        body,
      }),
    ).toThrow();
  });
});

describe("WorkflowNodeSchema — SubWorkflow recursion", () => {
  test("accepts an inline sub-workflow body", () => {
    const r = WorkflowNodeSchema.parse({
      type: "SubWorkflow",
      id: "refine",
      name: "refine",
      maxDepth: 8,
      ref: { kind: "Inline", body: { nodeDrafts: [suc("innerSolve")] } },
    });
    expect(r.type).toBe("SubWorkflow");
  });
});

describe("WorkflowSpecSchema", () => {
  test("defaults nodeRelations to an empty array", () => {
    const r = WorkflowSpecSchema.parse({ nodeDrafts: [suc("only")] });
    expect(r.nodeRelations).toEqual([]);
  });
});
