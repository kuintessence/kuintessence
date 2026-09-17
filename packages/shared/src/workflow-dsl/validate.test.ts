import { describe, expect, test } from "bun:test";
import { validateWorkflow } from "./validate";
import { type Workflow, WorkflowSchema } from "./workflow";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const suc = (id: string) => ({
  type: "SoftwareUsecaseComputing" as const,
  id,
  name: id,
  usecaseVersionId: UUID,
  softwareVersionId: UUID,
});
const wf = (spec: unknown, extra: Record<string, unknown> = {}): Workflow =>
  WorkflowSchema.parse({ name: "w", spec, ...extra });

describe("validateWorkflow", () => {
  test("returns no errors for a well-formed linear workflow", () => {
    const w = wf({
      nodeDrafts: [suc("a"), suc("b")],
      nodeRelations: [{ fromId: "a", toId: "b", slotRelations: [] }],
    });
    expect(validateWorkflow(w)).toEqual([]);
  });

  test("flags a duplicate node id", () => {
    const w = wf({ nodeDrafts: [suc("a"), suc("a")] });
    expect(validateWorkflow(w).some((e) => e.includes("duplicate"))).toBe(true);
  });

  test("flags a duplicate workflow parameter name", () => {
    const w = wf(
      { nodeDrafts: [suc("a")] },
      {
        parameters: [
          { name: "sample", type: "string", default: "one" },
          { name: "sample", type: "string", default: "two" },
        ],
      },
    );
    expect(validateWorkflow(w).some((e) => e.includes("parameter"))).toBe(true);
  });

  test("flags duplicate input slot descriptors on one node", () => {
    const w = wf({
      nodeDrafts: [
        {
          ...suc("a"),
          inputSlots: [
            { type: "Text", descriptor: "sample" },
            { type: "File", descriptor: "sample", isBatch: false },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("input descriptor"))).toBe(true);
  });

  test("flags duplicate output descriptors on one node", () => {
    const w = wf({
      nodeDrafts: [
        {
          ...suc("a"),
          outputSlots: [
            { type: "Text", descriptor: "result" },
            { type: "File", descriptor: "result", origin: "UsecaseOut", isBatch: false },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("output descriptor"))).toBe(true);
  });

  test("flags duplicate Loop output descriptors", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "Loop",
          id: "loop",
          name: "loop",
          mode: "ForEach",
          over: { expr: "[]" },
          maxIterations: 5,
          body: {
            nodeDrafts: [
              {
                ...suc("body"),
                outputSlots: [{ type: "Text", descriptor: "value" }],
              },
            ],
          },
          outputs: [
            { descriptor: "result", from: { node: "body", output: "value" } },
            { descriptor: "result", from: { node: "body", output: "value" } },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("output descriptor"))).toBe(true);
  });

  test("flags duplicate SubWorkflow output descriptors", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "SubWorkflow",
          id: "child",
          name: "child",
          maxDepth: 2,
          ref: {
            kind: "Inline",
            body: {
              nodeDrafts: [
                {
                  type: "Generate",
                  id: "gen",
                  name: "gen",
                  rule: { kind: "Enumeration", values: [1] },
                  output: { descriptor: "items", as: "List" },
                },
              ],
            },
          },
          outputs: [
            { descriptor: "result", from: { workflowOutput: "items" } },
            { descriptor: "result", from: { workflowOutput: "items" } },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("output descriptor"))).toBe(true);
  });

  test("flags a relation to an unknown node", () => {
    const w = wf({
      nodeDrafts: [suc("a")],
      nodeRelations: [{ fromId: "a", toId: "ghost", slotRelations: [] }],
    });
    expect(validateWorkflow(w).some((e) => e.includes("ghost"))).toBe(true);
  });

  test("flags a slot relation fromSlot that is not declared by the source node", () => {
    const w = wf({
      nodeDrafts: [
        {
          ...suc("producer"),
          outputSlots: [{ type: "Text", descriptor: "actual" }],
        },
        {
          ...suc("consumer"),
          inputSlots: [{ type: "Text", descriptor: "target" }],
        },
      ],
      nodeRelations: [
        {
          fromId: "producer",
          toId: "consumer",
          slotRelations: [
            {
              fromSlot: "missing",
              toSlot: "target",
              transferStrategy: { type: "Disk" },
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("fromSlot"))).toBe(true);
  });

  test("flags a slot relation toSlot that is not declared by the target node", () => {
    const w = wf({
      nodeDrafts: [
        {
          ...suc("producer"),
          outputSlots: [{ type: "Text", descriptor: "actual" }],
        },
        {
          ...suc("consumer"),
          inputSlots: [{ type: "Text", descriptor: "target" }],
        },
      ],
      nodeRelations: [
        {
          fromId: "producer",
          toId: "consumer",
          slotRelations: [
            {
              fromSlot: "actual",
              toSlot: "missing",
              transferStrategy: { type: "Disk" },
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("toSlot"))).toBe(true);
  });

  test("flags an input binding that references an unknown node", () => {
    const w = wf({
      nodeDrafts: [
        {
          ...suc("a"),
          inputSlots: [
            {
              type: "Text",
              descriptor: "x",
              from: { node: "ghost", output: "value" },
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("ghost"))).toBe(true);
  });

  test("flags an input source that references an unknown node", () => {
    const w = wf({
      nodeDrafts: [
        {
          ...suc("a"),
          inputSlots: [
            {
              type: "Text",
              descriptor: "x",
              sources: [{ node: "ghost", output: "value" }],
              select: "FirstAvailable",
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("ghost"))).toBe(true);
  });

  test("flags an input binding that references an unknown declared output", () => {
    const w = wf({
      nodeDrafts: [
        {
          ...suc("producer"),
          outputSlots: [{ type: "Text", descriptor: "actual" }],
        },
        {
          ...suc("consumer"),
          inputSlots: [
            {
              type: "Text",
              descriptor: "x",
              from: { node: "producer", output: "missing" },
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("flags an input binding that references an unknown workflow parameter", () => {
    const w = wf(
      {
        nodeDrafts: [
          {
            ...suc("consumer"),
            inputSlots: [{ type: "Text", descriptor: "x", from: { param: "missing" } }],
          },
        ],
      },
      { parameters: [{ name: "actual", type: "string" }] },
    );
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("flags a Generate FromFile source that references an unknown output", () => {
    const w = wf({
      nodeDrafts: [
        {
          ...suc("producer"),
          outputSlots: [
            { type: "File", descriptor: "actual", origin: "UsecaseOut", isBatch: false },
          ],
        },
        {
          type: "Generate",
          id: "gen",
          name: "gen",
          rule: {
            kind: "FromFile",
            source: { node: "producer", output: "missing" },
            format: "CSV",
          },
          output: { descriptor: "items", as: "List" },
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("flags a dependency cycle", () => {
    const w = wf({
      nodeDrafts: [suc("a"), suc("b")],
      nodeRelations: [
        { fromId: "a", toId: "b", slotRelations: [] },
        { fromId: "b", toId: "a", slotRelations: [] },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  test("flags a Switch target that does not exist", () => {
    const w = wf({
      nodeDrafts: [
        suc("mesh"),
        { type: "Switch", id: "pick", name: "pick", cases: [{ when: { expr: "x" }, to: "ghost" }] },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("ghost"))).toBe(true);
  });

  test("flags a Reduce whose loop reference is not a Loop node", () => {
    const w = wf({
      nodeDrafts: [
        suc("notALoop"),
        {
          type: "Reduce",
          id: "gather",
          name: "gather",
          from: { loop: "notALoop", output: "results" },
          reducer: { kind: "Collect" },
          output: { kind: "SingleFile", descriptor: "s" },
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.toLowerCase().includes("loop"))).toBe(true);
  });

  test("flags a Reduce that references an unknown Loop output", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "Loop",
          id: "l",
          name: "l",
          mode: "ForEach",
          over: { expr: "[]" },
          maxIterations: 5,
          body: { nodeDrafts: [suc("body")] },
          outputs: [{ descriptor: "actual", from: { node: "body", output: "value" } }],
        },
        {
          type: "Reduce",
          id: "r",
          name: "r",
          from: { loop: "l", output: "missing" },
          reducer: { kind: "Collect" },
          output: { kind: "SingleFile", descriptor: "s" },
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("flags a Statistics reducer that references an unknown Loop output", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "Loop",
          id: "l",
          name: "l",
          mode: "ForEach",
          over: { expr: "[]" },
          maxIterations: 5,
          body: {
            nodeDrafts: [
              {
                ...suc("body"),
                outputSlots: [{ type: "Text", descriptor: "value" }],
              },
            ],
          },
          outputs: [{ descriptor: "actual", from: { node: "body", output: "value" } }],
        },
        {
          type: "Reduce",
          id: "r",
          name: "r",
          from: { loop: "l", output: "actual" },
          reducer: { kind: "Statistics", over: "missing", metrics: ["mean"] },
          output: { kind: "SingleFile", descriptor: "s" },
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("recurses into a loop body scope", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "Loop",
          id: "l",
          name: "l",
          mode: "ForEach",
          over: { expr: "x" },
          maxIterations: 5,
          body: { nodeDrafts: [suc("dup"), suc("dup")] },
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("duplicate"))).toBe(true);
  });

  test("flags a Loop output that references an unknown body node", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "Loop",
          id: "l",
          name: "l",
          mode: "ForEach",
          over: { expr: "[]" },
          maxIterations: 5,
          body: { nodeDrafts: [suc("body")] },
          outputs: [{ descriptor: "values", from: { node: "ghost", output: "value" } }],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("ghost"))).toBe(true);
  });

  test("flags a Reduce ExtractTable column that references an unknown body output", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "Loop",
          id: "l",
          name: "l",
          mode: "ForEach",
          over: { expr: "[]" },
          maxIterations: 5,
          body: {
            nodeDrafts: [
              {
                ...suc("body"),
                outputSlots: [{ type: "Text", descriptor: "actual" }],
              },
            ],
          },
          outputs: [{ descriptor: "actual", from: { node: "body", output: "actual" } }],
        },
        {
          type: "Reduce",
          id: "r",
          name: "r",
          from: { loop: "l", output: "actual" },
          reducer: {
            kind: "ExtractTable",
            columns: [{ name: "x", type: "string", source: { node: "body", output: "missing" } }],
          },
          output: { kind: "SingleFile", descriptor: "s" },
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("flags a Loop carry source that references an unknown body node", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "Loop",
          id: "l",
          name: "l",
          mode: "While",
          until: { expr: "true" },
          maxIterations: 5,
          body: { nodeDrafts: [suc("body")] },
          carry: [{ from: { node: "ghost", output: "value" }, to: { input: "x" } }],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("ghost"))).toBe(true);
  });

  test("flags a Loop carry target input that is not declared by the body", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "Loop",
          id: "l",
          name: "l",
          mode: "While",
          until: { expr: "true" },
          maxIterations: 5,
          body: {
            nodeDrafts: [
              {
                ...suc("body"),
                inputSlots: [{ type: "Text", descriptor: "actual" }],
                outputSlots: [{ type: "Text", descriptor: "value" }],
              },
            ],
          },
          carry: [{ from: { node: "body", output: "value" }, to: { input: "missing" } }],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("flags a Loop carry initial value that references an unknown parent node", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "Loop",
          id: "l",
          name: "l",
          mode: "While",
          until: { expr: "true" },
          maxIterations: 5,
          body: { nodeDrafts: [suc("body")] },
          carry: [
            {
              from: { node: "body", output: "value" },
              to: { input: "x" },
              initial: { node: "ghost", output: "value" },
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("ghost"))).toBe(true);
  });

  test("flags a Loop carry initial value that references an unknown workflow parameter", () => {
    const w = wf(
      {
        nodeDrafts: [
          {
            type: "Loop",
            id: "l",
            name: "l",
            mode: "While",
            until: { expr: "true" },
            maxIterations: 5,
            body: {
              nodeDrafts: [
                {
                  ...suc("body"),
                  inputSlots: [{ type: "Text", descriptor: "x" }],
                  outputSlots: [{ type: "Text", descriptor: "value" }],
                },
              ],
            },
            carry: [
              {
                from: { node: "body", output: "value" },
                to: { input: "x" },
                initial: { param: "missing" },
              },
            ],
          },
        ],
      },
      { parameters: [{ name: "actual", type: "string" }] },
    );
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("flags a SubWorkflow input that references an unknown parent node", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "SubWorkflow",
          id: "child",
          name: "child",
          maxDepth: 2,
          ref: { kind: "Inline", body: { nodeDrafts: [suc("inner")] } },
          inputs: [
            {
              to: { param: "x" },
              from: { node: "ghost", output: "value" },
            },
          ],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("ghost"))).toBe(true);
  });

  test("flags a SubWorkflow input that references an unknown parent parameter", () => {
    const w = wf(
      {
        nodeDrafts: [
          {
            type: "SubWorkflow",
            id: "child",
            name: "child",
            maxDepth: 2,
            ref: { kind: "Inline", body: { nodeDrafts: [suc("inner")] } },
            inputs: [
              {
                to: { param: "x" },
                from: { param: "missing" },
              },
            ],
          },
        ],
      },
      { parameters: [{ name: "actual", type: "string" }] },
    );
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("flags an inline SubWorkflow output that references an unknown child output", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "SubWorkflow",
          id: "child",
          name: "child",
          maxDepth: 2,
          ref: {
            kind: "Inline",
            body: {
              nodeDrafts: [
                {
                  type: "Generate",
                  id: "gen",
                  name: "gen",
                  rule: { kind: "Enumeration", values: [1] },
                  output: { descriptor: "items", as: "List" },
                },
              ],
            },
          },
          outputs: [{ descriptor: "out", from: { workflowOutput: "missing" } }],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("missing"))).toBe(true);
  });

  test("flags an inline SubWorkflow output that is ambiguous across child nodes", () => {
    const w = wf({
      nodeDrafts: [
        {
          type: "SubWorkflow",
          id: "child",
          name: "child",
          maxDepth: 2,
          ref: {
            kind: "Inline",
            body: {
              nodeDrafts: [
                { ...suc("left"), outputSlots: [{ type: "Text", descriptor: "result" }] },
                { ...suc("right"), outputSlots: [{ type: "Text", descriptor: "result" }] },
              ],
            },
          },
          outputs: [{ descriptor: "out", from: { workflowOutput: "result" } }],
        },
      ],
    });
    expect(validateWorkflow(w).some((e) => e.includes("ambiguous"))).toBe(true);
  });

  test("skips all checks when advanced.skipStaticValidation is true", () => {
    const w = wf(
      { nodeDrafts: [suc("a"), suc("a")] },
      { advanced: { skipStaticValidation: true } },
    );
    expect(validateWorkflow(w)).toEqual([]);
  });
});
