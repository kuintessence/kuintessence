import { describe, expect, test } from "bun:test";
import { extractRunGraph } from "../run-graph";
import { type Workflow, WorkflowSchema } from "../workflow";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const suc = (id: string) => ({
  type: "SoftwareUsecaseComputing" as const,
  id,
  name: `${id} node`,
  usecaseVersionId: UUID,
  softwareVersionId: UUID,
});

function parse(spec: unknown): Workflow {
  return WorkflowSchema.parse({ name: "w", spec });
}

describe("extractRunGraph", () => {
  test("maps nodeDrafts to {id, name, kind} using the node type discriminant", () => {
    const wf = parse({
      nodeDrafts: [suc("a"), suc("b"), { type: "NoAction", id: "c", name: "c node" }],
      nodeRelations: [],
    });
    const graph = extractRunGraph(wf);
    expect(graph.nodes).toEqual([
      { id: "a", name: "a node", kind: "SoftwareUsecaseComputing" },
      { id: "b", name: "b node", kind: "SoftwareUsecaseComputing" },
      { id: "c", name: "c node", kind: "NoAction" },
    ]);
  });

  test("maps nodeRelations to {source, target} without a when when none is set", () => {
    const wf = parse({
      nodeDrafts: [suc("a"), suc("b")],
      nodeRelations: [{ fromId: "a", toId: "b", slotRelations: [] }],
    });
    const graph = extractRunGraph(wf);
    expect(graph.edges).toEqual([{ source: "a", target: "b" }]);
  });

  test("coerces a relation's Expr `when` guard to its CEL string", () => {
    const wf = parse({
      nodeDrafts: [suc("a"), suc("b")],
      nodeRelations: [
        { fromId: "a", toId: "b", when: { expr: "params.flag", lang: "cel" }, slotRelations: [] },
      ],
    });
    const graph = extractRunGraph(wf);
    expect(graph.edges).toEqual([{ source: "a", target: "b", when: "params.flag" }]);
  });
});
