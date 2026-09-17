/**
 * PropertiesPanel rendering and patch-emission tests cover common node fields
 * (display name + CEL `when` guard), type-specific forms, and read-only views
 * of nested bodies and complex rules.
 */

import { workflowDsl } from "@kuintessence/shared/browser";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

import type { GraphEdge, GraphNode } from "../../../lib/yaml-graph-sync";
import { PropertiesPanel } from "../PropertiesPanel";

function usecaseNode(id: string): GraphNode {
  return {
    id,
    type: "SoftwareUsecaseComputing",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: "Compute A",
      kind: "SoftwareUsecaseComputing",
      raw: {
        type: "SoftwareUsecaseComputing",
        id,
        name: "Compute A",
        usecaseVersionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        softwareVersionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      },
    },
  };
}

function condNode(id: string): GraphNode {
  return {
    id,
    type: "NoAction",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: "Cond",
      kind: "NoAction",
      when: { expr: "x > 0", lang: "cel" },
      raw: { type: "NoAction", id, name: "Cond", when: { expr: "x > 0", lang: "cel" } },
    },
  };
}

function scriptNode(id: string): GraphNode {
  return {
    id,
    type: "Script",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: "Run script",
      kind: "Script",
      raw: {
        type: "Script",
        id,
        name: "Run script",
        source: { type: "Inline", language: "python", content: "print('hi')" },
        runtimeProfileId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        executionIdentity: { type: "MappedAuto" },
        schedulingStrategy: { type: "Auto" },
        inputs: {},
        outputs: {},
      },
    },
  };
}

function milestoneNode(id: string): GraphNode {
  return {
    id,
    type: "Milestone",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: "Checkpoint",
      kind: "Milestone",
      raw: {
        type: "Milestone",
        id,
        name: "Checkpoint",
        url: "https://hooks.example.com/notify",
        customMessage: "stage complete",
      },
    },
  };
}

function switchNode(id: string): GraphNode {
  return {
    id,
    type: "Switch",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: "Route",
      kind: "Switch",
      raw: {
        type: "Switch",
        id,
        name: "Route",
        cases: [{ when: { expr: "x > 0", lang: "cel" }, to: "next" }],
        default: "fallback",
      },
    },
  };
}

function loopNode(id: string): GraphNode {
  return {
    id,
    type: "Loop",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: "Sweep",
      kind: "Loop",
      raw: {
        type: "Loop",
        id,
        name: "Sweep",
        mode: "ForEach",
        maxIterations: 10,
        over: { expr: "params.items", lang: "cel" },
        body: { nodeDrafts: [], nodeRelations: [] },
      },
    },
  };
}

function reduceNode(id: string): GraphNode {
  return {
    id,
    type: "Reduce",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: "Gather",
      kind: "Reduce",
      raw: {
        type: "Reduce",
        id,
        name: "Gather",
        from: { loop: "sweep", output: "results" },
        ordering: "ByIndex",
        reducer: { kind: "Collect" },
        output: { kind: "SingleFile", descriptor: "table.csv" },
      },
    },
  };
}

function subWorkflowNode(id: string): GraphNode {
  return {
    id,
    type: "SubWorkflow",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: "Child",
      kind: "SubWorkflow",
      raw: {
        type: "SubWorkflow",
        id,
        name: "Child",
        ref: { kind: "ByVersion", workflowVersionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
        maxDepth: 3,
      },
    },
  };
}

function generateNode(id: string): GraphNode {
  return {
    id,
    type: "Generate",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: "Cases",
      kind: "Generate",
      raw: {
        type: "Generate",
        id,
        name: "Cases",
        rule: { kind: "Range", start: 0, stop: 10, step: 1 },
        output: { descriptor: "params", as: "List" },
      },
    },
  };
}

/**
 * Render the panel with a stateful patch applier so round-trip tests can drive
 * fields whose visibility depends on the latest `raw` (e.g. Loop `until` only
 * renders once the node's mode flips to While). `flush()` re-renders with the
 * accumulated `raw` after each interaction.
 */
function controlled(node: GraphNode, onRaw?: (raw: GraphNode["data"]["raw"]) => void) {
  let current = node.data.raw;
  const apply = (_id: string, patch: { raw?: GraphNode["data"]["raw"] }) => {
    if (patch.raw) {
      current = patch.raw;
      onRaw?.(current);
    }
  };
  const view = render(<PropertiesPanel selected={node} onPatch={apply} />);
  return {
    flush() {
      view.rerender(
        <PropertiesPanel
          selected={{ ...node, data: { ...node.data, raw: current } }}
          onPatch={apply}
        />,
      );
    },
  };
}

describe("PropertiesPanel", () => {
  test("renders empty placeholder when no node selected", () => {
    render(<PropertiesPanel selected={null} onPatch={() => {}} />);
    expect(screen.getByTestId("rf-properties-empty")).toBeTruthy();
  });

  test("renders id, type, name, and a read-only body block", () => {
    render(<PropertiesPanel selected={usecaseNode("a")} onPatch={() => {}} />);
    expect((screen.getByTestId("rf-prop-id") as HTMLInputElement).value).toBe("a");
    expect((screen.getByTestId("rf-prop-type") as HTMLInputElement).value).toBe(
      "SoftwareUsecaseComputing",
    );
    expect(screen.getByTestId("rf-prop-type")).toHaveProperty("readOnly", true);
    expect(screen.getByTestId("rf-prop-type").className).toContain("bg-muted/50");
    expect((screen.getByTestId("rf-prop-name") as HTMLInputElement).value).toBe("Compute A");
    expect(screen.getByTestId("rf-prop-body").textContent).toContain("usecaseVersionId");
  });

  test("editing name emits onPatch with the new name", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={usecaseNode("a")} onPatch={onPatch} />);

    const name = screen.getByTestId("rf-prop-name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Compute B" } });
    fireEvent.blur(name);

    expect(onPatch).toHaveBeenCalled();
    const [nodeId, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(nodeId).toBe("a");
    expect(patch?.name).toBe("Compute B");
  });

  test("renders a selected edge and emits CEL guard edits", () => {
    const onEdgePatch = vi.fn();
    const edge: GraphEdge = {
      id: "producer->consumer",
      source: "producer",
      target: "consumer",
      slotRelations: [
        { fromSlot: "result", toSlot: "input", transferStrategy: { type: "Network" } },
      ],
    };
    render(
      <PropertiesPanel
        selected={null}
        selectedEdge={edge}
        onPatch={() => {}}
        onEdgePatch={onEdgePatch}
      />,
    );

    const panel = screen.getByTestId("rf-edge-properties");
    expect(panel.textContent).toContain("producer");
    expect(panel.textContent).toContain("result");
    expect(screen.getByTestId("rf-prop-json").querySelector("button")?.textContent?.trim()).toBe(
      "workflow.editor.properties.copyJson",
    );
    const when = panel.querySelector("input") as HTMLInputElement;
    fireEvent.change(when, { target: { value: "params.ready" } });
    fireEvent.blur(when);
    expect(onEdgePatch).toHaveBeenCalledWith("producer->consumer", {
      when: { expr: "params.ready", lang: "cel" },
    });
  });

  test("when guard input is prefilled and emits a CEL expr on edit", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={condNode("c")} onPatch={onPatch} />);

    const when = screen.getByTestId("rf-prop-when") as HTMLInputElement;
    expect(when.value).toBe("x > 0");
    fireEvent.change(when, { target: { value: "x > 1" } });
    fireEvent.blur(when);

    expect(onPatch).toHaveBeenCalled();
    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(patch?.when?.expr).toBe("x > 1");
  });

  test("SoftwareUsecaseComputing node shows structured version + requirements fields", () => {
    render(<PropertiesPanel selected={usecaseNode("a")} onPatch={() => {}} />);

    expect((screen.getByTestId("rf-prop-usecase-version-id") as HTMLInputElement).value).toBe(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    );
    expect((screen.getByTestId("rf-prop-software-version-id") as HTMLInputElement).value).toBe(
      "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    );
    expect(screen.getByTestId("rf-prop-req-cpuCores")).toBeTruthy();
    expect(screen.getByTestId("rf-prop-req-nodeCount")).toBeTruthy();
    expect(screen.getByTestId("rf-prop-req-maxWallTime")).toBeTruthy();
  });

  test("editing usecaseVersionId emits a patch writing it onto the node draft", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={usecaseNode("a")} onPatch={onPatch} />);

    const input = screen.getByTestId("rf-prop-usecase-version-id") as HTMLInputElement;
    const next = "11111111-2222-3333-4444-555555555555";
    fireEvent.change(input, { target: { value: next } });
    fireEvent.blur(input);

    expect(onPatch).toHaveBeenCalled();
    const [nodeId, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(nodeId).toBe("a");
    expect(patch?.raw).toMatchObject({ type: "SoftwareUsecaseComputing", usecaseVersionId: next });
  });

  test("named usecase references remain readable without exposing UUID edits", () => {
    const node = usecaseNode("named");
    node.data.raw = {
      type: "SoftwareUsecaseComputing",
      id: "named",
      name: "Named compute",
      usecaseRef: { source: "ecosystem", name: "gromacs.mdrun", version: "1.0.0" },
      softwareRef: { source: "ecosystem", name: "gromacs", version: "2025.2" },
    } as never;

    render(<PropertiesPanel selected={node} onPatch={() => {}} />);

    expect((screen.getByTestId("rf-prop-usecase-version-id") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("rf-prop-usecase-version-id") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId("rf-prop-software-version-id") as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  test("editing a requirements field writes a requirements object onto the draft", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={usecaseNode("a")} onPatch={onPatch} />);

    const cpu = screen.getByTestId("rf-prop-req-cpuCores") as HTMLInputElement;
    fireEvent.change(cpu, { target: { value: "8" } });
    fireEvent.blur(cpu);

    expect(onPatch).toHaveBeenCalled();
    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(patch?.raw).toMatchObject({ requirements: { cpuCores: 8 } });
  });

  test("clearing a requirements field drops it from the requirements object", () => {
    const onPatch = vi.fn();
    const node = usecaseNode("a");
    node.data.raw = { ...node.data.raw, requirements: { cpuCores: 8, nodeCount: 2 } } as never;
    render(<PropertiesPanel selected={node} onPatch={onPatch} />);

    const cpu = screen.getByTestId("rf-prop-req-cpuCores") as HTMLInputElement;
    expect(cpu.value).toBe("8");
    fireEvent.change(cpu, { target: { value: "" } });
    fireEvent.blur(cpu);

    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(patch?.raw).toMatchObject({ requirements: { nodeCount: 2 } });
    expect(
      (patch?.raw as { requirements?: Record<string, unknown> }).requirements,
    ).not.toHaveProperty("cpuCores");
  });

  test("Script node shows canonical source, runtime, identity, and content", () => {
    render(<PropertiesPanel selected={scriptNode("sc")} onPatch={() => {}} />);

    expect((screen.getByTestId("rf-prop-script-source") as HTMLSelectElement).value).toBe("Inline");
    expect((screen.getByTestId("rf-prop-script-language") as HTMLInputElement).value).toBe(
      "python",
    );
    expect((screen.getByTestId("rf-prop-script-identity") as HTMLInputElement).value).toBe(
      "MappedAuto",
    );
    expect((screen.getByTestId("rf-prop-script-content") as HTMLTextAreaElement).value).toBe(
      "print('hi')",
    );
  });

  test("editing the content textarea emits canonical source.content", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={scriptNode("sc")} onPatch={onPatch} />);

    const content = screen.getByTestId("rf-prop-script-content") as HTMLTextAreaElement;
    fireEvent.change(content, { target: { value: "print('bye')" } });
    fireEvent.blur(content);

    expect(onPatch).toHaveBeenCalled();
    const [nodeId, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(nodeId).toBe("sc");
    expect(patch?.raw).toMatchObject({
      type: "Script",
      source: { type: "Inline", language: "python", content: "print('bye')" },
    });
  });

  test("editing runtime profile emits the canonical runtimeProfileId", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={scriptNode("sc")} onPatch={onPatch} />);

    const runtime = screen.getByTestId("rf-prop-script-runtime") as HTMLInputElement;
    fireEvent.change(runtime, { target: { value: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } });
    fireEvent.blur(runtime);

    expect(onPatch).toHaveBeenCalled();
    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(patch?.raw).toMatchObject({
      type: "Script",
      runtimeProfileId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });
  });

  test("named script references render without a source body or runtime profile UUID", () => {
    const node = scriptNode("named-script");
    node.data.raw = {
      type: "Script",
      id: "named-script",
      name: "Named script",
      scriptRef: { source: "ecosystem", name: "gromacs.summary", version: "1.0.0" },
      runtimeContractRef: { name: "python-3.12-stdlib-v1", version: "1" },
      executionIdentity: { type: "MappedAuto" },
      schedulingStrategy: { type: "Auto" },
      inputs: {},
      outputs: {},
    } as never;

    render(<PropertiesPanel selected={node} onPatch={() => {}} />);

    expect((screen.getByTestId("rf-prop-script-source") as HTMLSelectElement).value).toBe(
      "AssetRevision",
    );
    expect((screen.getByTestId("rf-prop-script-runtime") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("rf-prop-script-runtime") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("rf-prop-script-content")).toBeNull();
  });

  test("Milestone node shows the url and customMessage inputs", () => {
    render(<PropertiesPanel selected={milestoneNode("m")} onPatch={() => {}} />);

    expect((screen.getByTestId("rf-prop-milestone-url") as HTMLInputElement).value).toBe(
      "https://hooks.example.com/notify",
    );
    expect((screen.getByTestId("rf-prop-milestone-message") as HTMLTextAreaElement).value).toBe(
      "stage complete",
    );
  });

  test("editing the Milestone url emits the new url on the draft", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={milestoneNode("m")} onPatch={onPatch} />);

    const url = screen.getByTestId("rf-prop-milestone-url") as HTMLInputElement;
    fireEvent.change(url, { target: { value: "https://hooks.example.com/updated" } });
    fireEvent.blur(url);

    expect(onPatch).toHaveBeenCalled();
    const [nodeId, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(nodeId).toBe("m");
    expect(patch?.raw).toMatchObject({
      type: "Milestone",
      url: "https://hooks.example.com/updated",
    });
  });

  test("editing the Milestone customMessage emits the new customMessage on the draft", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={milestoneNode("m")} onPatch={onPatch} />);

    const message = screen.getByTestId("rf-prop-milestone-message") as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "checkpoint reached" } });
    fireEvent.blur(message);

    expect(onPatch).toHaveBeenCalled();
    const [nodeId, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(nodeId).toBe("m");
    expect(patch?.raw).toMatchObject({ type: "Milestone", customMessage: "checkpoint reached" });
  });

  test("Switch node renders an editable case list and default slug", () => {
    render(<PropertiesPanel selected={switchNode("s")} onPatch={() => {}} />);

    expect((screen.getByTestId("rf-prop-switch-case-when-0") as HTMLInputElement).value).toBe(
      "x > 0",
    );
    expect((screen.getByTestId("rf-prop-switch-case-to-0") as HTMLInputElement).value).toBe("next");
    expect((screen.getByTestId("rf-prop-switch-default") as HTMLInputElement).value).toBe(
      "fallback",
    );
    expect(screen.getByTestId("rf-prop-switch-add-case")).toBeTruthy();
  });

  test("Switch add-case appends an empty case to the draft", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={switchNode("s")} onPatch={onPatch} />);

    fireEvent.click(screen.getByTestId("rf-prop-switch-add-case"));

    expect(onPatch).toHaveBeenCalled();
    const [nodeId, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(nodeId).toBe("s");
    const cases = (patch?.raw as { cases?: unknown[] }).cases;
    expect(cases).toHaveLength(2);
    expect(cases?.[1]).toMatchObject({ to: "", when: { expr: "", lang: "cel" } });
  });

  test("Switch editing a case `to` writes the new slug onto the draft", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={switchNode("s")} onPatch={onPatch} />);

    const to = screen.getByTestId("rf-prop-switch-case-to-0") as HTMLInputElement;
    fireEvent.change(to, { target: { value: "other" } });
    fireEvent.blur(to);

    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect((patch?.raw as { cases?: { to?: string }[] }).cases?.[0]?.to).toBe("other");
  });

  test("Switch removing a case keeps at least one case", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={switchNode("s")} onPatch={onPatch} />);

    expect(screen.queryByTestId("rf-prop-switch-remove-case-0")).toBeNull();
  });

  test("Loop node shows mode, maxIterations and the ForEach `over` field", () => {
    render(<PropertiesPanel selected={loopNode("l")} onPatch={() => {}} />);

    expect((screen.getByTestId("rf-prop-loop-mode") as HTMLSelectElement).value).toBe("ForEach");
    expect((screen.getByTestId("rf-prop-loop-max-iterations") as HTMLInputElement).value).toBe(
      "10",
    );
    expect((screen.getByTestId("rf-prop-loop-over") as HTMLInputElement).value).toBe(
      "params.items",
    );
    expect(screen.queryByTestId("rf-prop-loop-until")).toBeNull();
    expect(screen.getByTestId("rf-prop-body").textContent).toContain("nodeDrafts");
  });

  test("Loop switching ForEach -> While drops the stale `over` guard", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={loopNode("l")} onPatch={onPatch} />);

    const mode = screen.getByTestId("rf-prop-loop-mode") as HTMLSelectElement;
    fireEvent.change(mode, { target: { value: "While" } });

    expect(onPatch).toHaveBeenCalled();
    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    const raw = patch?.raw as { mode?: string; over?: unknown; until?: unknown };
    expect(raw.mode).toBe("While");
    expect(raw).not.toHaveProperty("over");
  });

  test("Reduce node shows from.loop, from.output, ordering and output descriptor", () => {
    render(<PropertiesPanel selected={reduceNode("r")} onPatch={() => {}} />);

    expect((screen.getByTestId("rf-prop-reduce-from-loop") as HTMLInputElement).value).toBe(
      "sweep",
    );
    expect((screen.getByTestId("rf-prop-reduce-from-output") as HTMLInputElement).value).toBe(
      "results",
    );
    expect((screen.getByTestId("rf-prop-reduce-ordering") as HTMLSelectElement).value).toBe(
      "ByIndex",
    );
    expect((screen.getByTestId("rf-prop-reduce-output-descriptor") as HTMLInputElement).value).toBe(
      "table.csv",
    );
    expect(screen.getByTestId("rf-prop-body").textContent).toContain("reducer");
  });

  test("Reduce editing from.loop writes the new slug onto the draft", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={reduceNode("r")} onPatch={onPatch} />);

    const loop = screen.getByTestId("rf-prop-reduce-from-loop") as HTMLInputElement;
    fireEvent.change(loop, { target: { value: "sweep2" } });
    fireEvent.blur(loop);

    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(patch?.raw).toMatchObject({ from: { loop: "sweep2", output: "results" } });
  });

  test("SubWorkflow node shows ByVersion ref with the workflowVersionId input", () => {
    render(<PropertiesPanel selected={subWorkflowNode("w")} onPatch={() => {}} />);

    expect((screen.getByTestId("rf-prop-subworkflow-ref-kind") as HTMLSelectElement).value).toBe(
      "ByVersion",
    );
    expect((screen.getByTestId("rf-prop-subworkflow-version-id") as HTMLInputElement).value).toBe(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    );
    expect((screen.getByTestId("rf-prop-subworkflow-max-depth") as HTMLInputElement).value).toBe(
      "3",
    );
  });

  test("SubWorkflow switching ByVersion -> Inline emits an Inline ref with an empty body", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={subWorkflowNode("w")} onPatch={onPatch} />);

    const kind = screen.getByTestId("rf-prop-subworkflow-ref-kind") as HTMLSelectElement;
    fireEvent.change(kind, { target: { value: "Inline" } });

    expect(onPatch).toHaveBeenCalled();
    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    const ref = (patch?.raw as { ref?: Record<string, unknown> }).ref;
    expect(ref).toMatchObject({ kind: "Inline" });
    expect(ref).not.toHaveProperty("workflowVersionId");
    expect(ref).toHaveProperty("body");
  });

  test("Generate node shows the editable output descriptor and `as`, rule read-only", () => {
    render(<PropertiesPanel selected={generateNode("g")} onPatch={() => {}} />);

    expect(
      (screen.getByTestId("rf-prop-generate-output-descriptor") as HTMLInputElement).value,
    ).toBe("params");
    expect((screen.getByTestId("rf-prop-generate-output-as") as HTMLSelectElement).value).toBe(
      "List",
    );
    expect(screen.getByTestId("rf-prop-body").textContent).toContain("rule");
  });

  test("Generate editing the output descriptor writes it onto the draft", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={generateNode("g")} onPatch={onPatch} />);

    const desc = screen.getByTestId("rf-prop-generate-output-descriptor") as HTMLInputElement;
    fireEvent.change(desc, { target: { value: "grid" } });
    fireEvent.blur(desc);

    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    expect(patch?.raw).toMatchObject({ output: { descriptor: "grid", as: "List" } });
  });

  test("Loop ForEach -> While with `until` supplied emits a schema-valid While loop", () => {
    const node = loopNode("l");
    let lastRaw: workflowDsl.WorkflowNode = node.data.raw as workflowDsl.WorkflowNode;
    const harness = controlled(node, (raw) => {
      lastRaw = raw as workflowDsl.WorkflowNode;
    });

    const mode = screen.getByTestId("rf-prop-loop-mode") as HTMLSelectElement;
    fireEvent.change(mode, { target: { value: "While" } });
    harness.flush();

    const until = screen.getByTestId("rf-prop-loop-until") as HTMLInputElement;
    fireEvent.change(until, { target: { value: "i < 5" } });
    fireEvent.blur(until);
    harness.flush();

    const parsed = workflowDsl.WorkflowNodeSchema.safeParse(lastRaw);
    expect(parsed.success).toBe(true);
    expect((lastRaw as { until?: { expr?: string } }).until?.expr).toBe("i < 5");
    expect(lastRaw).not.toHaveProperty("over");
  });

  test("Loop ForEach -> While with no `until` omits the guard rather than emitting {expr:''}", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={loopNode("l")} onPatch={onPatch} />);

    const mode = screen.getByTestId("rf-prop-loop-mode") as HTMLSelectElement;
    fireEvent.change(mode, { target: { value: "While" } });

    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    const raw = patch?.raw as { over?: { expr?: string }; until?: { expr?: string } };
    expect(raw).not.toHaveProperty("over");
    expect(raw).not.toHaveProperty("until");
  });

  test("SubWorkflow ByVersion with a valid UUID emits a schema-valid node", () => {
    const onPatch = vi.fn();
    render(<PropertiesPanel selected={subWorkflowNode("w")} onPatch={onPatch} />);

    const versionId = screen.getByTestId("rf-prop-subworkflow-version-id") as HTMLInputElement;
    fireEvent.change(versionId, { target: { value: "11111111-2222-3333-4444-555555555555" } });
    fireEvent.blur(versionId);

    const [, patch] = onPatch.mock.calls.at(-1) ?? [];
    const parsed = workflowDsl.WorkflowNodeSchema.safeParse(patch?.raw);
    expect(parsed.success).toBe(true);
    expect(patch?.raw).toMatchObject({
      ref: { kind: "ByVersion", workflowVersionId: "11111111-2222-3333-4444-555555555555" },
    });
  });
});
