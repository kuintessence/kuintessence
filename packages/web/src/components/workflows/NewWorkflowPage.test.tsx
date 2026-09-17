/**
 * NewWorkflowPage tests. WorkflowEditorShell, the router, i18n, toast,
 * and the API are stubbed — the page logic under test is workflow validation + submit
 * to the canonical async workflow endpoint, not the editor internals.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  get,
  getWorkflowTemplate,
  listWorkflowTemplatePage,
  navigate,
  post,
  put,
  uploadFileToNetDrive,
} = vi.hoisted(() => ({
  get: vi.fn(),
  getWorkflowTemplate: vi.fn(),
  listWorkflowTemplatePage: vi.fn(),
  navigate: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  uploadFileToNetDrive: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : (opts?.defaultValue ?? key),
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../lib/api-client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
  },
  uploadFileToNetDrive: (...args: unknown[]) => uploadFileToNetDrive(...args),
  ApiError: class extends Error {},
}));
vi.mock("../../lib/software-client", () => ({
  consumePendingTemplate: () => null,
  getWorkflowTemplate: (...args: unknown[]) => getWorkflowTemplate(...args),
  listWorkflowTemplatePage: (...args: unknown[]) => listWorkflowTemplatePage(...args),
}));
// Stub the editor shell with a controlled textarea so tests can drive the YAML.
vi.mock("../workflow/WorkflowEditorShell", () => ({
  WorkflowEditorShell: ({
    actions,
    value,
    onChange,
  }: {
    actions?: ReactNode;
    value: string;
    onChange: (s: string) => void;
  }) => {
    const React = require("react") as typeof import("react");
    return React.createElement(
      "div",
      null,
      React.createElement("textarea", {
        "data-testid": "yaml-input",
        value,
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
      }),
      actions,
    );
  },
}));

import { fireEvent } from "@testing-library/react";
import { NewWorkflowPage } from "./NewWorkflowPage";

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function renderPage() {
  return render(<NewWorkflowPage />, { wrapper: wrapper() });
}

function startFromScratch() {
  fireEvent.click(screen.getByTestId("workflow-start-scratch"));
}

function openReview() {
  fireEvent.click(screen.getByTestId("workflow-step-review"));
}

function confirmSubmit() {
  fireEvent.click(screen.getByTestId("submit-workflow"));
  expect(screen.getByTestId("workflow-submit-confirm-dialog")).toBeTruthy();
  fireEvent.click(screen.getByTestId("workflow-submit-confirm"));
}

const QUEUE_ID = "88888888-8888-4888-8888-888888888301";

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/workflows/new");
});

const WORKFLOW_DOC = `name: cf
spec:
  nodeDrafts:
    - type: NoAction
      id: a
      name: a
`;

const QUEUED_WORKFLOW_DOC = `name: queued
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: run
      name: run
      usecaseVersionId: 11111111-1111-4111-8111-111111111111
      softwareVersionId: 22222222-2222-4222-8222-222222222222
      schedulingStrategy:
        type: Manual
        queues:
          - ${QUEUE_ID}
`;

const FILE_INPUT_DOC = `name: file-input
parameters: []
spec:
  nodeDrafts:
    - type: NoAction
      id: consume
      name: 文件消费
      inputSlots:
        - descriptor: structure
          type: File
          optional: false
          isBatch: false
          expectedFileName: input.gro
  nodeRelations: []
`;

const DATASET_INPUT_DOC = `name: dataset-input
parameters: []
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: preprocess
      name: Preprocess
      usecaseVersionId: 11111111-1111-4111-8111-111111111101
      softwareVersionId: 22222222-2222-4222-8222-222222222202
      inputSlots:
        - descriptor: trajectory
          type: Dataset
          optional: false
          contents: null
    - type: SoftwareUsecaseComputing
      id: analyze
      name: Analyze
      usecaseVersionId: 11111111-1111-4111-8111-111111111102
      softwareVersionId: 22222222-2222-4222-8222-222222222203
      inputSlots:
        - descriptor: trajectory
          type: Dataset
          optional: false
          contents: null
  nodeRelations: []
`;

const BY_VERSION_SUBWORKFLOW_DOC = `name: referenced-subworkflow
parameters: []
spec:
  nodeDrafts:
    - type: SubWorkflow
      id: nested
      name: Referenced workflow
      maxDepth: 8
      ref:
        kind: ByVersion
        workflowVersionId: 55555555-5555-4555-8555-555555555555
  nodeRelations: []
`;

const DATASET_OPTION = {
  assetId: "33333333-3333-4333-8333-333333333303",
  assetName: "Trajectory corpus",
  assetKind: "scientific-dataset",
  tags: ["trajectory"],
  versionId: "44444444-4444-4444-8444-444444444404",
  version: "release-b",
  manifestDigest: "sha256:trajectory",
  format: "xtc",
  schemaUri: null,
  sizeBytes: 1024,
  input: {
    source: "data-market",
    assetId: "33333333-3333-4333-8333-333333333303",
    versionId: "44444444-4444-4444-8444-444444444404",
    manifestDigest: "sha256:trajectory",
    selectedEntries: [],
  },
};

beforeEach(() => {
  get.mockResolvedValue({ queues: [] });
  uploadFileToNetDrive.mockResolvedValue({
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3399",
    path: "workflows/drafts/test/consume/input.gro",
    size: 3,
    sha256: "a".repeat(64),
  });
  listWorkflowTemplatePage.mockImplementation((input?: { page?: number; q?: string }) =>
    Promise.resolve({
      templates:
        input?.q === "not-found"
          ? []
          : input?.page === 2
            ? [
                {
                  id: "template-page-two",
                  name: "第 25 个模板",
                  version: "2.0.0",
                  description: "第二页模板",
                  yamlContent: WORKFLOW_DOC.replace("name: cf", "name: page-two-template"),
                  tags: ["pipeline"],
                  createdAt: "2026-07-15T00:00:00.000Z",
                },
              ]
            : [
                {
                  id: "template-two-node",
                  name: "两节点流水线",
                  version: "2.0.0",
                  description: "从软件中心加载",
                  yamlContent: WORKFLOW_DOC.replace("name: cf", "name: repository-template"),
                  tags: ["pipeline"],
                  createdAt: "2026-07-15T00:00:00.000Z",
                },
              ],
      tags: ["pipeline"],
      total: input?.q === "not-found" ? 0 : 25,
      page: input?.page ?? 1,
      pageSize: 24,
      totalPages: input?.q === "not-found" ? 1 : 2,
      hasNext: input?.q === "not-found" ? false : input?.page !== 2,
    }),
  );
  getWorkflowTemplate.mockRejectedValue(new Error("Referenced workflow unavailable"));
});

describe("NewWorkflowPage", () => {
  test("shows the four creation steps and initial start decision", () => {
    renderPage();
    expect(screen.getByTestId("new-workflow-page")).toBeTruthy();
    expect(screen.getByTestId("workflow-creation-steps")).toBeTruthy();
    expect(screen.getByTestId("workflow-start-overlay")).toBeTruthy();
    expect(screen.getByTestId("workflow-start-scratch")).toBeTruthy();
    expect(screen.getByTestId("workflow-start-template")).toBeTruthy();
    expect(screen.getByTestId("workflow-template-picker-open")).toBeTruthy();
    expect(screen.getByTestId("workflow-step-inputs").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("workflow-step-resources").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("workflow-step-review").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("common.next")).toBeNull();
    expect(screen.queryByText("workflows.parsedSteps")).toBeNull();
  });

  test("starting from scratch hides the decision overlay", () => {
    renderPage();
    startFromScratch();
    expect(screen.queryByTestId("workflow-start-overlay")).toBeNull();
    expect(
      screen
        .getByTestId("workflow-title-actions")
        .contains(screen.getByTestId("workflow-title-next")),
    ).toBe(true);
    expect((screen.getByTestId("yaml-input") as HTMLTextAreaElement).value).toContain(
      `name: 工作流${String(new Date().getFullYear()).slice(-2)}`,
    );
    expect(screen.getByTestId("workflow-title-next").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("workflow-readiness").textContent).toContain(
      "workflows.creation.readiness.addNode",
    );
  });

  test("renames the workflow from the title and writes the name back to YAML", () => {
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: WORKFLOW_DOC } });

    const name = screen.getByTestId("workflow-name-input") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "renamed-workflow" } });
    fireEvent.blur(name);

    expect((screen.getByTestId("yaml-input") as HTMLTextAreaElement).value).toContain(
      "name: renamed-workflow",
    );
  });

  test("keeps step navigation in the title card and templates in the editor menu", () => {
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: WORKFLOW_DOC } });

    expect(
      screen
        .getByTestId("workflow-title-actions")
        .contains(screen.getByTestId("workflow-template-picker-open")),
    ).toBe(false);
    fireEvent.click(screen.getByTestId("workflow-title-next"));
    expect(screen.getByTestId("workflow-inputs-step")).toBeTruthy();
    expect(
      screen
        .getByTestId("workflow-title-actions")
        .contains(screen.getByTestId("workflow-title-previous")),
    ).toBe(true);
    expect(
      screen
        .getByTestId("workflow-title-actions")
        .contains(screen.getByTestId("workflow-title-next")),
    ).toBe(true);
    fireEvent.click(screen.getByTestId("workflow-title-next"));
    expect(screen.getByTestId("workflow-resources-step")).toBeTruthy();
    fireEvent.click(screen.getByTestId("workflow-title-next"));
    expect(screen.getByTestId("workflow-review-step")).toBeTruthy();
    expect(
      screen
        .getByTestId("workflow-title-actions")
        .contains(screen.getByTestId("workflow-title-previous")),
    ).toBe(true);
  });

  test("picking a Registry template replaces the editor YAML", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("workflow-start-template"));
    const option = await screen.findByTestId("workflow-template-option-template-two-node");
    fireEvent.click(option);
    fireEvent.click(screen.getByTestId("workflow-template-apply"));
    const editor = screen.getByTestId("yaml-input") as HTMLTextAreaElement;
    expect(editor.value).toContain("repository-template");
    expect(screen.queryByTestId("workflow-start-overlay")).toBeNull();
    expect(listWorkflowTemplatePage).toHaveBeenCalled();
  });

  test("filters Registry templates in the picker", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("workflow-template-picker-open"));
    await screen.findByTestId("workflow-template-option-template-two-node");
    fireEvent.change(screen.getByTestId("workflow-template-search"), {
      target: { value: "not-found" },
    });
    expect(screen.queryByTestId("workflow-template-option-template-two-node")).toBeNull();
  });

  test("resets template filters when the picker is reopened", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("workflow-template-picker-open"));
    await screen.findByTestId("workflow-template-option-template-two-node");
    fireEvent.change(screen.getByTestId("workflow-template-search"), {
      target: { value: "not-found" },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("workflow-template-option-template-two-node")).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    fireEvent.click(screen.getByTestId("workflow-template-picker-open"));

    expect((screen.getByTestId("workflow-template-search") as HTMLInputElement).value).toBe("");
    expect(await screen.findByTestId("workflow-template-option-template-two-node")).toBeTruthy();
    expect(listWorkflowTemplatePage).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, q: "", tag: undefined }),
    );
  });

  test("loads templates from the next server page", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("workflow-template-picker-open"));
    await screen.findByTestId("workflow-template-option-template-two-node");
    fireEvent.click(screen.getByTestId("workflow-template-next-page"));
    expect(await screen.findByTestId("workflow-template-option-template-page-two")).toBeTruthy();
    expect(listWorkflowTemplatePage).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2, pageSize: 24 }),
    );
  });

  test("does not offer templates with static validation bypassed", async () => {
    listWorkflowTemplatePage.mockResolvedValue({
      templates: [
        {
          id: "template-invalid-bypass",
          name: "Invalid bypass",
          version: "1.0.0",
          description: null,
          yamlContent: `${WORKFLOW_DOC.replace("      id: a", "      id: duplicate")}\nadvanced:\n  skipStaticValidation: true\n`,
          tags: [],
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
      tags: [],
      total: 1,
      page: 1,
      pageSize: 24,
      totalPages: 1,
      hasNext: false,
    });
    renderPage();
    fireEvent.click(screen.getByTestId("workflow-template-picker-open"));

    await waitFor(() => expect(listWorkflowTemplatePage).toHaveBeenCalled());
    const option = await screen.findByTestId("workflow-template-option-template-invalid-bypass");
    expect((option as HTMLButtonElement).disabled).toBe(true);
    expect(option.getAttribute("title")).toBe("software.card.invalidUseUnavailable");
    expect(screen.getByTestId("workflow-template-apply").hasAttribute("disabled")).toBe(true);
  });

  test("does not render the parsed-node developer summary", () => {
    renderPage();
    startFromScratch();
    expect(screen.queryByText("workflows.parsedSteps")).toBeNull();
  });

  test("invalid YAML blocks navigation to review and never posts", () => {
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: "name: [" } });
    openReview();
    expect(screen.queryByTestId("submit-workflow")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  test("an empty scratch workflow cannot advance or submit", () => {
    renderPage();
    startFromScratch();
    expect(screen.getByTestId("workflow-title-next").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("workflow-step-review"));
    expect(screen.getByTestId("submit-workflow").hasAttribute("disabled")).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  test("saves a dated workflow draft through the Server", async () => {
    post.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      name: "工作流260716-1",
      placementConfig: {},
      yaml: WORKFLOW_DOC,
    });
    renderPage();
    fireEvent.click(screen.getByTestId("workflow-save-draft"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/workflows/drafts", expect.any(Object)));
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      name: expect.stringMatching(/^工作流\d{6}-1$/),
      placementConfig: { plannerMode: "Global", budgetCap: null, nodeConstraints: {} },
    });
  });

  test("an edited workflow submits to /workflows and navigates to its run", async () => {
    post.mockResolvedValueOnce({ runId: "workflow-run-1", status: "submitted" });
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: WORKFLOW_DOC } });
    openReview();
    confirmSubmit();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[0]).toBe("/workflows");
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/$runId",
        params: { runId: "workflow-run-1" },
      }),
    );
  });

  test("submits compute planning choices from the resource step", async () => {
    get.mockResolvedValue({
      queues: [
        {
          queueId: QUEUE_ID,
          name: "Scheduler Smoke Slurm",
          agentId: "scheduler-slurm",
          schedulerType: "slurm",
          queueName: "debug",
          qos: null,
        },
      ],
    });
    post.mockResolvedValueOnce({ runId: "workflow-run-placement", status: "submitted" });
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: QUEUED_WORKFLOW_DOC } });
    fireEvent.click(screen.getByTestId("workflow-step-resources"));
    await screen.findByTestId("workflow-resource-target-queue");

    fireEvent.change(screen.getByTestId("workflow-resource-planner-mode"), {
      target: { value: "Lookahead" },
    });
    fireEvent.change(screen.getByTestId("workflow-resource-budget-cap"), {
      target: { value: "25.5" },
    });
    fireEvent.change(screen.getByTestId("workflow-resource-data-movement"), {
      target: { value: "Forbid" },
    });
    fireEvent.click(screen.getByTestId("workflow-step-review"));
    confirmSubmit();

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      plannerMode: "Lookahead",
      budgetCap: 25.5,
      nodePlacementConstraints: {
        run: {
          mode: "Require",
          clusterIds: [],
          dataMovement: "Forbid",
        },
      },
    });
  });

  test("review renders the final workflow, I/O configuration, and YAML copy action", () => {
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: WORKFLOW_DOC } });
    openReview();

    expect(screen.getByTestId("workflow-review-graph")).toBeTruthy();
    expect(screen.getByTestId("workflow-review-node-a")).toBeTruthy();
    expect(screen.getByTestId("workflow-review-io")).toBeTruthy();
    expect(screen.getByTestId("workflow-review-copy-yaml")).toBeTruthy();
  });

  test("binds Dataset inputs independently per node and blocks submission after refresh invalidates one", async () => {
    let datasetOptionsAvailable = true;
    get.mockImplementation((path: string) => {
      if (path.includes("/dataset-options")) {
        const preprocessUnavailable =
          !datasetOptionsAvailable && path.includes("11111111-1111-4111-8111-111111111101");
        return Promise.resolve({
          options: preprocessUnavailable ? [] : [DATASET_OPTION],
          total: preprocessUnavailable ? 0 : 1,
          limit: 25,
          offset: 0,
        });
      }
      return Promise.resolve({ queues: [] });
    });
    post.mockImplementation((path: string) => {
      if (path.includes("/dataset-options/validate")) {
        const preprocessUnavailable =
          !datasetOptionsAvailable && path.includes("11111111-1111-4111-8111-111111111101");
        return preprocessUnavailable
          ? Promise.reject(new Error("Dataset access was revoked"))
          : Promise.resolve({ valid: true });
      }
      return Promise.resolve({ runId: "unused", status: "submitted" });
    });
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: DATASET_INPUT_DOC } });
    fireEvent.click(screen.getByTestId("workflow-step-inputs"));

    const preprocess = await screen.findByTestId(
      "workflow-dataset-select-dataset:preprocess:trajectory",
    );
    const analyze = await screen.findByTestId("workflow-dataset-select-dataset:analyze:trajectory");
    await screen.findAllByRole("option", { name: "Trajectory corpus / release-b" });
    fireEvent.change(preprocess, { target: { value: DATASET_OPTION.versionId } });
    fireEvent.change(analyze, { target: { value: DATASET_OPTION.versionId } });
    await waitFor(() =>
      expect(screen.getByTestId("workflow-readiness").textContent).toContain(
        "workflows.creation.readyToSubmit",
      ),
    );
    fireEvent.click(screen.getByTestId("workflow-step-review"));

    expect(screen.getByTestId("submit-workflow").hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("workflow-review-io").textContent).toContain("Dataset");

    datasetOptionsAvailable = false;
    fireEvent.click(screen.getByTestId("workflow-title-previous"));
    fireEvent.click(screen.getByTestId("workflow-title-previous"));
    fireEvent.click(screen.getByTestId("workflow-dataset-refresh-dataset:preprocess:trajectory"));
    await waitFor(() =>
      expect(screen.getByTestId("workflow-readiness").textContent).toContain(
        "workflows.creation.readiness.chooseDatasets:1",
      ),
    );
    fireEvent.click(screen.getByTestId("workflow-step-review"));
    expect(screen.getByTestId("submit-workflow").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByTestId("workflow-title-previous"));
    fireEvent.click(screen.getByTestId("workflow-title-previous"));
    expect(
      (
        screen.getByTestId(
          "workflow-dataset-select-dataset:preprocess:trajectory",
        ) as HTMLSelectElement
      ).value,
    ).toBe(DATASET_OPTION.versionId);
  });

  test("saves Dataset bindings to YAML and restores them from a draft", async () => {
    get.mockImplementation((path: string) => {
      if (path.includes("/dataset-options")) {
        return Promise.resolve({ options: [DATASET_OPTION], total: 1, limit: 25, offset: 0 });
      }
      return Promise.resolve({ queues: [] });
    });
    post.mockImplementation((path: string, payload: { yaml?: string }) => {
      if (path.includes("/dataset-options/validate")) return Promise.resolve({ valid: true });
      return Promise.resolve({
        id: "55555555-5555-4555-8555-555555555505",
        name: "dataset-input",
        placementConfig: {},
        yaml: payload.yaml,
      });
    });
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: DATASET_INPUT_DOC } });
    fireEvent.click(screen.getByTestId("workflow-step-inputs"));
    const picker = await screen.findByTestId(
      "workflow-dataset-select-dataset:preprocess:trajectory",
    );
    await screen.findAllByRole("option", { name: "Trajectory corpus / release-b" });
    fireEvent.change(picker, { target: { value: DATASET_OPTION.versionId } });
    await waitFor(() =>
      expect(screen.getByTestId("workflow-readiness").textContent).toContain(
        "workflows.creation.readiness.chooseDatasets:1",
      ),
    );
    fireEvent.click(screen.getByTestId("workflow-save-draft"));

    await waitFor(() => expect(post).toHaveBeenCalledWith("/workflows/drafts", expect.any(Object)));
    const saved = post.mock.calls.find(([path]) => path === "/workflows/drafts")?.[1] as {
      yaml: string;
    };
    expect(saved.yaml).toContain(`versionId: ${DATASET_OPTION.versionId}`);
    expect(saved.yaml).toContain("contents:");

    cleanup();
    window.history.replaceState(
      {},
      "",
      "/workflows/new?draftId=55555555-5555-4555-8555-555555555505",
    );
    get.mockImplementation((path: string) => {
      if (path === "/workflows/drafts/55555555-5555-4555-8555-555555555505") {
        return Promise.resolve({
          id: "55555555-5555-4555-8555-555555555505",
          name: "dataset-input",
          placementConfig: {},
          yaml: saved.yaml,
        });
      }
      if (path.includes("/dataset-options")) {
        return Promise.resolve({ options: [DATASET_OPTION], total: 1, limit: 25, offset: 0 });
      }
      return Promise.resolve({ queues: [] });
    });
    renderPage();
    await screen.findByDisplayValue("dataset-input");
    fireEvent.click(screen.getByTestId("workflow-step-inputs"));
    expect(
      (
        (await screen.findByTestId(
          "workflow-dataset-select-dataset:preprocess:trajectory",
        )) as HTMLSelectElement
      ).value,
    ).toBe(DATASET_OPTION.versionId);
  });

  test("verifies a frozen Dataset binding with selected entries through the complete binding endpoint", async () => {
    const frozen = {
      ...DATASET_OPTION.input,
      selectedEntries: ["trajectory/frame-001.xtc"],
      targetPath: "inputs/trajectory",
    };
    get.mockImplementation((path: string) => {
      if (path.includes("/dataset-options")) {
        return Promise.resolve({ options: [DATASET_OPTION], total: 1, limit: 25, offset: 0 });
      }
      return Promise.resolve({ queues: [] });
    });
    post.mockImplementation((path: string, body: unknown) => {
      if (path.includes("/dataset-options/validate")) {
        expect(body).toEqual({ descriptor: "trajectory", input: frozen });
        return Promise.resolve({ valid: true });
      }
      return Promise.resolve({ runId: "unused", status: "submitted" });
    });
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), {
      target: {
        value: DATASET_INPUT_DOC.replaceAll(
          "contents: null",
          `contents:\n            source: data-market\n            assetId: ${frozen.assetId}\n            versionId: ${frozen.versionId}\n            manifestDigest: ${frozen.manifestDigest}\n            selectedEntries:\n              - trajectory/frame-001.xtc\n            targetPath: inputs/trajectory`,
        ),
      },
    });
    fireEvent.click(screen.getByTestId("workflow-step-inputs"));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/jobs/usecase/11111111-1111-4111-8111-111111111101/dataset-options/validate",
        { descriptor: "trajectory", input: frozen },
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workflow-readiness").textContent).toContain(
        "workflows.creation.readyToSubmit",
      ),
    );
  });

  test("allows a ByVersion subworkflow whose Dataset is already frozen", async () => {
    getWorkflowTemplate.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      yamlContent: DATASET_INPUT_DOC.replaceAll(
        "contents: null",
        `contents:
            source: data-market
            assetId: ${DATASET_OPTION.input.assetId}
            versionId: ${DATASET_OPTION.input.versionId}
            manifestDigest: ${DATASET_OPTION.input.manifestDigest}
            selectedEntries: []`,
      ),
    });
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), {
      target: { value: BY_VERSION_SUBWORKFLOW_DOC },
    });
    openReview();

    await waitFor(() => expect(getWorkflowTemplate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("submit-workflow").hasAttribute("disabled")).toBe(false),
    );
  });

  test("blocks submission while a ByVersion subworkflow cannot expose its Dataset requirements", async () => {
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), {
      target: { value: BY_VERSION_SUBWORKFLOW_DOC },
    });
    openReview();

    await waitFor(() =>
      expect(screen.getByTestId("workflow-readiness").textContent).toContain(
        "workflows.creation.readiness.resolveSubworkflows:1",
      ),
    );
    expect(screen.getByTestId("workflow-readiness").textContent).not.toContain(
      "Referenced workflow unavailable",
    );
    expect(screen.getByTestId("submit-workflow").hasAttribute("disabled")).toBe(true);
  });

  test("stages local files and uploads only after associations are confirmed", async () => {
    let resolveUpload: ((value: unknown) => void) | undefined;
    uploadFileToNetDrive.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: FILE_INPUT_DOC } });
    fireEvent.click(screen.getByTestId("workflow-step-inputs"));

    const localFile = new File(["gro"], "input.gro", { type: "text/plain" });
    Object.defineProperty(localFile, "webkitRelativePath", {
      value: "consume/input.gro",
    });
    const chooser = screen.getByTestId("workflow-choose-local-file-slot:consume:structure");
    expect(chooser).toBeTruthy();
    expect(screen.getByText("workflows.creation.inputs.dropHere")).toBeTruthy();
    expect(screen.getByText("workflows.creation.inputs.chooseFromCloud")).toBeTruthy();
    fireEvent.change(chooser as HTMLInputElement, { target: { files: [localFile] } });

    expect(screen.getAllByText("input.gro").length).toBeGreaterThan(0);
    expect(uploadFileToNetDrive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("workflow-confirm-file-bindings"));

    await waitFor(() => expect(uploadFileToNetDrive).toHaveBeenCalled());
    expect(screen.getByTestId("workflow-upload-overlay")).toBeTruthy();
    resolveUpload?.({
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3399",
      path: "workflows/drafts/test/consume/input.gro",
      size: 3,
      sha256: "a".repeat(64),
    });
    await waitFor(() => expect(screen.queryByTestId("workflow-upload-overlay")).toBeNull());
    openReview();
    expect(screen.getByTestId("workflow-review-io").textContent).toContain(
      "workflows.creation.review.localFile",
    );
    expect(screen.getByTestId("workflow-review-io").textContent).toContain("3 B");
  });

  test("offers independent local file and folder selectors that bind staged files", async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: FILE_INPUT_DOC } });
    fireEvent.click(screen.getByTestId("workflow-step-inputs"));

    const fileChooser = screen.getByTestId("workflow-choose-local-file-slot:consume:structure");
    const folderChooser = screen.getByTestId("workflow-choose-local-folder-slot:consume:structure");
    expect(fileChooser.getAttribute("webkitdirectory")).toBeNull();
    expect(folderChooser.getAttribute("webkitdirectory")).toBe("");

    const selectedFile = new File(["gro"], "input.gro", { type: "text/plain" });
    fireEvent.change(fileChooser, { target: { files: [selectedFile] } });
    expect(screen.getAllByText("input.gro").length).toBeGreaterThan(0);
    const requirement = screen.getByTestId("workflow-file-requirement-slot:consume:structure");
    const bindingName = requirement.querySelector<HTMLElement>(
      '[data-testid^="workflow-file-binding-name-"]',
    );
    expect(bindingName?.textContent).toBe("input.gro");
    expect(bindingName?.className).toContain("min-w-0");
    expect(bindingName?.className).toContain("flex-1");
    expect(bindingName?.parentElement?.className).toContain("w-full");

    const folderFile = new File(["xtc"], "trajectory.xtc", { type: "application/octet-stream" });
    Object.defineProperty(folderFile, "webkitRelativePath", { value: "sample/trajectory.xtc" });
    fireEvent.change(folderChooser, { target: { files: [folderFile] } });
    expect(screen.getAllByText("trajectory.xtc").length).toBeGreaterThan(0);
    const remove = requirement.querySelector('button[aria-label="common.remove"]');
    expect(remove).toBeTruthy();
    fireEvent.click(remove as HTMLButtonElement);
    expect(requirement.textContent).not.toContain("input.gro");

    const replacement = new File(["gro"], "replacement.gro", { type: "text/plain" });
    fireEvent.change(fileChooser, { target: { files: [replacement] } });
    expect(requirement.textContent).toContain("replacement.gro");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
  });

  test("confirms file associations before leaving and preserves the confirmed state", async () => {
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: FILE_INPUT_DOC } });
    fireEvent.click(screen.getByTestId("workflow-step-inputs"));

    const localFile = new File(["gro"], "input.gro", { type: "text/plain" });
    const chooser = screen.getByTestId("workflow-choose-local-file-slot:consume:structure");
    fireEvent.change(chooser as HTMLInputElement, { target: { files: [localFile] } });
    fireEvent.click(screen.getByTestId("workflow-title-next"));

    expect(screen.getByTestId("workflow-association-confirm-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("workflow-association-confirm-continue"));
    await screen.findByTestId("workflow-resources-step");

    fireEvent.click(screen.getByTestId("workflow-title-previous"));
    expect(screen.getByTestId("workflow-inputs-step")).toBeTruthy();
    fireEvent.click(screen.getByTestId("workflow-title-next"));
    expect(screen.getByTestId("workflow-resources-step")).toBeTruthy();
    expect(screen.queryByTestId("workflow-association-confirm-dialog")).toBeNull();
  });

  test("marks workflow queue references as visible when /queues/visible contains them", async () => {
    get.mockResolvedValueOnce({
      queues: [
        {
          queueId: QUEUE_ID,
          name: "Scheduler Smoke Slurm",
          agentId: "scheduler-slurm",
          schedulerType: "slurm",
          queueName: "debug",
          qos: null,
        },
      ],
    });
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: QUEUED_WORKFLOW_DOC } });

    const status = await screen.findByTestId("workflow-readiness");
    expect(status.textContent).toContain("workflows.creation.readyToSubmit");
    expect(get).toHaveBeenCalledWith("/queues/visible");
  });

  test("warns when workflow YAML references queues hidden from /queues/visible", async () => {
    get.mockResolvedValueOnce({ queues: [] });
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: QUEUED_WORKFLOW_DOC } });

    const status = await screen.findByTestId("workflow-readiness");
    expect(status.textContent).toContain("workflows.creation.readiness.chooseQueue:1");
  });

  test("surfaces queue loading errors without treating references as hidden or visible", async () => {
    get.mockRejectedValueOnce(new Error("Queue registry unavailable"));
    renderPage();
    startFromScratch();
    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: QUEUED_WORKFLOW_DOC } });

    const status = await screen.findByTestId("workflow-readiness");
    expect(status.textContent).toContain("workflows.creation.readiness.loadQueues");
  });
});
