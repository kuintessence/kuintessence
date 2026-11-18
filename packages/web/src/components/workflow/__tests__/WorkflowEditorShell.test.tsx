/**
 * Shell-level tests covering the YAML <-> graph round trip. We keep these
 * narrow: shell wires palette + canvas + properties, but the deep
 * round-trip semantics are covered by yaml-graph-sync's own test suite. Here
 * we just assert the wiring contract.
 *
 * @xyflow/react is stubbed — see the matching ReactFlowEditor /
 * NewWorkflowPage tests for the rationale (hoisted-React + heavy editor
 * incompatible with happy-dom).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../ThemeProvider", () => ({
  useTheme: () => ({ resolved: "light" }),
}));

const { getSandboxScript, listSandboxScripts, listUsecasePackages, listSandboxRuntimeProfiles } =
  vi.hoisted(() => ({
    getSandboxScript: vi.fn(),
    listSandboxRuntimeProfiles: vi.fn(),
    listSandboxScripts: vi.fn(),
    listUsecasePackages: vi.fn(),
  }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock("../../../lib/software-client", () => ({
  listUsecasePackages: (...args: unknown[]) => listUsecasePackages(...args),
}));

vi.mock("../../../lib/sandbox-client", () => ({
  listSandboxRuntimeProfiles: (...args: unknown[]) => listSandboxRuntimeProfiles(...args),
  getSandboxScript: (...args: unknown[]) => getSandboxScript(...args),
  listSandboxScripts: (...args: unknown[]) => listSandboxScripts(...args),
}));

// React Flow stub — same shape as ReactFlowEditor.test.tsx.
vi.mock("@xyflow/react", () => {
  const React = require("react") as typeof import("react");
  function ReactFlow(props: { children?: React.ReactNode }) {
    return React.createElement(
      "div",
      { className: "react-flow", "data-testid": "rf-mock-flow" },
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
  function useReactFlow() {
    return {
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  const applyNodeChanges = (_c: any, nodes: any[]) => nodes;
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  const applyEdgeChanges = (_c: any, edges: any[]) => edges;
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  const addEdge = (edge: any, edges: any[]) => [...edges, edge];
  return {
    ReactFlow,
    ReactFlowProvider,
    Background,
    BackgroundVariant: { Dots: "dots" },
    Controls,
    MiniMap,
    useReactFlow,
    useNodesInitialized: () => false,
    applyNodeChanges,
    applyEdgeChanges,
    addEdge,
  };
});

import { parseWorkflowYaml } from "../../../lib/workflow-parser";
import { WorkflowEditorShell } from "../WorkflowEditorShell";

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderShell(onChange = vi.fn(), value = VALID_YAML) {
  return render(<WorkflowEditorShell value={value} onChange={onChange} />, {
    wrapper: wrapper(),
  });
}

const VALID_YAML = `name: hello
parameters: []
spec:
  nodeDrafts:
    - type: NoAction
      id: a
      name: A
  nodeRelations: []
`;

beforeEach(() => {
  listSandboxRuntimeProfiles.mockResolvedValue([]);
  listUsecasePackages.mockResolvedValue([]);
  listSandboxScripts.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.removeProperty("cursor");
  document.body.style.removeProperty("user-select");
  document.body.style.removeProperty("--resize-test-marker");
});

describe("WorkflowEditorShell", () => {
  test("offers YAML copy and import without replacing the visual canvas", () => {
    renderShell();
    expect(screen.getByTestId("rf-palette")).toBeTruthy();
    expect(screen.getByTestId("rf-shell-copy-yaml")).toBeTruthy();
    expect(screen.getByTestId("rf-shell-import-yaml")).toBeTruthy();
    expect(screen.getByTestId("rf-shell-copy-yaml").getAttribute("title")).toBe(
      "workflow.editor.copyYaml",
    );
    expect(screen.getByTestId("rf-shell-import-yaml").getAttribute("title")).toBe(
      "workflow.editor.importYaml",
    );
    expect(screen.queryByTestId("rf-shell-toggle-yaml")).toBeNull();
  });

  test("keeps an empty canvas valid after layout beautification", () => {
    const onChange = vi.fn();
    const emptyYaml = `name: empty
parameters: []
spec:
  nodeDrafts: []
  nodeRelations: []
`;
    renderShell(onChange, emptyYaml);

    fireEvent.click(screen.getByTestId("rf-shell-format"));

    const emitted = String(onChange.mock.calls.at(-1)?.[0]);
    expect(parseWorkflowYaml(emitted).ok).toBe(true);
    expect(screen.queryByTestId("rf-shell-sync-error")).toBeNull();
  });

  test("cancelling a managed-node selection leaves graph and YAML unchanged", async () => {
    const onChange = vi.fn();
    renderShell(onChange);

    fireEvent.click(screen.getByTestId("rf-palette-SoftwareUsecaseComputing"));
    await screen.findByTestId("workflow-usecase-picker-dialog");
    fireEvent.click(screen.getByText("common.cancel"));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("rf-shell-sync-error")).toBeNull();
  });

  test("importing valid YAML updates the parent", async () => {
    const onChange = vi.fn();
    renderShell(onChange);
    const NEW_YAML = `name: bye
parameters: []
spec:
  nodeDrafts:
    - type: NoAction
      id: a
      name: ByeNode
  nodeRelations: []
`;
    const file = new File([NEW_YAML], "workflow.yaml", { type: "text/yaml" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(NEW_YAML) });
    const input = screen.getByTestId("rf-shell-import-yaml").parentElement?.querySelector("input");
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(NEW_YAML));
  });

  test("hides the redundant YAML sync badge and exposes resizable side panels", () => {
    renderShell();

    expect(screen.queryByTestId("rf-shell-sync-ok")).toBeNull();
    expect(screen.getByTestId("rf-left-resize-handle").getAttribute("aria-valuenow")).toBe("200");
    expect(screen.getByTestId("rf-right-resize-handle").getAttribute("aria-valuenow")).toBe("224");

    fireEvent.keyDown(screen.getByTestId("rf-right-resize-handle"), { key: "ArrowLeft" });
    expect(screen.getByTestId("rf-right-resize-handle").getAttribute("aria-valuenow")).toBe("236");
  });

  test.each([
    {
      side: "left",
      movedWidth: "220",
      clampedWidth: "360",
      columns: "360px 6px minmax(0,1fr) 6px 224px",
    },
    {
      side: "right",
      movedWidth: "204",
      clampedWidth: "196",
      columns: "200px 6px minmax(0,1fr) 6px 196px",
    },
  ])("resizes and clamps the $side panel until pointer release", (panel) => {
    renderShell();
    const handle = screen.getByTestId(`rf-${panel.side}-resize-handle`);
    const grid = screen.getByTestId("rf-shell-grid");

    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerMove(document, { clientX: 220, pointerId: 1 });
    expect(handle.getAttribute("aria-valuenow")).toBe(panel.movedWidth);
    fireEvent.pointerMove(document, { clientX: 500, pointerId: 1 });
    expect(handle.getAttribute("aria-valuenow")).toBe(panel.clampedWidth);

    fireEvent.pointerUp(document, { pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 200, pointerId: 1 });
    expect(grid.style.getPropertyValue("--workflow-editor-columns")).toBe(panel.columns);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  test.each([
    ["pointer cancellation", () => fireEvent.pointerCancel(document, { pointerId: 1 })],
    ["window blur", () => fireEvent.blur(window)],
    ["window resize", () => fireEvent.resize(window)],
    ["panel collapse", () => fireEvent.click(screen.getByTestId("rf-palette-collapse"))],
  ] as const)("ends resizing and restores page styles on %s", (_reason, endResize) => {
    renderShell();
    const handle = screen.getByTestId("rf-left-resize-handle");
    document.body.style.cursor = "wait";
    document.body.style.userSelect = "text";

    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 220, pointerId: 1 });
    document.body.style.setProperty("--resize-test-marker", "retained");
    endResize();

    expect(document.body.style.cursor).toBe("wait");
    expect(document.body.style.userSelect).toBe("text");
    expect(document.body.style.getPropertyValue("--resize-test-marker")).toBe("retained");
    fireEvent.pointerMove(document, { clientX: 240, pointerId: 1 });
    expect(handle.getAttribute("aria-valuenow")).toBe("220");
  });

  test.each([
    ["left", "240", "224"],
    ["right", "220", "204"],
  ] as const)("replaces an active drag when the %s handle starts one", (side, leftWidth, rightWidth) => {
    renderShell();
    const left = screen.getByTestId("rf-left-resize-handle");
    const right = screen.getByTestId("rf-right-resize-handle");
    document.body.style.cursor = "wait";
    document.body.style.userSelect = "text";

    fireEvent.pointerDown(left, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 220, pointerId: 1 });
    fireEvent.pointerDown(side === "left" ? left : right, { clientX: 300, pointerId: 2 });
    if (side === "right") fireEvent.click(screen.getByTestId("rf-palette-collapse"));

    fireEvent.pointerMove(document, { clientX: 280, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    fireEvent.pointerCancel(document, { pointerId: 1 });
    expect(left.getAttribute("aria-valuenow")).toBe("220");
    expect(right.getAttribute("aria-valuenow")).toBe("224");
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.pointerMove(document, { clientX: 320, pointerId: 2 });
    expect(left.getAttribute("aria-valuenow")).toBe(leftWidth);
    expect(right.getAttribute("aria-valuenow")).toBe(rightWidth);

    fireEvent.pointerUp(document, { pointerId: 2 });
    expect(document.body.style.cursor).toBe("wait");
    expect(document.body.style.userSelect).toBe("text");
  });

  test("restores page styles on unmount and ignores later pointer events", () => {
    const { unmount } = renderShell();
    const handle = screen.getByTestId("rf-left-resize-handle");
    document.body.style.cursor = "wait";
    document.body.style.userSelect = "text";

    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 });
    unmount();
    expect(document.body.style.cursor).toBe("wait");
    expect(document.body.style.userSelect).toBe("text");

    document.body.style.cursor = "crosshair";
    document.body.style.userSelect = "all";
    fireEvent.pointerMove(document, { clientX: 250, pointerId: 1 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(document.body.style.cursor).toBe("crosshair");
    expect(document.body.style.userSelect).toBe("all");
  });

  test("formats the workflow and toggles precise connection assistance", () => {
    const onChange = vi.fn();
    renderShell(onChange);

    const assist = screen.getByTestId("rf-shell-connection-assist");
    expect(assist.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(assist);
    expect(assist.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTestId("rf-shell-format"));
    expect(onChange).toHaveBeenCalled();

    const animation = screen.getByTestId("rf-shell-flow-animation") as HTMLSelectElement;
    expect(animation.value).toBe("hover");
    expect(Array.from(animation.options).map((option) => option.value)).toEqual([
      "off",
      "hover",
      "click",
      "always",
    ]);
    fireEvent.change(animation, { target: { value: "always" } });
    expect(animation.value).toBe("always");
  });

  test("choosing a repository usecase creates a bound localized node", async () => {
    vi.useRealTimers();
    const packageId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const softwareRevisionId = "3f2504e0-4f89-41d3-9a0c-0305e82c3311";
    listUsecasePackages.mockResolvedValue([
      {
        id: packageId,
        publishedSoftwareRevisionId: softwareRevisionId,
        name: "分子动力学分析",
        version: "1.0.0",
        description: "已发布的计算用例",
        spec: {
          usecase: { commandFile: "run.sh", inputSlots: [] },
          software: {
            kind: "Spack",
            name: "gromacs",
            argumentList: [],
          },
          arguments: [],
          environments: [],
          filesomeInputs: [],
          filesomeOutputs: [],
          valueOutputs: [],
        },
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    ]);
    const onChange = vi.fn();
    renderShell(onChange);

    fireEvent.click(screen.getByTestId("rf-palette-SoftwareUsecaseComputing"));
    const option = await screen.findByTestId(`workflow-usecase-option-${packageId}`);
    fireEvent.doubleClick(option);

    const yaml = String(onChange.mock.calls.at(-1)?.[0]);
    expect(yaml).toContain("分子动力学分析");
    expect(yaml).toContain(`usecaseVersionId: ${packageId}`);
    expect(yaml).toContain(`softwareVersionId: ${softwareRevisionId}`);
  });

  test("keeps a package without a published software revision disabled", async () => {
    const packageId = "3f2504e0-4f89-41d3-9a0c-0305e82c3321";
    listUsecasePackages.mockResolvedValue([
      {
        id: packageId,
        name: "Unpublished software reference",
        version: "1.0.0",
        description: "The package is visible but its software is not published.",
        spec: {
          usecase: { commandFile: "run.sh", inputSlots: [] },
          software: { kind: "Spack", name: "gromacs", argumentList: [] },
          arguments: [],
          environments: [],
          filesomeInputs: [],
          filesomeOutputs: [],
          valueOutputs: [],
        },
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    ]);
    const onChange = vi.fn();
    renderShell(onChange);

    fireEvent.click(screen.getByTestId("rf-palette-SoftwareUsecaseComputing"));
    const option = await screen.findByTestId(`workflow-usecase-option-${packageId}`);
    expect(option.getAttribute("disabled")).not.toBeNull();
    fireEvent.doubleClick(option);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("creates Dataset slots from a governed usecase contract while retaining material slots", async () => {
    vi.useRealTimers();
    const packageId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    listUsecasePackages.mockResolvedValue([
      {
        id: packageId,
        publishedSoftwareRevisionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3312",
        name: "Dataset analysis",
        version: "2.0.0",
        description: "Governed dataset input",
        spec: {
          softwareRef: {
            source: "official-upstream",
            name: "trajectory-analyzer",
            version: "1.0.0",
          },
          inputs: [
            {
              descriptor: "trajectory",
              type: "Dataset",
              required: true,
            },
          ],
          usecase: {
            commandFile: "run.sh",
            inputSlots: [
              { kind: "Text", descriptor: "steps", refMaterials: [] },
              {
                kind: "File",
                descriptor: "structure",
                refMaterials: [{ kind: "FileInputRef", descriptor: "structure" }],
              },
              {
                kind: "File",
                descriptor: "trajectory",
                refMaterials: [{ kind: "FileInputRef", descriptor: "trajectory" }],
              },
            ],
          },
          software: { kind: "Bare" },
          arguments: [],
          environments: [],
          filesomeInputs: [
            { descriptor: "structure", fileKind: { kind: "Normal", name: "input.gro" } },
            { descriptor: "trajectory", fileKind: { kind: "Batched", pattern: "*.xtc" } },
          ],
          filesomeOutputs: [],
          valueOutputs: [],
        },
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    ]);
    const onChange = vi.fn();
    renderShell(onChange);

    fireEvent.click(screen.getByTestId("rf-palette-SoftwareUsecaseComputing"));
    fireEvent.doubleClick(await screen.findByTestId(`workflow-usecase-option-${packageId}`));

    const yaml = String(onChange.mock.calls.at(-1)?.[0]);
    expect(yaml).toContain("descriptor: steps");
    expect(yaml).toContain("descriptor: structure");
    expect(yaml).toContain("expectedFileName: input.gro");
    expect(yaml).toContain("descriptor: trajectory");
    expect(yaml).toContain("type: Dataset");
    expect(yaml.match(/descriptor: trajectory/g)).toHaveLength(1);
  });

  test.each([
    "double click",
    "select and add",
  ])("adds a standalone script to an empty workflow via %s", async (method) => {
    vi.useRealTimers();
    const assetId = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
    const runtimeContractRef = { name: "python-3.12-stdlib-v1", version: "1" };
    const payload = {
      kind: "sandbox-script",
      language: "python",
      runtimeContractRef,
      entrypoint: "main.py",
      content: "print('ok')",
      sha256: "a".repeat(64),
      inputs: { source: { type: "File" } },
      outputs: {
        result: {
          type: "JSON",
          required: true,
        },
      },
    };
    const asset = {
      id: assetId,
      kind: "sandbox-script",
      name: "轨迹格式转换",
      version: "1.2.0",
      source: "platform",
      lifecycle: "published",
      visibility: "public",
      ownerUserId: null,
      ownerOrgId: null,
      providerOrgId: null,
      payload,
      trustedForGlobalUse: true,
      sharedAccountEligible: true,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    listSandboxScripts.mockResolvedValue([asset]);
    getSandboxScript.mockResolvedValue({
      asset,
      attestations: [],
      revisions: [
        {
          id: "3f2504e0-4f89-41d3-9a0c-0305e82c3304",
          assetId,
          revision: 3,
          payload,
          provenance: {},
          contentSha256: "a".repeat(64),
          createdBy: null,
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    });
    const onChange = vi.fn();
    listUsecasePackages.mockClear();
    renderShell(
      onChange,
      "name: empty\nparameters: []\nspec:\n  nodeDrafts: []\n  nodeRelations: []\n",
    );

    fireEvent.click(screen.getByTestId("rf-palette-Script"));
    const option = await screen.findByTestId(`workflow-script-option-${assetId}`);
    if (method === "double click") fireEvent.doubleClick(option);
    else {
      fireEvent.click(option);
      fireEvent.click(screen.getByTestId("workflow-script-apply"));
    }

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const yaml = String(onChange.mock.calls.at(-1)?.[0]);
    expect(yaml).toContain("轨迹格式转换");
    expect(yaml).toContain("type: AssetRevision");
    expect(yaml).toContain(`assetId: ${assetId}`);
    expect(yaml).toContain("revision: 3");
    expect(yaml).toContain("runtimeContractRef:");
    expect(yaml).toContain("python-3.12-stdlib-v1");
    expect(yaml).toContain(`sha256: ${"a".repeat(64)}`);
    expect(yaml).not.toContain("SoftwareUsecaseComputing");
    expect(listUsecasePackages).not.toHaveBeenCalled();
    expect(yaml).toContain("optional: false");
    expect(yaml).toContain("durability: Ephemeral");
    expect(screen.getByText(/workflow.editor.properties.locality.Auto/)).toBeDefined();
    expect(yaml).not.toContain("outputSlots:");
    expect(parseWorkflowYaml(yaml).ok).toBe(true);
  });
});

test("changing a managed usecase refreshes input and output contracts in YAML", async () => {
  const first = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const second = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
  const revision = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const pkg = (id: string, name: string, descriptor: string) => ({
    id,
    name,
    version: "1.0.0",
    publishedSoftwareRevisionId: revision,
    spec: {
      usecase: {
        commandFile: "run.sh",
        inputSlots: [{ kind: "Text", descriptor, refMaterials: [] }],
      },
      software: { kind: "Spack", name: "demo", argumentList: [] },
      arguments: [],
      environments: [],
      filesomeInputs: [],
      filesomeOutputs: [],
      valueOutputs: [],
    },
    createdAt: "2026-01-01T00:00:00Z",
  });
  listUsecasePackages.mockResolvedValue([
    pkg(first, "First", "original"),
    pkg(second, "Second", "replacement"),
  ]);
  const changed = vi.fn();
  renderShell(changed);
  fireEvent.click(screen.getByTestId("rf-palette-SoftwareUsecaseComputing"));
  fireEvent.doubleClick(await screen.findByTestId(`workflow-usecase-option-${first}`));
  fireEvent.click(await screen.findByTestId("rf-prop-usecase-version-select"));
  fireEvent.click(screen.getByRole("option", { name: /Second/ }));
  const result = String(changed.mock.calls.at(-1)?.[0]);
  expect(result).toContain(`usecaseVersionId: ${second}`);
  expect(result).toContain("descriptor: replacement");
  expect(result).not.toContain("descriptor: original");
});
