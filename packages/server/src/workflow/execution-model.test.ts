import { expect, test } from "bun:test";
import { workflowDsl } from "@kuintessence/shared";
import { requiresDurableWorkflow } from "./execution-model";

const id = "00000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const node = {
  id: "remote",
  name: "Federated task",
  type: "Federation",
  agreementRevisionId: id,
  template: { originSiteId: id, kind: "workflow", id, revision: "1", digest },
  inputManifestDigest: digest,
  environmentLockDigest: digest,
  resources: { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 30 },
  maxAmount: "10",
  outputs: [
    { descriptor: "result", type: "File", from: { nodeId: "producer", descriptor: "data" } },
  ],
};

test("federation DSL exposes only explicitly mapped file outputs and rejects unsupported raw inputs", () => {
  const workflow = workflowDsl.WorkflowSchema.parse({
    name: "Federation",
    spec: { nodeDrafts: [node] },
  });
  expect(workflowDsl.validateWorkflow(workflow)).toEqual([]);
  expect(
    workflowDsl.WorkflowNodeSchema.safeParse({
      ...node,
      inputSlots: [{ descriptor: "data", type: "File", contents: [] }],
    }).success,
  ).toBe(false);
  expect(
    workflowDsl.WorkflowNodeSchema.safeParse({
      ...node,
      outputs: [{ ...node.outputs[0], type: "Text" }],
    }).success,
  ).toBe(false);
  const duplicate = workflowDsl.WorkflowSchema.parse({
    name: "Invalid outputs",
    spec: { nodeDrafts: [{ ...node, outputs: [node.outputs[0], node.outputs[0]] }] },
  });
  expect(workflowDsl.validateWorkflow(duplicate).some((error) => error.includes("duplicate"))).toBe(
    true,
  );
});

test("federation parameter slots validate bindings, descriptors and relation targets", () => {
  const slot = { descriptor: "value", type: "Text", from: { param: "value" } };
  for (const invalid of [
    { ...slot, descriptor: "__proto__" },
    { ...slot, type: "Dataset" },
    { ...slot, from: undefined },
    { ...slot, contents: [id] },
  ])
    expect(
      workflowDsl.WorkflowNodeSchema.safeParse({ ...node, inputSlots: [invalid] }).success,
    ).toBe(false);

  const workflow = workflowDsl.WorkflowSchema.parse({
    name: "Dynamic federation",
    parameters: [{ name: "value", type: "int", default: 6 }],
    spec: {
      nodeDrafts: [
        {
          id: "before",
          name: "Before",
          type: "NoAction",
          outputSlots: [{ type: "Text", descriptor: "value" }],
        },
        { ...node, inputSlots: [slot] },
      ],
      nodeRelations: [
        {
          fromId: "before",
          toId: "remote",
          slotRelations: [
            { fromSlot: "value", toSlot: "value", transferStrategy: { type: "Network" } },
          ],
        },
      ],
    },
  });
  expect(workflowDsl.validateWorkflow(workflow)).toEqual([]);
  const relation = workflow.spec.nodeRelations[0]?.slotRelations[0];
  if (!relation) throw new Error("Missing relation");
  relation.toSlot = "unknown";
  expect(
    workflowDsl.validateWorkflow(workflow).some((error) => error.includes('toSlot "unknown"')),
  ).toBe(true);
  const remote = workflow.spec.nodeDrafts[1];
  if (remote?.type !== "Federation") throw new Error("Missing federation node");
  const input = remote.inputSlots?.[0];
  if (!input) throw new Error("Missing input");
  remote.inputSlots?.push(input);
  expect(workflowDsl.validateWorkflow(workflow).some((error) => error.includes("duplicate"))).toBe(
    true,
  );
});

test("durable selection follows nested loops and inline sub-workflows", async () => {
  const wf = workflowDsl.WorkflowSchema.parse({
    name: "Nested",
    spec: {
      nodeDrafts: [
        {
          id: "each",
          name: "Loop",
          type: "Loop",
          mode: "ForEach",
          maxIterations: 2,
          over: { expr: "[1, 2]", lang: "cel" },
          body: {
            nodeDrafts: [
              {
                id: "child",
                name: "Child",
                type: "SubWorkflow",
                maxDepth: 1,
                ref: { kind: "Inline", body: { nodeDrafts: [node] } },
              },
            ],
          },
        },
      ],
    },
  });
  expect(await requiresDurableWorkflow(wf)).toBe(true);
  const local = workflowDsl.WorkflowSchema.parse({
    name: "Local",
    spec: { nodeDrafts: [{ id: "a", name: "a", type: "NoAction" }] },
  });
  expect(await requiresDurableWorkflow(local)).toBe(false);
});

test("durable selection follows ByVersion references and handles cycles without losing later federation nodes", async () => {
  const reference = {
    id: "child",
    name: "Child",
    type: "SubWorkflow",
    maxDepth: 2,
    ref: { kind: "ByVersion", workflowVersionId: id },
  };
  const wf = workflowDsl.WorkflowSchema.parse({
    name: "Referenced",
    spec: { nodeDrafts: [reference] },
  });
  const child = workflowDsl.WorkflowSchema.parse({
    name: "Child",
    spec: { nodeDrafts: [reference, node] },
  });
  let reads = 0;
  expect(
    await requiresDurableWorkflow(wf, async () => {
      reads++;
      return child;
    }),
  ).toBe(true);
  expect(reads).toBe(1);
  await expect(requiresDurableWorkflow(wf, async () => null)).rejects.toThrow(
    "workflow version not found",
  );
});
