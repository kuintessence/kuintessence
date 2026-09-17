import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jobSubmitDraftStorageKey } from "../../lib/job-submit-draft";
import type { UsecasePackage } from "../../lib/software-client";
import { SubmitJobDialog } from "./SubmitJobDialog";

const softwareClient = vi.hoisted(() => ({
  listUsecasePackages: vi.fn(),
}));

vi.mock("../../lib/software-client", () => softwareClient);

const apiClient = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ApiError";
    }
  },
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
  uploadFileToNetDrive: vi.fn(),
}));

vi.mock("../../lib/api-client", () => apiClient);

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (typeof opts?.defaultValue === "string") return opts.defaultValue;
      if (typeof opts?.count === "number") return `${opts.count}`;
      return key;
    },
  }),
}));

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function gromacsUsecase(): UsecasePackage {
  return {
    id: "uc-gromacs",
    name: "GROMACS MD smoke",
    version: "2024.1",
    description: "Small MD validation run",
    createdAt: "2026-07-03T00:00:00.000Z",
    spec: {
      usecase: {
        commandFile: "gmx",
        inputSlots: [
          {
            kind: "Text",
            descriptor: "steps",
            refMaterials: [{ kind: "ArgRef", descriptor: "steps", sort: 0 }],
          },
          {
            kind: "File",
            descriptor: "structure",
            refMaterials: [{ kind: "FileInputRef", descriptor: "structure" }],
          },
        ],
      },
      software: {
        kind: "Spack",
        name: "gromacs",
        version: "2024.1",
        argumentList: [],
      },
      arguments: [{ descriptor: "steps", valueFormat: "{steps}" }],
      environments: [],
      filesomeInputs: [
        {
          descriptor: "structure",
          fileKind: { kind: "Normal", name: "input.gro" },
        },
      ],
      filesomeOutputs: [
        {
          descriptor: "trajectory",
          fileKind: { kind: "Normal", name: "traj.xtc" },
        },
      ],
    },
  };
}

function bareUsecase(): UsecasePackage {
  return {
    id: "uc-bare",
    name: "Bare checksum",
    version: "1",
    description: "Checksum a single input",
    createdAt: "2026-07-03T00:00:00.000Z",
    spec: {
      usecase: {
        commandFile: "checksum.sh",
        inputSlots: [
          {
            kind: "Text",
            descriptor: "filename",
            refMaterials: [{ kind: "ArgRef", descriptor: "filename", sort: 0 }],
          },
        ],
      },
      software: { kind: "Bare" },
      arguments: [{ descriptor: "filename", valueFormat: "{filename}" }],
      environments: [],
      filesomeInputs: [],
      filesomeOutputs: [],
    },
  };
}

function legacyScriptUsecase(): UsecasePackage {
  return {
    id: "uc-script",
    name: "Legacy script runner",
    version: "1",
    description: "Programmable shell escape hatch",
    createdAt: "2026-07-03T00:00:00.000Z",
    spec: {
      usecase: {
        commandFile: "bash",
        inputSlots: [
          {
            kind: "Text",
            descriptor: "script",
            refMaterials: [{ kind: "ArgRef", descriptor: "script", sort: 0 }],
          },
        ],
      },
      software: { kind: "Bare" },
      arguments: [{ descriptor: "script", valueFormat: "{script}" }],
      environments: [],
      filesomeInputs: [],
      filesomeOutputs: [],
    },
  };
}

function datasetUsecase(required = true): UsecasePackage {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    name: "Trajectory analysis",
    version: "2",
    description: "Analyze an immutable trajectory dataset",
    createdAt: "2026-08-13T00:00:00.000Z",
    spec: {
      softwareRef: {
        source: "official-upstream",
        name: "trajectory-analyzer",
        version: "1.0.0",
      },
      inputs: [
        {
          descriptor: "trajectoryDataset",
          type: "Dataset",
          required,
        },
      ],
      usecase: {
        commandFile: "analyze",
        inputSlots: [],
      },
      software: { kind: "Bare" },
      arguments: [],
      environments: [],
      filesomeInputs: [],
      filesomeOutputs: [],
    },
  };
}

const datasetOption = {
  assetId: "00000000-0000-4000-8000-000000000201",
  assetName: "MD trajectory",
  assetKind: "scientific-dataset",
  tags: ["molecular-dynamics"],
  versionId: "00000000-0000-4000-8000-000000000202",
  version: "2026.08",
  manifestDigest: "sha256:immutable",
  format: "xtc",
  schemaUri: null,
  sizeBytes: 2048,
  input: {
    source: "data-market" as const,
    assetId: "00000000-0000-4000-8000-000000000201",
    versionId: "00000000-0000-4000-8000-000000000202",
    manifestDigest: "sha256:immutable",
    selectedEntries: [],
  },
};

function visibleQueue(input: {
  queueId: string;
  targetMode: "default" | "named";
  eligibility?: "ready" | "warning" | "blocked";
}) {
  const eligibility = input.eligibility ?? "ready";
  return {
    queueId: input.queueId,
    name: `${input.targetMode}-${input.queueId}`,
    providerOrgId: "11111111-1111-4111-8111-111111111111",
    visibleOrgIds: [],
    agentId: "agent-slurm",
    schedulerType: "slurm",
    queueName: input.targetMode === "named" ? "compute" : null,
    target: { mode: input.targetMode },
    qos: null,
    resolvedQueueName: input.targetMode === "default" ? "batch" : "compute",
    enabled: true,
    policyTags: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    submitEligibility:
      eligibility === "ready"
        ? { state: "ready", reason: null, retryable: false }
        : {
            state: eligibility,
            reason: "stale",
            retryable: true,
          },
  };
}

async function prepareCommandJob(name = "queue-placement") {
  const commandTab = await screen.findByTestId("submit-mode-command");
  fireEvent.pointerDown(commandTab, { button: 0, ctrlKey: false });
  fireEvent.click(commandTab);
  fireEvent.change(await screen.findByTestId("submit-job-name"), { target: { value: name } });
  fireEvent.change(screen.getByTestId("submit-job-command"), {
    target: { value: "python queue-placement.py" },
  });
}

beforeEach(() => {
  softwareClient.listUsecasePackages.mockResolvedValue([
    legacyScriptUsecase(),
    gromacsUsecase(),
    bareUsecase(),
  ]);
  apiClient.api.get.mockImplementation(async (path: string) => {
    if (path === "/queues/visible") return { queues: [] };
    if (path === "/netdrive/files") {
      return {
        success: true,
        data: {
          files: [
            {
              id: "cloud-a",
              path: "datasets/input/a.txt",
              size: 5,
              mtime: "2026-07-03T00:00:00.000Z",
            },
          ],
          total: 1,
        },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  apiClient.api.post.mockResolvedValue({
    id: "job-1",
    name: "command-with-inputs",
    status: "pending",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("SubmitJobDialog command workdir", () => {
  test("restores an in-progress command job after refresh and discards it on request", async () => {
    localStorage.setItem("kq_email", "scientist@example.test");
    sessionStorage.clear();
    const first = render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, {
      wrapper: wrapper(),
    });

    const commandTab = await screen.findByTestId("submit-mode-command");
    fireEvent.pointerDown(commandTab, { button: 0, ctrlKey: false });
    fireEvent.click(commandTab);
    fireEvent.change(await screen.findByTestId("submit-job-name"), {
      target: { value: "resume-after-refresh" },
    });
    fireEvent.change(screen.getByTestId("submit-job-command"), {
      target: { value: "python analyze.py" },
    });
    fireEvent.change(screen.getByTestId("submit-job-cpus"), { target: { value: "4" } });
    fireEvent.change(screen.getByTestId("submit-job-memory"), { target: { value: "8192" } });

    await waitFor(() => expect(sessionStorage.length).toBe(1));
    first.unmount();

    let closed = false;
    render(<SubmitJobDialog open={true} onOpenChange={(open) => (closed = !open)} />, {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("submit-mode-command").getAttribute("data-state")).toBe("active");
      expect((screen.getByTestId("submit-job-name") as HTMLInputElement).value).toBe(
        "resume-after-refresh",
      );
      expect((screen.getByTestId("submit-job-command") as HTMLTextAreaElement).value).toBe(
        "python analyze.py",
      );
    });
    expect((screen.getByTestId("submit-job-cpus") as HTMLInputElement).value).toBe("4");
    expect((screen.getByTestId("submit-job-memory") as HTMLInputElement).value).toBe("8192");
    expect(screen.getByTestId("submit-job-draft-restored").textContent).toContain(
      "Your unsent job draft has been restored",
    );

    const discardButtons = screen.getAllByRole("button", { name: "Discard draft" });
    const footerDiscard = discardButtons[1];
    expect(footerDiscard).toBeDefined();
    if (footerDiscard) fireEvent.click(footerDiscard);
    expect(closed).toBe(true);
    expect(sessionStorage.length).toBe(0);
    localStorage.removeItem("kq_email");
  });

  test("does not copy an open form into a newly selected organization draft", async () => {
    localStorage.setItem("kq_email", "scientist@example.test");
    localStorage.setItem("kq_active_organization_id", "org-a");
    const scopeBKey = jobSubmitDraftStorageKey({
      email: "scientist@example.test",
      organizationId: "org-b",
    });
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const commandTab = await screen.findByTestId("submit-mode-command");
    fireEvent.pointerDown(commandTab, { button: 0, ctrlKey: false });
    fireEvent.click(commandTab);
    fireEvent.change(await screen.findByTestId("submit-job-name"), {
      target: { value: "organization-a-only" },
    });
    fireEvent.change(screen.getByTestId("submit-job-command"), {
      target: { value: "python private-a.py" },
    });
    await waitFor(() => expect(sessionStorage.length).toBe(1));

    act(() => {
      localStorage.setItem("kq_active_organization_id", "org-b");
      window.dispatchEvent(new Event("kq:active-organization-change"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("submit-mode-usecase").getAttribute("data-state")).toBe("active");
      expect((screen.getByTestId("submit-job-name") as HTMLInputElement).value).not.toBe(
        "organization-a-only",
      );
    });
    await waitFor(() => {
      const stored = scopeBKey ? sessionStorage.getItem(scopeBKey) : null;
      expect(stored).not.toContain("organization-a-only");
      expect(stored).not.toContain("python private-a.py");
    });
  });

  test("explains when no enabled visible queues are available", async () => {
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    expect(await screen.findByTestId("submit-job-queue-empty")).toBeTruthy();
    expect(screen.getByTestId("submit-job-queue-empty").textContent).toContain(
      "No enabled and visible queues are available",
    );
  });

  test("shows a safe queue loading message without backend details", async () => {
    apiClient.api.get.mockImplementation(async (path: string) => {
      if (path === "/queues/visible") throw new Error("Queue submit permission denied");
      if (path === "/netdrive/files") return { success: true, data: { files: [], total: 0 } };
      throw new Error(`unexpected GET ${path}`);
    });

    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    expect(await screen.findByTestId("submit-job-queue-error")).toBeTruthy();
    expect(screen.getByTestId("submit-job-queue-error").textContent).toContain(
      "Queue list unavailable",
    );
    expect(screen.getByTestId("submit-job-queue-error").textContent).not.toContain(
      "Queue submit permission denied",
    );
    expect(screen.queryByTestId("submit-job-queue-empty")).toBeNull();
    expect(screen.getByTestId("submit-job-queue-help").textContent).toContain(
      "The Server selects a suitable Agent",
    );
  });

  test("keeps empty workdir folders in the preview without submitting fake staged files", async () => {
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const commandTab = screen.getByTestId("submit-mode-command");
    fireEvent.pointerDown(commandTab, { button: 0, ctrlKey: false });
    fireEvent.click(commandTab);
    await screen.findByTestId("submit-job-command");
    fireEvent.change(screen.getByTestId("submit-job-name"), {
      target: { value: "command-empty-folder" },
    });

    fireEvent.click(await screen.findByTestId("submit-command-workdir-open"));
    fireEvent.change(screen.getByTestId("command-workdir-new-folder-name"), {
      target: { value: "inputs/nested" },
    });
    fireEvent.click(screen.getByTestId("command-workdir-create-folder"));
    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    const preview = await screen.findByTestId("submit-command-workdir-preview");
    expect(within(preview).getByTestId("submit-command-workdir-tree-dir-inputs")).toBeTruthy();
    expect(
      within(preview).getByTestId("submit-command-workdir-tree-dir-inputs-nested"),
    ).toBeTruthy();
    expect(within(preview).getAllByText("Empty folder").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("submit-command-workdir-open"));
    expect(await screen.findByTestId("command-workdir-open-dir-inputs")).toBeTruthy();
    fireEvent.click(screen.getByTestId("command-workdir-open-dir-inputs"));
    expect(await screen.findByTestId("command-workdir-open-dir-inputs-nested")).toBeTruthy();
    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    fireEvent.click(screen.getByTestId("submit-job-confirm"));

    await waitFor(() =>
      expect(apiClient.api.post).toHaveBeenCalledWith("/jobs", expect.anything()),
    );
    expect(apiClient.api.post).toHaveBeenCalledWith("/jobs", {
      name: "command-empty-folder",
      command: 'echo "hello from kq"',
      resources: { cpus: 1, memoryMb: 1024 },
    });
  });

  test("submits command jobs with staged NetDrive files", async () => {
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const commandTab = screen.getByTestId("submit-mode-command");
    fireEvent.pointerDown(commandTab, { button: 0, ctrlKey: false });
    fireEvent.click(commandTab);
    await screen.findByTestId("submit-job-command");
    fireEvent.change(screen.getByTestId("submit-job-name"), {
      target: { value: "command-with-inputs" },
    });
    fireEvent.change(screen.getByTestId("submit-job-command"), {
      target: { value: "cat inputs/a.txt" },
    });

    fireEvent.click(await screen.findByTestId("submit-command-workdir-open"));
    fireEvent.click(await screen.findByTestId("command-workdir-cloud-dir-datasets"));
    fireEvent.click(await screen.findByTestId("command-workdir-cloud-dir-datasets-input"));
    fireEvent.click(await screen.findByTestId("command-workdir-add-cloud-a"));
    fireEvent.change(screen.getByTestId("command-workdir-stage-cloud-a"), {
      target: { value: "inputs/a.txt" },
    });
    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    const preview = await screen.findByTestId("submit-command-workdir-preview");
    expect(within(preview).getByTestId("submit-command-workdir-tree-dir-inputs")).toBeTruthy();
    expect(
      within(preview).getByTestId("submit-command-workdir-tree-file-inputs-a-txt"),
    ).toBeTruthy();
    expect(within(preview).queryByText("inputs/a.txt")).toBeNull();
    fireEvent.click(screen.getByTestId("submit-job-confirm"));

    await waitFor(() =>
      expect(apiClient.api.post).toHaveBeenCalledWith("/jobs", expect.anything()),
    );
    expect(apiClient.api.post).toHaveBeenCalledWith("/jobs", {
      name: "command-with-inputs",
      command: "cat inputs/a.txt",
      resources: { cpus: 1, memoryMb: 1024 },
      inputStaging: [{ fileMetadataId: "cloud-a", stagePath: "inputs/a.txt" }],
    });
  });
});

describe("SubmitJobDialog queue placement", () => {
  test("omits schedulingStrategy for Auto placement", async () => {
    apiClient.api.get.mockResolvedValue({
      queues: [visibleQueue({ queueId: "queue-default", targetMode: "default" })],
    });
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    await prepareCommandJob("auto-placement");
    fireEvent.click(screen.getByTestId("submit-job-confirm"));

    await waitFor(() =>
      expect(apiClient.api.post).toHaveBeenCalledWith("/jobs", {
        name: "auto-placement",
        command: "python queue-placement.py",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    );
  });

  test("uses the same Named queue payload for preview and submit", async () => {
    const previewPayloads: Array<Record<string, unknown>> = [];
    const submittedPayloads: Array<Record<string, unknown>> = [];
    apiClient.api.get.mockResolvedValue({
      queues: [
        visibleQueue({ queueId: "queue-default", targetMode: "default" }),
        visibleQueue({ queueId: "queue-named", targetMode: "named" }),
      ],
    });
    apiClient.api.post.mockImplementation(
      async (path: string, payload: Record<string, unknown>) => {
        if (path === "/scheduler/preview-placement") {
          previewPayloads.push(payload);
          return { candidates: [], stages: [], finalDecision: null };
        }
        if (path === "/jobs") {
          submittedPayloads.push(payload);
          return { id: "job-queue-named", name: String(payload.name), status: "pending" };
        }
        throw new Error(`unexpected POST ${path}`);
      },
    );
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    await prepareCommandJob("named-placement");
    fireEvent.click(screen.getByTestId("submit-job-placement-named"));
    const queueSelect = await screen.findByTestId("submit-job-queue-select");
    fireEvent.change(queueSelect, { target: { value: "queue-named" } });

    fireEvent.click(screen.getByTestId("placement-preview-toggle"));
    fireEvent.click(await screen.findByTestId("placement-preview-refresh"));
    await waitFor(() => expect(previewPayloads).toHaveLength(1));

    fireEvent.click(screen.getByTestId("submit-job-confirm"));
    await waitFor(() => expect(submittedPayloads).toHaveLength(1));
    expect(previewPayloads[0]?.schedulingStrategy).toEqual({ queueId: "queue-named" });
    expect(submittedPayloads[0]?.schedulingStrategy).toEqual({ queueId: "queue-named" });
  });

  test("permits warning targets but blocks blocked targets without changing the selected mode", async () => {
    apiClient.api.get.mockResolvedValue({
      queues: [
        visibleQueue({
          queueId: "queue-warning",
          targetMode: "default",
          eligibility: "warning",
        }),
        visibleQueue({
          queueId: "queue-blocked",
          targetMode: "default",
          eligibility: "blocked",
        }),
      ],
    });
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    await prepareCommandJob();
    fireEvent.click(screen.getByTestId("submit-job-placement-default"));
    const queueSelect = await screen.findByTestId("submit-job-queue-select");
    fireEvent.change(queueSelect, { target: { value: "queue-warning" } });
    await waitFor(() =>
      expect(screen.getByTestId("submit-job-queue-eligibility").textContent).toContain("stale"),
    );
    expect(screen.getByTestId("submit-job-confirm")).toHaveProperty("disabled", false);

    fireEvent.change(queueSelect, { target: { value: "queue-blocked" } });
    await waitFor(() =>
      expect(screen.getByTestId("submit-job-confirm")).toHaveProperty("disabled", true),
    );
    expect(screen.getByTestId("submit-job-placement-default")).toHaveProperty("checked", true);
    expect((queueSelect as HTMLSelectElement).value).toBe("queue-blocked");
  });

  test.each([
    ["QUEUE_UNAVAILABLE", "This queue target is no longer available"],
    ["QUEUE_INVENTORY_UNAVAILABLE", "Queue observation is temporarily unavailable"],
  ])("retains a Named selection after %s", async (code, expectedMessage) => {
    apiClient.api.get.mockResolvedValue({
      queues: [visibleQueue({ queueId: "queue-named", targetMode: "named" })],
    });
    apiClient.api.post.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    await prepareCommandJob("retry-named-placement");
    fireEvent.click(screen.getByTestId("submit-job-placement-named"));
    const queueSelect = await screen.findByTestId("submit-job-queue-select");
    fireEvent.change(queueSelect, { target: { value: "queue-named" } });
    fireEvent.click(screen.getByTestId("submit-job-confirm"));

    expect((await screen.findByTestId("submit-job-queue-submit-error")).textContent).toContain(
      expectedMessage,
    );
    expect(screen.getByTestId("submit-job-placement-named")).toHaveProperty("checked", true);
    expect((queueSelect as HTMLSelectElement).value).toBe("queue-named");
    expect((screen.getByTestId("submit-job-name") as HTMLInputElement).value).toBe(
      "retry-named-placement",
    );
  });
});

describe("SubmitJobDialog usecase picker", () => {
  test("opens the software usecase catalog for the shortcut launch", async () => {
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} openUsecasePickerOnOpen={true} />, {
      wrapper: wrapper(),
    });

    expect(await screen.findByTestId("submit-usecase-picker-dialog")).toBeTruthy();
    expect(screen.getByTestId("submit-mode-usecase").getAttribute("data-state")).toBe("active");
  });

  test("keeps the picker dialog height fixed and scrolls the catalog", async () => {
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    fireEvent.click(await screen.findByTestId("submit-usecase-picker-open"));

    const dialog = await screen.findByTestId("submit-usecase-picker-dialog");
    expect(dialog.className).toContain("h-[min(88vh,900px)]");
    expect(dialog.className).toContain("overflow-hidden");
    expect(screen.getByTestId("submit-usecase-catalog-grid").className).toContain("overflow-auto");
  });

  test("uses a popup catalog and hides legacy script-style usecases", async () => {
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    expect(await screen.findByTestId("submit-usecase-input-steps")).toBeTruthy();
    expect(screen.queryByTestId("submit-usecase-input-script")).toBeNull();
    expect(screen.getByTestId("submit-usecase-picker-open").className).toContain("w-full");

    fireEvent.click(screen.getByTestId("submit-usecase-picker-open"));

    const dialog = await screen.findByTestId("submit-usecase-picker-dialog");
    expect(within(dialog).getByTestId("submit-usecase-option-uc-gromacs").className).toContain(
      "border-brand",
    );
    expect(within(dialog).getByTestId("submit-usecase-option-uc-bare")).toBeTruthy();
    expect(within(dialog).queryByTestId("submit-usecase-option-uc-script")).toBeNull();
  });

  test("filters the popup catalog by runtime, input shape, and software", async () => {
    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    fireEvent.click(await screen.findByTestId("submit-usecase-picker-open"));
    const dialog = await screen.findByTestId("submit-usecase-picker-dialog");

    fireEvent.change(within(dialog).getByTestId("submit-usecase-runtime-filter"), {
      target: { value: "Spack" },
    });
    await waitFor(() => {
      expect(within(dialog).getByTestId("submit-usecase-option-uc-gromacs")).toBeTruthy();
      expect(within(dialog).queryByTestId("submit-usecase-option-uc-bare")).toBeNull();
    });

    fireEvent.change(within(dialog).getByTestId("submit-usecase-input-filter"), {
      target: { value: "file" },
    });
    fireEvent.change(within(dialog).getByTestId("submit-usecase-software-filter"), {
      target: { value: "gromacs" },
    });

    await waitFor(() => {
      expect(within(dialog).getByTestId("submit-usecase-option-uc-gromacs")).toBeTruthy();
      expect(within(dialog).queryByTestId("submit-usecase-option-uc-bare")).toBeNull();
      expect(within(dialog).queryByTestId("submit-usecase-option-uc-script")).toBeNull();
    });
  });

  test("searches and filters governed Dataset inputs in the usecase catalog", async () => {
    softwareClient.listUsecasePackages.mockResolvedValue([datasetUsecase(), bareUsecase()]);

    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    fireEvent.click(await screen.findByTestId("submit-usecase-picker-open"));
    const dialog = await screen.findByTestId("submit-usecase-picker-dialog");
    const datasetId = "submit-usecase-option-00000000-0000-4000-8000-000000000101";

    fireEvent.change(within(dialog).getByTestId("submit-usecase-catalog-search"), {
      target: { value: "trajectoryDataset" },
    });
    await waitFor(() => {
      expect(within(dialog).getByTestId(datasetId)).toBeTruthy();
      expect(within(dialog).queryByTestId("submit-usecase-option-uc-bare")).toBeNull();
    });

    fireEvent.change(within(dialog).getByTestId("submit-usecase-catalog-search"), {
      target: { value: "" },
    });
    fireEvent.change(within(dialog).getByTestId("submit-usecase-input-filter"), {
      target: { value: "dataset" },
    });
    await waitFor(() => {
      expect(within(dialog).getByTestId(datasetId).textContent).toContain("Dataset");
      expect(within(dialog).queryByTestId("submit-usecase-option-uc-bare")).toBeNull();
    });
  });

  test("requires a Dataset selection and carries the Server input through preview and submit", async () => {
    softwareClient.listUsecasePackages.mockResolvedValue([datasetUsecase()]);
    apiClient.api.get.mockImplementation(async (path: string) => {
      if (path === "/queues/visible") return { queues: [] };
      if (path.includes("/dataset-options?descriptor=trajectoryDataset")) {
        return { options: [datasetOption], total: 1, limit: 25, offset: 0 };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    apiClient.api.post.mockImplementation(
      async (path: string, payload: Record<string, unknown>) => {
        if (path === "/jobs/usecase/materialize") {
          return {
            job: {
              name: payload.name,
              command: "analyze",
              resources: payload.resources,
              dataInputs: payload.dataInputs,
            },
          };
        }
        if (path === "/scheduler/preview-placement") {
          return { candidates: [], stages: [], finalDecision: null };
        }
        if (path === "/jobs/usecase") {
          return { id: "job-dataset", name: payload.name, status: "pending" };
        }
        throw new Error(`unexpected POST ${path}`);
      },
    );

    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const select = await screen.findByTestId("submit-usecase-dataset-select-trajectoryDataset");
    expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));

    fireEvent.change(select, { target: { value: datasetOption.versionId } });
    await waitFor(() =>
      expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(false),
    );

    fireEvent.click(screen.getByTestId("placement-preview-toggle"));
    fireEvent.click(await screen.findByTestId("placement-preview-refresh"));

    const dataInputs = { trajectoryDataset: datasetOption.input };
    await waitFor(() =>
      expect(apiClient.api.post).toHaveBeenCalledWith(
        "/jobs/usecase/materialize",
        expect.objectContaining({ dataInputs }),
      ),
    );
    expect(apiClient.api.post).toHaveBeenCalledWith(
      "/scheduler/preview-placement",
      expect.objectContaining({ dataInputs }),
    );

    fireEvent.click(screen.getByTestId("submit-job-confirm"));
    await waitFor(() =>
      expect(apiClient.api.post).toHaveBeenCalledWith(
        "/jobs/usecase",
        expect.objectContaining({ dataInputs }),
      ),
    );
  });

  test("searches and loads Dataset options beyond the first page", async () => {
    softwareClient.listUsecasePackages.mockResolvedValue([datasetUsecase()]);
    const firstPage = Array.from({ length: 25 }, (_, index) => ({
      ...datasetOption,
      assetId: `asset-${index}`,
      assetName: `Trajectory ${index}`,
      versionId: `version-${index}`,
      version: String(index),
      input: {
        ...datasetOption.input,
        assetId: `asset-${index}`,
        versionId: `version-${index}`,
      },
    }));
    const lastOption = {
      ...datasetOption,
      assetId: "asset-25",
      assetName: "Deep trajectory",
      versionId: "version-25",
      version: "25",
      input: { ...datasetOption.input, assetId: "asset-25", versionId: "version-25" },
    };
    apiClient.api.get.mockImplementation(async (path: string) => {
      if (path === "/queues/visible") return { queues: [] };
      if (path.includes("/dataset-options?")) {
        const params = new URLSearchParams(path.split("?")[1]);
        if (params.get("q") === "deep") {
          return { options: [lastOption], total: 1, limit: 25, offset: 0 };
        }
        if (params.get("offset") === "25") {
          return { options: [lastOption], total: 26, limit: 25, offset: 25 };
        }
        return { options: firstPage, total: 26, limit: 25, offset: 0 };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const select = await screen.findByTestId("submit-usecase-dataset-select-trajectoryDataset");
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("submit-usecase-dataset-load-more-trajectoryDataset"));
    await waitFor(() => expect(select.textContent).toContain("Deep trajectory"));
    expect(apiClient.api.get).toHaveBeenCalledWith(expect.stringContaining("offset=25"));

    fireEvent.change(screen.getByTestId("submit-usecase-dataset-search-trajectoryDataset"), {
      target: { value: "deep" },
    });
    await waitFor(() =>
      expect(apiClient.api.get).toHaveBeenCalledWith(expect.stringContaining("q=deep")),
    );
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: lastOption.versionId } });
    await waitFor(() =>
      expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(false),
    );
  });

  test("keeps a withdrawn Dataset selection visible and blocks submission after refresh", async () => {
    softwareClient.listUsecasePackages.mockResolvedValue([datasetUsecase()]);
    let datasetRequest = 0;
    apiClient.api.get.mockImplementation(async (path: string) => {
      if (path === "/queues/visible") return { queues: [] };
      if (path.includes("/dataset-options?")) {
        datasetRequest += 1;
        return datasetRequest === 1
          ? { options: [datasetOption], total: 1, limit: 25, offset: 0 }
          : { options: [], total: 0, limit: 25, offset: 0 };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const select = await screen.findByTestId("submit-usecase-dataset-select-trajectoryDataset");
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: datasetOption.versionId } });
    await waitFor(() =>
      expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(false),
    );

    fireEvent.click(screen.getByTestId("submit-usecase-dataset-refresh-trajectoryDataset"));
    expect(await screen.findByText("jobs.usecase.datasetSelectionUnavailable")).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe(datasetOption.versionId);
    expect(screen.getByTestId("submit-usecase-dataset-clear-trajectoryDataset")).toBeTruthy();
    expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(true);
  });

  test("blocks a selected Dataset when refresh cannot verify it", async () => {
    softwareClient.listUsecasePackages.mockResolvedValue([datasetUsecase()]);
    let datasetRequest = 0;
    apiClient.api.get.mockImplementation(async (path: string) => {
      if (path === "/queues/visible") return { queues: [] };
      if (path.includes("/dataset-options?")) {
        datasetRequest += 1;
        if (datasetRequest === 1) {
          return { options: [datasetOption], total: 1, limit: 25, offset: 0 };
        }
        throw new Error("Dataset verification unavailable");
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const select = await screen.findByTestId("submit-usecase-dataset-select-trajectoryDataset");
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: datasetOption.versionId } });
    await waitFor(() =>
      expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(false),
    );

    fireEvent.click(screen.getByTestId("submit-usecase-dataset-refresh-trajectoryDataset"));
    expect(await screen.findByText("jobs.usecase.datasetSelectionUnverified")).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe(datasetOption.versionId);
    expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(true);
  });

  test("clears Dataset readiness when the selection is cleared or the usecase changes", async () => {
    softwareClient.listUsecasePackages.mockResolvedValue([datasetUsecase(), bareUsecase()]);
    apiClient.api.get.mockImplementation(async (path: string) => {
      if (path === "/queues/visible") return { queues: [] };
      if (path.includes("/dataset-options?descriptor=trajectoryDataset")) {
        return { options: [datasetOption], total: 1, limit: 25, offset: 0 };
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const select = await screen.findByTestId("submit-usecase-dataset-select-trajectoryDataset");
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: datasetOption.versionId } });
    await waitFor(() =>
      expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByTestId("submit-usecase-dataset-clear-trajectoryDataset"));
    expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByTestId("submit-usecase-dataset-select-trajectoryDataset"), {
      target: { value: datasetOption.versionId },
    });
    fireEvent.click(screen.getByTestId("submit-usecase-picker-open"));
    fireEvent.click(await screen.findByTestId("submit-usecase-option-uc-bare"));
    fireEvent.change(await screen.findByTestId("submit-usecase-input-filename"), {
      target: { value: "input.dat" },
    });
    expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByTestId("submit-usecase-picker-open"));
    fireEvent.click(
      await screen.findByTestId("submit-usecase-option-00000000-0000-4000-8000-000000000101"),
    );
    await screen.findByTestId("submit-usecase-dataset-select-trajectoryDataset");
    expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(true);
  });

  test("shows Dataset loading and empty states without blocking an optional Dataset", async () => {
    softwareClient.listUsecasePackages.mockResolvedValue([datasetUsecase(false)]);
    let resolveOptions: ((value: unknown) => void) | undefined;
    const options = new Promise((resolve) => {
      resolveOptions = resolve;
    });
    apiClient.api.get.mockImplementation(async (path: string) => {
      if (path === "/queues/visible") return { queues: [] };
      if (path.includes("/dataset-options?descriptor=trajectoryDataset")) return options;
      throw new Error(`unexpected GET ${path}`);
    });

    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const select = await screen.findByTestId("submit-usecase-dataset-select-trajectoryDataset");
    expect((select as HTMLSelectElement).disabled).toBe(true);
    expect(select.textContent).toContain("jobs.usecase.datasetLoading");
    expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(false);

    resolveOptions?.({ options: [], total: 0, limit: 25, offset: 0 });
    await waitFor(() => expect(select.textContent).toContain("jobs.usecase.datasetEmpty"));
    expect(screen.getByText("jobs.usecase.datasetEmptyHint")).toBeTruthy();
    expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(false);
  });

  test("shows the Dataset options error and keeps a required Dataset blocked", async () => {
    softwareClient.listUsecasePackages.mockResolvedValue([datasetUsecase()]);
    apiClient.api.get.mockImplementation(async (path: string) => {
      if (path === "/queues/visible") return { queues: [] };
      if (path.includes("/dataset-options?descriptor=trajectoryDataset")) {
        throw new Error("Dataset catalog unavailable");
      }
      throw new Error(`unexpected GET ${path}`);
    });

    render(<SubmitJobDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    expect((await screen.findAllByText("jobs.usecase.datasetLoadFailed")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("Dataset catalog unavailable")).toBeNull();
    expect(
      (screen.getByTestId("submit-usecase-dataset-select-trajectoryDataset") as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByTestId("submit-job-confirm").hasAttribute("disabled")).toBe(true);
  });
});
