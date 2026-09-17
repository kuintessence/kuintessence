import { describe, expect, test } from "vitest";
import { parsePublishedWorkflowTemplate, parseWorkflowYaml, summarize } from "./workflow-parser";

const VALID_TWO_NODE = `name: pipe
parameters: []
spec:
  nodeDrafts:
    - type: NoAction
      id: a
      name: A
    - type: NoAction
      id: b
      name: B
  nodeRelations:
    - fromId: a
      toId: b
      slotRelations: []
`;

describe("parseWorkflowYaml", () => {
  test("rejects empty input", () => {
    const r = parseWorkflowYaml("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/empty/i);
  });

  test("returns a parse error for malformed YAML", () => {
    const r = parseWorkflowYaml("name: : :");
    expect(r.ok).toBe(false);
  });

  test("returns schema issues for valid YAML that violates the schema", () => {
    const yaml = "name: 99\nparameters: []\nspec:\n  nodeDrafts: []\n";
    const r = parseWorkflowYaml(yaml);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/schema/i);
      expect(r.issues?.length ?? 0).toBeGreaterThan(0);
      expect(r.issues?.some((issue) => issue.path[0] === "name")).toBe(true);
    }
  });

  test("parses a valid two-node workflow", () => {
    const r = parseWorkflowYaml(VALID_TWO_NODE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workflow.spec.nodeDrafts).toHaveLength(2);
      expect(r.workflow.spec.nodeRelations[0]?.fromId).toBe("a");
      expect(r.workflow.spec.nodeRelations[0]?.toId).toBe("b");
    }
  });
});

describe("summarize", () => {
  test("aggregates node count, edge count, and distinct node types", () => {
    const r = parseWorkflowYaml(VALID_TWO_NODE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = summarize(r.workflow);
    expect(s).toEqual({
      nodeCount: 2,
      edgeCount: 1,
      nodeTypes: ["NoAction"],
    });
  });
});

describe("parsePublishedWorkflowTemplate", () => {
  test("rejects a published template with the static-validation bypass enabled", () => {
    const yaml = `${VALID_TWO_NODE.replace("    - type: NoAction\n      id: b", "    - type: NoAction\n      id: a")}
advanced:
  skipStaticValidation: true`;
    expect(parseWorkflowYaml(yaml).ok).toBe(true);
    expect(parsePublishedWorkflowTemplate(yaml).ok).toBe(false);
  });
});
