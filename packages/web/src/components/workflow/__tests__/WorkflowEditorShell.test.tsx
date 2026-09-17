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

const { getSandboxScript, listSandboxScripts, listUsecasePackages } = vi.hoisted(() => ({
  getSandboxScript: vi.fn(),
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
  listUsecasePackages.mockResolvedValue([]);
  listSandboxScripts.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
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

  test("choosing a data transformation script pins its managed revision", async () => {
    vi.useRealTimers();
    const assetId = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
    const runtimeProfileId = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
    const payload = {
      kind: "sandbox-script",
      language: "python",
      runtimeProfileId,
      entrypoint: "main.py",
      content: "print('ok')",
      inputs: { source: { type: "File", required: true } },
      outputs: {
        result: {
          type: "JSON",
          required: true,
          locality: { type: "Auto" },
          durability: "Ephemeral",
          sizeHint: { type: "SizeClass", value: "Small" },
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
    renderShell(onChange);

    fireEvent.click(screen.getByTestId("rf-palette-Script"));
    const option = await screen.findByTestId(`workflow-script-option-${assetId}`);
    fireEvent.doubleClick(option);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const yaml = String(onChange.mock.calls.at(-1)?.[0]);
    expect(yaml).toContain("轨迹格式转换");
    expect(yaml).toContain("type: AssetRevision");
    expect(yaml).toContain(`assetId: ${assetId}`);
    expect(yaml).toContain("revision: 3");
    expect(yaml).toContain(`runtimeProfileId: ${runtimeProfileId}`);
    expect(yaml).not.toContain("outputSlots:");
    expect(parseWorkflowYaml(yaml).ok).toBe(true);
  });
});
