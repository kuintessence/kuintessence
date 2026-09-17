/**
 * Tests for the React Flow editor host. These exercise three contracts the
 * shell relies on: rendering of the chrome (background/controls/minimap),
 * drop-to-create using the palette MIME type, and node-click selection.
 *
 * @xyflow/react is hoisted to the workspace root in this monorepo and brings
 * its own React copy at runtime — that's a known happy-dom hazard for unit
 * tests. We stub the parts of the library the host touches with hand-rolled
 * mocks so we exercise the host's real wiring (drag/drop, click translation)
 * without booting React Flow's heavy machinery.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const { updateNodeInternals } = vi.hoisted(() => ({ updateNodeInternals: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

// Stub @xyflow/react. We only care that:
//   - <ReactFlow> renders the children we provide for chrome (Background,
//     Controls, MiniMap) so consumers can find them in the DOM,
//   - the host wires the `onNodeClick` callback through.
// Everything else (layout, drag, viewport) is the host's responsibility — and
// that lives in the wrapper div, not inside React Flow.
vi.mock("@xyflow/react", () => {
  const React = require("react") as typeof import("react");
  function ReactFlow(
    props: { children?: React.ReactNode } & {
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onNodeClick?: (e: any, node: { id: string }) => void;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onPaneClick?: (e: any) => void;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      nodes?: any[];
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      edges?: any[];
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      nodeTypes?: Record<string, any>;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onNodeMouseEnter?: (e: any, node: { id: string }) => void;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onNodeMouseLeave?: (e: any, node: { id: string }) => void;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onEdgeClick?: (e: any, edge: any) => void;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onEdgeMouseEnter?: (e: any, edge: any) => void;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onEdgeMouseLeave?: (e: any, edge: any) => void;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onConnect?: (connection: any) => void;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onConnectStart?: (event: any, params: any) => void;
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      onConnectEnd?: (event: any, state: any) => void;
      autoPanOnConnect?: boolean;
    },
  ) {
    const {
      edges,
      onConnect,
      onConnectEnd,
      onConnectStart,
      onEdgeClick,
      onEdgeMouseEnter,
      onEdgeMouseLeave,
      onNodeClick,
      onNodeMouseEnter,
      onNodeMouseLeave,
      nodes,
      nodeTypes,
    } = props;
    return React.createElement(
      "div",
      {
        className: "react-flow",
        "data-testid": "rf-mock-flow",
        "data-auto-pan-on-connect": String(props.autoPanOnConnect),
      },
      // Render each node through its registered renderer so node-level test
      // ids (e.g. `rf-node-task-a`) are visible to tests.
      (nodes ?? []).map((n) => {
        const Renderer = nodeTypes?.[n.type as string];
        const child = Renderer
          ? React.createElement(Renderer, { data: n.data, selected: false })
          : null;
        return React.createElement(
          "div",
          {
            key: n.id,
            className: "react-flow__node",
            onClick: (e: React.MouseEvent) => onNodeClick?.(e, n),
            onMouseEnter: (e: React.MouseEvent) => onNodeMouseEnter?.(e, n),
            onMouseLeave: (e: React.MouseEvent) => onNodeMouseLeave?.(e, n),
          },
          child,
        );
      }),
      (edges ?? []).map((edge) =>
        React.createElement(
          "button",
          {
            key: edge.id,
            type: "button",
            "data-testid": `rf-mock-edge-${edge.id}`,
            "data-logical-edge-id": edge.data?.logicalEdgeId,
            "data-hidden": String(edge.data?.hidden ?? false),
            "data-mapped": String(edge.data?.mapped ?? false),
            onClick: (e: React.MouseEvent) => onEdgeClick?.(e, edge),
            onMouseEnter: (e: React.MouseEvent) => onEdgeMouseEnter?.(e, edge),
            onMouseLeave: (e: React.MouseEvent) => onEdgeMouseLeave?.(e, edge),
          },
          edge.id,
        ),
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "rf-mock-connect",
          onClick: () =>
            onConnect?.({
              source: "source",
              target: "target",
              sourceHandle: null,
              targetHandle: null,
            }),
        },
        "connect",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "rf-mock-connect-slots",
          onClick: () =>
            onConnect?.({
              source: "source",
              target: "target",
              sourceHandle: "output:result",
              targetHandle: "input:result",
            }),
        },
        "connect named slots",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "rf-mock-connect-second-slots",
          onClick: () =>
            onConnect?.({
              source: "source",
              target: "target",
              sourceHandle: "output:report",
              targetHandle: "input:metadata",
            }),
        },
        "connect second named slots",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "rf-mock-connect-start",
          onClick: () =>
            onConnectStart?.(
              {},
              {
                nodeId: "source",
                handleId: "output:log",
                handleType: "source",
              },
            ),
        },
        "start connection",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "rf-mock-connect-to-palette",
          onClick: () =>
            onConnectEnd?.(
              { clientX: 10, clientY: 10 },
              {
                isValid: false,
                fromHandle: { type: "source" },
                fromNode: { id: "source" },
              },
            ),
        },
        "continue",
      ),
      props.children,
    );
  }
  function Background() {
    return React.createElement("div", { className: "react-flow__background" });
  }
  function Controls() {
    return React.createElement("div", { className: "react-flow__controls" });
  }
  function MiniMap() {
    return React.createElement("div", { className: "react-flow__minimap" });
  }
  function ReactFlowProvider({ children }: { children: React.ReactNode }) {
    return React.createElement(React.Fragment, null, children);
  }
  // Node renderers (NodeTypes.tsx) draw connection points via <Handle> and
  // reference Position.* — stub both so rendering a node through its renderer
  // doesn't blow up.
  function Handle({
    className,
    id,
    position,
    type,
  }: {
    className?: string;
    id?: string;
    position: string;
    type: string;
  }) {
    return React.createElement("div", {
      className: `react-flow__handle ${className ?? ""}`,
      "data-handle-id": id,
      "data-position": position,
      "data-type": type,
    });
  }
  const Position = { Top: "top", Right: "right", Bottom: "bottom", Left: "left" };
  function useReactFlow() {
    return {
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    };
  }
  function useUpdateNodeInternals() {
    return updateNodeInternals;
  }
  // applyNodeChanges / applyEdgeChanges / addEdge are pure helpers the host
  // calls to keep its prop-driven state in sync. We pass-through with the
  // minimum behavior the tests touch.
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  const applyNodeChanges = (_changes: any, nodes: any[]) => nodes;
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  const applyEdgeChanges = (_changes: any, edges: any[]) => edges;
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  const addEdge = (edge: any, edges: any[]) => [...edges, edge];
  return {
    ReactFlow,
    ReactFlowProvider,
    Background,
    BackgroundVariant: { Dots: "dots" },
    Controls,
    MiniMap,
    Handle,
    Position,
    useReactFlow,
    useUpdateNodeInternals,
    applyNodeChanges,
    applyEdgeChanges,
    addEdge,
  };
});

import type { GraphEdge, GraphNode } from "../../../lib/yaml-graph-sync";
import { PALETTE_DRAG_MIME } from "../NodePalette";
import { createWorkflowNode, ReactFlowEditor } from "../ReactFlowEditor";

function makeFlatNode(id: string): GraphNode {
  return {
    id,
    type: "NoAction",
    position: { x: 0, y: 0 },
    data: {
      id,
      name: id,
      kind: "NoAction",
      raw: { type: "NoAction", id, name: id },
    },
  };
}

function harness(nodes: GraphNode[], edges: GraphEdge[] = []) {
  return (
    <div style={{ width: 800, height: 600 }}>
      <ReactFlowEditor nodes={nodes} edges={edges} onChange={() => {}} />
    </div>
  );
}

describe("ReactFlowEditor", () => {
  test("renders Background, Controls, and MiniMap chrome", () => {
    render(harness([makeFlatNode("a")]));

    const root = screen.getByTestId("rf-editor");
    expect(root.querySelector(".react-flow__background")).toBeTruthy();
    expect(root.querySelector(".react-flow__controls")).toBeTruthy();
    expect(root.querySelector(".react-flow__minimap")).toBeTruthy();
    expect(screen.getByTestId("rf-mock-flow").getAttribute("data-auto-pan-on-connect")).toBe(
      "false",
    );
  });

  test("drop event with palette MIME creates a node", () => {
    const onChange = vi.fn();
    render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowEditor nodes={[]} edges={[]} onChange={onChange} />
      </div>,
    );

    const dropZone = screen.getByTestId("rf-editor-dropzone");
    const data = new Map<string, string>([[PALETTE_DRAG_MIME, "NoAction"]]);
    const dataTransfer = {
      getData: (k: string) => data.get(k) ?? "",
      types: Array.from(data.keys()),
      dropEffect: "move",
    } as unknown as DataTransfer;
    fireEvent.dragOver(dropZone, { dataTransfer });
    fireEvent.drop(dropZone, {
      dataTransfer,
      clientX: 200,
      clientY: 200,
    });

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    const [nextNodes] = lastCall as [GraphNode[], GraphEdge[]];
    expect(nextNodes.length).toBe(1);
    expect(nextNodes[0]?.type).toBe("NoAction");
    expect(nextNodes[0]?.data.kind).toBe("NoAction");
    expect(nextNodes[0]?.id).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  });

  test("generated node ids are CEL-safe slugs", () => {
    const first = createWorkflowNode("Script", [], { x: 0, y: 0 });
    const second = createWorkflowNode("Script", [first], { x: 0, y: 0 });

    expect(first.id).toBe("Script_1");
    expect(second.id).toBe("Script_2");
  });

  test("renders input handles on the left and output handles on the right", () => {
    render(harness([makeFlatNode("a")]));

    const node = screen.getByTestId("rf-node-NoAction-a");
    expect(node.querySelector('[data-handle-id="input"]')?.getAttribute("data-position")).toBe(
      "left",
    );
    expect(node.querySelector('[data-handle-id="output"]')?.getAttribute("data-position")).toBe(
      "right",
    );
  });

  test("renders draggable named slot handles outside the node when assistance is enabled", () => {
    const node: GraphNode = {
      id: "slots",
      type: "NoAction",
      position: { x: 0, y: 0 },
      data: {
        id: "slots",
        name: "slots",
        kind: "NoAction",
        raw: {
          type: "NoAction",
          id: "slots",
          name: "slots",
          inputSlots: [{ type: "File", descriptor: "input", optional: false, isBatch: false }],
          outputSlots: [
            {
              type: "File",
              descriptor: "output",
              optional: false,
              origin: "CollectedOut",
              isBatch: false,
            },
          ],
        },
      },
    };
    render(<ReactFlowEditor nodes={[node]} edges={[]} onChange={() => {}} connectionAssist />);

    const rendered = screen.getByTestId("rf-node-NoAction-slots");
    const input = rendered.querySelector('[data-handle-id="input:input"]');
    const output = rendered.querySelector('[data-handle-id="output:output"]');
    expect(input?.getAttribute("data-position")).toBe("left");
    expect(output?.getAttribute("data-position")).toBe("right");
    expect(input?.className).toContain("!pointer-events-auto");
    expect(output?.className).toContain("!pointer-events-auto");
    expect(updateNodeInternals).toHaveBeenCalledWith("slots");
  });

  test("spaces multiple assisted slots with stable offsets", () => {
    const node: GraphNode = {
      id: "multi-slots",
      type: "NoAction",
      position: { x: 0, y: 0 },
      data: {
        id: "multi-slots",
        name: "multi-slots",
        kind: "NoAction",
        raw: {
          type: "NoAction",
          id: "multi-slots",
          name: "multi-slots",
          inputSlots: [
            { type: "Text", descriptor: "steps", optional: false },
            { type: "File", descriptor: "structure", optional: false, isBatch: false },
          ],
        },
      },
    };
    render(<ReactFlowEditor nodes={[node]} edges={[]} onChange={() => {}} connectionAssist />);

    const rendered = screen.getByTestId("rf-node-NoAction-multi-slots");
    const steps = rendered.querySelector('[data-handle-id="input:steps"]')?.parentElement;
    const structure = rendered.querySelector('[data-handle-id="input:structure"]')?.parentElement;
    expect(steps?.style.top).toBe("50%");
    expect(structure?.style.top).toBe("50%");
    expect(steps?.style.transform).not.toBe(structure?.style.transform);
    expect(steps?.className).toContain("min-w-max");
  });

  test("keeps the origin slot mounted while filtering connection targets", () => {
    const source: GraphNode = {
      id: "source",
      type: "NoAction",
      position: { x: 0, y: 0 },
      data: {
        id: "source",
        name: "source",
        kind: "NoAction",
        raw: {
          type: "NoAction",
          id: "source",
          name: "source",
          outputSlots: [
            {
              type: "File",
              descriptor: "log",
              optional: false,
              origin: "CollectedOut",
              isBatch: false,
            },
          ],
        },
      },
    };
    const target: GraphNode = {
      id: "target",
      type: "NoAction",
      position: { x: 240, y: 0 },
      data: {
        id: "target",
        name: "target",
        kind: "NoAction",
        raw: {
          type: "NoAction",
          id: "target",
          name: "target",
          inputSlots: [
            { type: "Text", descriptor: "steps", optional: false },
            { type: "File", descriptor: "structure", optional: false, isBatch: false },
          ],
          outputSlots: [
            {
              type: "File",
              descriptor: "result",
              optional: false,
              origin: "CollectedOut",
              isBatch: false,
            },
          ],
        },
      },
    };
    render(
      <ReactFlowEditor nodes={[source, target]} edges={[]} onChange={() => {}} connectionAssist />,
    );

    const sourceNode = screen.getByTestId("rf-node-NoAction-source");
    const targetNode = screen.getByTestId("rf-node-NoAction-target");
    const targetPositionBefore = targetNode.querySelector('[data-handle-id="input:structure"]')
      ?.parentElement?.style.transform;

    fireEvent.click(screen.getByTestId("rf-mock-connect-start"));

    expect(sourceNode.querySelector('[data-handle-id="output:log"]')).toBeTruthy();
    expect(
      sourceNode.querySelector('[data-handle-id="output:log"]')?.parentElement?.className,
    ).toContain("opacity-100");
    const targetInput = targetNode.querySelector('[data-handle-id="input:structure"]');
    expect(targetInput).toBeTruthy();
    expect(targetInput?.parentElement?.className).toContain("opacity-100");
    expect(targetInput?.parentElement?.style.transform).toBe(targetPositionBefore);
    expect(targetNode.querySelector('[data-handle-id="input:steps"]')).toBeNull();
    expect(targetNode.querySelector('[data-handle-id="output:result"]')).toBeNull();
  });

  test("dropping an output connection on a palette item requests a connected node", () => {
    const onRequestCreate = vi.fn();
    const source = makeFlatNode("source");
    const paletteItem = document.createElement("button");
    paletteItem.dataset.nodeKind = "NoAction";
    document.body.appendChild(paletteItem);
    const elementFromPoint = vi.spyOn(document, "elementFromPoint").mockReturnValue(paletteItem);
    render(
      <ReactFlowEditor
        nodes={[source]}
        edges={[]}
        onChange={() => {}}
        onRequestCreate={onRequestCreate}
      />,
    );

    fireEvent.click(screen.getByTestId("rf-mock-connect-to-palette"));

    expect(onRequestCreate).toHaveBeenCalledWith({
      kind: "NoAction",
      connectFrom: "source",
      position: { x: 300, y: 0 },
    });
    elementFromPoint.mockRestore();
    paletteItem.remove();
  });

  test("connecting nodes opens slot mapping before creating the relation", () => {
    const onChange = vi.fn();
    const source: GraphNode = {
      id: "source",
      type: "SoftwareUsecaseComputing",
      position: { x: 0, y: 0 },
      data: {
        id: "source",
        name: "Producer",
        kind: "SoftwareUsecaseComputing",
        raw: {
          type: "SoftwareUsecaseComputing",
          id: "source",
          name: "Producer",
          usecaseVersionId: "11111111-1111-4111-8111-111111111111",
          softwareVersionId: "22222222-2222-4222-8222-222222222222",
          outputSlots: [
            {
              type: "File",
              descriptor: "result",
              optional: false,
              origin: "UsecaseOut",
              isBatch: false,
            },
          ],
        },
      },
    };
    const target: GraphNode = {
      id: "target",
      type: "Script",
      position: { x: 200, y: 0 },
      data: {
        id: "target",
        name: "Consumer",
        kind: "Script",
        raw: {
          type: "Script",
          id: "target",
          name: "Consumer",
          source: { type: "Inline", language: "python", content: "" },
          runtimeProfileId: "00000000-0000-0000-0000-000000000001",
          executionIdentity: { type: "MappedAuto" },
          schedulingStrategy: { type: "Auto" },
          inputs: { result: { type: "File", required: true } },
          outputs: {},
          inputSlots: [{ type: "File", descriptor: "result", optional: false, isBatch: false }],
        },
      },
    };
    render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowEditor nodes={[source, target]} edges={[]} onChange={onChange} />
      </div>,
    );

    fireEvent.click(screen.getByTestId("rf-mock-connect"));
    expect(screen.getByTestId("workflow-slot-mapping-dialog")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId("workflow-slot-mapping-confirm") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByText("workflow.editor.slotMapping.visualMode")).toBeTruthy();
    expect(screen.getByTestId("workflow-slot-source-result").getAttribute("draggable")).toBe(
      "true",
    );
    fireEvent.click(screen.getByTestId("workflow-slot-mapping-confirm"));

    const nextEdges = onChange.mock.calls.at(-1)?.[1] as GraphEdge[];
    expect(nextEdges[0]?.slotRelations).toEqual([
      {
        fromSlot: "result",
        toSlot: "result",
        transferStrategy: { type: "Network" },
      },
    ]);
  });

  test("assisted named-slot connections merge into one edge without opening the dialog", () => {
    const onChange = vi.fn();
    const source: GraphNode = {
      id: "source",
      type: "NoAction",
      position: { x: 0, y: 0 },
      data: {
        id: "source",
        name: "Producer",
        kind: "NoAction",
        raw: {
          type: "NoAction",
          id: "source",
          name: "Producer",
          outputSlots: [
            {
              type: "File",
              descriptor: "result",
              optional: false,
              origin: "CollectedOut",
              isBatch: false,
            },
            {
              type: "File",
              descriptor: "report",
              optional: false,
              origin: "CollectedOut",
              isBatch: false,
            },
          ],
        },
      },
    };
    const target: GraphNode = {
      id: "target",
      type: "NoAction",
      position: { x: 240, y: 0 },
      data: {
        id: "target",
        name: "Consumer",
        kind: "NoAction",
        raw: {
          type: "NoAction",
          id: "target",
          name: "Consumer",
          inputSlots: [
            { type: "File", descriptor: "result", optional: false, isBatch: false },
            { type: "File", descriptor: "metadata", optional: false, isBatch: false },
          ],
        },
      },
    };
    const view = render(
      <ReactFlowEditor nodes={[source, target]} edges={[]} onChange={onChange} connectionAssist />,
    );

    fireEvent.click(screen.getByTestId("rf-mock-connect-slots"));
    expect(screen.queryByTestId("workflow-slot-mapping-dialog")).toBeNull();
    const firstEdges = onChange.mock.calls.at(-1)?.[1] as GraphEdge[];
    expect(firstEdges).toHaveLength(1);

    view.rerender(
      <ReactFlowEditor
        nodes={[source, target]}
        edges={firstEdges}
        onChange={onChange}
        connectionAssist
      />,
    );
    fireEvent.click(screen.getByTestId("rf-mock-connect-second-slots"));
    const mergedEdges = onChange.mock.calls.at(-1)?.[1] as GraphEdge[];
    expect(mergedEdges).toHaveLength(1);
    expect(mergedEdges[0]?.slotRelations).toEqual([
      { fromSlot: "result", toSlot: "result", transferStrategy: { type: "Network" } },
      { fromSlot: "report", toSlot: "metadata", transferStrategy: { type: "Network" } },
    ]);
  });

  test("hovering a mapped node replaces the generic edge with slot-specific edges", () => {
    const source: GraphNode = {
      id: "source",
      type: "NoAction",
      position: { x: 0, y: 0 },
      data: {
        id: "source",
        name: "Producer",
        kind: "NoAction",
        raw: {
          type: "NoAction",
          id: "source",
          name: "Producer",
          outputSlots: [
            {
              type: "File",
              descriptor: "result",
              optional: false,
              origin: "CollectedOut",
              isBatch: false,
            },
          ],
        },
      },
    };
    const target: GraphNode = {
      id: "target",
      type: "NoAction",
      position: { x: 240, y: 0 },
      data: {
        id: "target",
        name: "Consumer",
        kind: "NoAction",
        raw: {
          type: "NoAction",
          id: "target",
          name: "Consumer",
          inputSlots: [{ type: "File", descriptor: "input", optional: false, isBatch: false }],
        },
      },
    };
    const edge: GraphEdge = {
      id: "source->target",
      source: "source",
      target: "target",
      slotRelations: [
        { fromSlot: "result", toSlot: "input", transferStrategy: { type: "Network" } },
      ],
    };
    render(
      <ReactFlowEditor
        nodes={[source, target]}
        edges={[edge]}
        onChange={() => {}}
        connectionAssist
      />,
    );

    fireEvent.mouseEnter(screen.getByTestId("rf-node-NoAction-source"));

    expect(screen.getByTestId("rf-mock-edge-source->target").dataset.hidden).toBe("true");
    const mappedEdge = screen.getByTestId("rf-mock-edge-source->target::0:result->input");
    expect(mappedEdge.dataset.mapped).toBe("true");
    expect(
      screen
        .getByTestId("rf-node-NoAction-source")
        .querySelector('[data-handle-id="output:result"]'),
    ).toBeTruthy();
    expect(
      screen.getByTestId("rf-node-NoAction-target").querySelector('[data-handle-id="input:input"]'),
    ).toBeTruthy();
  });

  test("clicking an edge selects its logical relation", () => {
    const onEdgeSelectionChange = vi.fn();
    const edge: GraphEdge = {
      id: "a->b",
      source: "a",
      target: "b",
      slotRelations: [],
    };
    render(
      <ReactFlowEditor
        nodes={[makeFlatNode("a"), makeFlatNode("b")]}
        edges={[edge]}
        onChange={() => {}}
        onEdgeSelectionChange={onEdgeSelectionChange}
      />,
    );

    fireEvent.click(screen.getByTestId("rf-mock-edge-a->b"));
    expect(onEdgeSelectionChange).toHaveBeenCalledWith("a->b");
  });

  test("delegates usecase creation before inserting a placeholder node", () => {
    const onChange = vi.fn();
    const onRequestCreate = vi.fn();
    render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowEditor
          nodes={[]}
          edges={[]}
          onChange={onChange}
          onRequestCreate={onRequestCreate}
        />
      </div>,
    );

    const dataTransfer = {
      getData: (key: string) => (key === PALETTE_DRAG_MIME ? "SoftwareUsecaseComputing" : ""),
      types: [PALETTE_DRAG_MIME],
      dropEffect: "move",
    } as unknown as DataTransfer;
    fireEvent.drop(screen.getByTestId("rf-editor-dropzone"), {
      dataTransfer,
      clientX: 320,
      clientY: 180,
    });

    expect(onRequestCreate).toHaveBeenCalledWith({
      kind: "SoftwareUsecaseComputing",
      position: { x: 0, y: 0 },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("clicking a node fires onSelectionChange with that node id", () => {
    const onSelectionChange = vi.fn();
    render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowEditor
          nodes={[makeFlatNode("a")]}
          edges={[]}
          onChange={() => {}}
          onSelectionChange={onSelectionChange}
        />
      </div>,
    );

    const node = screen.getByTestId("rf-node-NoAction-a");
    fireEvent.click(node);
    expect(onSelectionChange).toHaveBeenCalled();
    expect(onSelectionChange.mock.calls.at(-1)?.[0]).toBe("a");
  });
});
