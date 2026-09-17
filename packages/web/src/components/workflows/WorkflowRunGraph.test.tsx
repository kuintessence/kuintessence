/**
 * Tests for the read-only run-graph view. Like ReactFlowEditor.test.tsx we
 * stub @xyflow/react so happy-dom doesn't have to boot React Flow's viewport
 * machinery — the stub renders each node through nothing but exposes the
 * node-level test ids/labels/status the component computes, which is what we
 * assert on. @dagrejs/dagre is pure and left to run for real.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("../ThemeProvider", () => ({
  useTheme: () => ({ theme: "light", resolved: "light", setTheme: () => {} }),
}));

vi.mock("@xyflow/react", () => {
  const React = require("react") as typeof import("react");
  interface StubNode {
    id: string;
    data: { label: string; kind: string; status: string };
  }
  function ReactFlow(props: {
    children?: React.ReactNode;
    nodes?: StubNode[];
    edges?: Array<{ id: string; style?: { stroke?: string } }>;
  }) {
    return React.createElement(
      "div",
      { className: "react-flow", "data-testid": "run-graph" },
      (props.nodes ?? []).map((n) =>
        React.createElement(
          "div",
          {
            key: n.id,
            "data-testid": `run-node-${n.id}`,
            "data-status": n.data.status,
          },
          `${n.data.label} · ${n.data.kind} · ${n.data.status}`,
        ),
      ),
      (props.edges ?? []).map((edge) =>
        React.createElement("span", {
          key: edge.id,
          "data-testid": `run-edge-${edge.id}`,
          "data-stroke": edge.style?.stroke,
        }),
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
  return {
    ReactFlow,
    Background,
    BackgroundVariant: { Dots: "dots" },
    Controls,
    Handle: () => React.createElement("span"),
    MarkerType: { ArrowClosed: "arrowclosed" },
    Position: { Left: "left", Right: "right" },
  };
});

import { WorkflowRunGraph } from "./WorkflowRunGraph";

const graph = {
  nodes: [
    { id: "a", name: "Solve", kind: "SoftwareUsecaseComputing" },
    { id: "b", name: "Post", kind: "Script" },
  ],
  edges: [{ source: "a", target: "b" }],
};

describe("WorkflowRunGraph", () => {
  test("renders each node with its name and kind", () => {
    render(<WorkflowRunGraph graph={graph} statusByNode={{ a: "Succeeded", b: "Running" }} />);

    const a = screen.getByTestId("run-node-a");
    const b = screen.getByTestId("run-node-b");
    expect(a.textContent).toContain("Solve");
    expect(b.textContent).toContain("Post");
  });

  test("reflects each node's live status", () => {
    render(<WorkflowRunGraph graph={graph} statusByNode={{ a: "Succeeded", b: "Running" }} />);

    expect(screen.getByTestId("run-node-a").getAttribute("data-status")).toBe("Succeeded");
    expect(screen.getByTestId("run-node-b").getAttribute("data-status")).toBe("Running");
  });

  test("defaults missing status to Pending", () => {
    render(<WorkflowRunGraph graph={graph} statusByNode={{ a: "Succeeded" }} />);

    expect(screen.getByTestId("run-node-b").getAttribute("data-status")).toBe("Pending");
  });

  test("colors completed, active, failed, and pending relations by runtime state", () => {
    const { rerender } = render(
      <WorkflowRunGraph graph={graph} statusByNode={{ a: "Succeeded", b: "Succeeded" }} />,
    );
    expect(screen.getByTestId("run-edge-a->b").getAttribute("data-stroke")).toBe(
      "var(--status-succeeded)",
    );

    rerender(<WorkflowRunGraph graph={graph} statusByNode={{ a: "Succeeded", b: "Running" }} />);
    expect(screen.getByTestId("run-edge-a->b").getAttribute("data-stroke")).toBe(
      "var(--status-running)",
    );

    rerender(<WorkflowRunGraph graph={graph} statusByNode={{ a: "Failed", b: "Pending" }} />);
    expect(screen.getByTestId("run-edge-a->b").getAttribute("data-stroke")).toBe(
      "var(--status-failed)",
    );

    rerender(<WorkflowRunGraph graph={graph} statusByNode={{ a: "Pending", b: "Pending" }} />);
    expect(screen.getByTestId("run-edge-a->b").getAttribute("data-stroke")).toBe(
      "var(--status-pending)",
    );
  });
});
