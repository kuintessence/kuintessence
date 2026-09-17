import { describe, expect, test } from "bun:test";
import { WorkflowSchema } from "./workflow";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const suc = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "SoftwareUsecaseComputing",
  id,
  name: id,
  usecaseVersionId: UUID,
  softwareVersionId: UUID,
  ...extra,
});

describe("WorkflowSchema — end-to-end compositions", () => {
  test("parses a scatter-gather workflow (Generate -> ForEach -> Reduce -> serial)", () => {
    const doc = {
      name: "sweep",
      spec: {
        nodeDrafts: [
          {
            type: "Generate",
            id: "genCases",
            name: "gen",
            rule: {
              kind: "CartesianProduct",
              axes: [
                { name: "reynolds", kind: "Enumeration", values: [100, 200] },
                { name: "angle", kind: "Range", start: 0, stop: 30, step: 10 },
              ],
            },
            output: { descriptor: "caseList", as: "List" },
          },
          {
            type: "Loop",
            id: "sweep",
            name: "sweep",
            mode: "ForEach",
            over: { expr: "nodes.genCases.values.caseList" },
            maxParallel: 32,
            maxIterations: 5000,
            body: {
              nodeDrafts: [
                suc("render", {
                  inputSlots: [{ type: "Text", descriptor: "p", from: { expr: "loop.item" } }],
                  outputSlots: [
                    { type: "File", descriptor: "caseFile", origin: "UsecaseOut", isBatch: false },
                  ],
                }),
                suc("solveOne", {
                  outputSlots: [
                    { type: "File", descriptor: "result", origin: "UsecaseOut", isBatch: false },
                  ],
                }),
              ],
              nodeRelations: [
                {
                  fromId: "render",
                  toId: "solveOne",
                  slotRelations: [
                    { fromSlot: "caseFile", toSlot: "input", transferStrategy: { type: "Disk" } },
                  ],
                },
              ],
            },
            outputs: [
              {
                descriptor: "results",
                from: { node: "solveOne", output: "result" },
                aggregate: "Collect",
              },
            ],
          },
          {
            type: "Reduce",
            id: "gather",
            name: "gather",
            from: { loop: "sweep", output: "results" },
            ordering: "ByIndex",
            reducer: {
              kind: "ExtractTable",
              columns: [
                { name: "reynolds", type: "double", source: { loopItem: "reynolds" } },
                {
                  name: "cl",
                  type: "double",
                  source: { collectedOut: "solverLog" },
                  extract: { kind: "Regex", pattern: "Cl=([0-9.]+)", group: 1 },
                },
              ],
            },
            output: { kind: "SingleFile", descriptor: "summary", fileName: "summary.csv" },
          },
          suc("report"),
        ],
        nodeRelations: [
          { fromId: "genCases", toId: "sweep", slotRelations: [] },
          { fromId: "sweep", toId: "gather", slotRelations: [] },
          { fromId: "gather", toId: "report", slotRelations: [] },
        ],
      },
    };
    expect(() => WorkflowSchema.parse(doc)).not.toThrow();
  });

  test("parses a while-convergence workflow", () => {
    const doc = {
      name: "converge",
      parameters: [
        { name: "targetResidual", type: "double", default: 1e-5 },
        { name: "maxIter", type: "int", default: 200 },
      ],
      spec: {
        nodeDrafts: [
          suc("prep", {
            outputSlots: [
              { type: "File", descriptor: "mesh", origin: "UsecaseOut", isBatch: false },
            ],
          }),
          {
            type: "Loop",
            id: "iterate",
            name: "iterate",
            mode: "While",
            maxIterations: { expr: "params.maxIter" },
            onExhausted: "SucceedWithLast",
            until: { expr: "nodes.check.values.residual <= params.targetResidual" },
            carry: [
              {
                from: { node: "solve", output: "field" },
                to: { input: "fieldIn" },
                initial: { node: "prep", output: "mesh" },
              },
            ],
            body: { nodeDrafts: [suc("solve"), suc("check")] },
            outputs: [{ descriptor: "finalField", from: { node: "solve", output: "field" } }],
          },
        ],
        nodeRelations: [{ fromId: "prep", toId: "iterate", slotRelations: [] }],
      },
    };
    expect(() => WorkflowSchema.parse(doc)).not.toThrow();
  });

  test("parses a switch + consumer-side select + inline sub-workflow", () => {
    const doc = {
      name: "branch",
      spec: {
        nodeDrafts: [
          suc("mesh"),
          {
            type: "Switch",
            id: "pick",
            name: "pick",
            cases: [
              { when: { expr: "nodes.mesh.values.cellCount < 1000000" }, to: "small" },
              { when: { expr: "nodes.mesh.values.cellCount < 50000000" }, to: "medium" },
            ],
            default: "large",
          },
          suc("small"),
          suc("medium"),
          suc("large"),
          suc("post", {
            inputSlots: [
              {
                type: "File",
                descriptor: "solverOut",
                sources: [
                  { node: "small", output: "result" },
                  { node: "medium", output: "result" },
                  { node: "large", output: "result" },
                ],
                select: "RequireExactlyOne",
              },
            ],
          }),
          {
            type: "SubWorkflow",
            id: "refine",
            name: "refine",
            maxDepth: 8,
            ref: { kind: "Inline", body: { nodeDrafts: [suc("innerSolve")] } },
            inputs: [{ to: { param: "region" }, from: { expr: "params.region" } }],
            outputs: [{ descriptor: "refined", from: { workflowOutput: "result" } }],
          },
        ],
      },
    };
    expect(() => WorkflowSchema.parse(doc)).not.toThrow();
  });
});
