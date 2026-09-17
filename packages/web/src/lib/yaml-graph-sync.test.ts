import { workflowDsl } from "@kuintessence/shared/browser";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { type GraphNode, graphToYaml } from "./yaml-graph-sync";

function noActionNode(id: string): GraphNode {
  const raw = { id, name: id.toUpperCase(), type: "NoAction" } as workflowDsl.WorkflowNode;
  return {
    id,
    position: { x: 0, y: 0 },
    type: "NoAction",
    data: { id, name: id.toUpperCase(), kind: "NoAction", raw },
  };
}

describe("graphToYaml round-trip validity", () => {
  test("an empty canvas preserves schema-required graph arrays", () => {
    const yaml = graphToYaml({ name: "empty", parameters: [] }, [], []);
    const raw = parse(yaml);
    const parsed = workflowDsl.WorkflowSchema.safeParse(raw);

    expect(parsed.success).toBe(true);
    expect(Object.keys(raw).sort()).toEqual(["name", "parameters", "spec"]);
    expect(raw.spec.nodeDrafts).toEqual([]);
    expect(raw.spec.nodeRelations).toEqual([]);
  });

  // Rebuilt relations must retain schema-required empty slotRelations arrays.
  test("a relation-bearing graph emits schema-valid YAML with slotRelations preserved", () => {
    const yaml = graphToYaml(
      { name: "wf", parameters: [] },
      [noActionNode("a"), noActionNode("b")],
      [{ id: "a->b", source: "a", target: "b" }],
    );
    const parsed = workflowDsl.WorkflowSchema.safeParse(parse(yaml));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.spec.nodeRelations).toHaveLength(1);
      expect(parsed.data.spec.nodeRelations[0]?.slotRelations).toEqual([]);
    }
  });

  test("configured slot mappings survive graph serialization", () => {
    const yaml = graphToYaml(
      { name: "wf", parameters: [] },
      [noActionNode("source"), noActionNode("target")],
      [
        {
          id: "source->target",
          source: "source",
          target: "target",
          slotRelations: [
            {
              fromSlot: "output",
              toSlot: "input",
              transferStrategy: { type: "Network" },
            },
          ],
        },
      ],
    );
    const parsed = workflowDsl.WorkflowSchema.safeParse(parse(yaml));

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.spec.nodeRelations[0]?.slotRelations).toEqual([
        {
          fromSlot: "output",
          toSlot: "input",
          transferStrategy: { type: "Network" },
        },
      ]);
    }
  });
});
