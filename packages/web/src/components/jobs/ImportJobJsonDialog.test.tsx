import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ImportJobJsonDialog } from "./ImportJobJsonDialog";

const apiClient = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ApiError";
    }
  },
  api: { get: vi.fn(), post: vi.fn() },
}));

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../../lib/api-client", () => apiClient);
vi.mock("sonner", () => ({ toast }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.defaultValue === "string" ? opts.defaultValue : key,
  }),
}));

function wrapper(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function jobJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "imported-analysis",
    command: "python analyze.py --input input.csv",
    resources: { cpus: 4, memoryMb: 8192, gpus: 1 },
    schedulingStrategy: { queueId: "gpu-standard" },
    ...overrides,
  });
}

function jsonFile(content: string, name = "analysis.json") {
  const file = new File([content], name, { type: "application/json" });
  Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(content) });
  return file;
}

function chooseFile(file: File) {
  fireEvent.change(screen.getByTestId("import-job-json-file"), { target: { files: [file] } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function visibleQueue(queueId = "gpu-standard") {
  return {
    queueId,
    name: "GPU standard",
    providerOrgId: "11111111-1111-4111-8111-111111111111",
    visibleOrgIds: [],
    agentId: "agent-pbs",
    schedulerType: "pbs-pro" as const,
    queueName: "workq",
    target: { mode: "named" as const },
    qos: null,
    enabled: true,
    policyTags: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    submitEligibility: { state: "ready" as const, reason: null, retryable: false },
  };
}

beforeEach(() => {
  apiClient.api.get.mockResolvedValue({ queues: [visibleQueue()] });
  apiClient.api.post.mockResolvedValue({
    id: "job-12345678",
    name: "imported-analysis",
    status: "pending",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ImportJobJsonDialog", () => {
  test("shows a validated job preview and does not submit before confirmation", async () => {
    render(<ImportJobJsonDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    chooseFile(jsonFile(jobJson()));

    expect(await screen.findByTestId("import-job-json-preview")).toBeTruthy();
    expect(screen.getByTestId("import-job-json-name").textContent).toBe("imported-analysis");
    expect(screen.getByTestId("import-job-json-command").textContent).toContain("analyze.py");
    expect(screen.getByTestId("import-job-json-resources").textContent).toContain("4 CPU");
    expect(screen.getByTestId("import-job-json-resources").textContent).toContain("1 GPU");
    expect(screen.getByTestId("import-job-json-queue").textContent).toBe("gpu-standard");
    expect(apiClient.api.post).not.toHaveBeenCalled();
  });

  test("keeps the most recently selected file when an earlier read finishes late", async () => {
    render(<ImportJobJsonDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });
    const slowRead = deferred<string>();
    const slowFile = new File([""], "slow.json", { type: "application/json" });
    Object.defineProperty(slowFile, "text", { value: vi.fn(() => slowRead.promise) });

    chooseFile(slowFile);
    chooseFile(jsonFile(jobJson({ name: "latest-selection" }), "latest.json"));
    expect((await screen.findByTestId("import-job-json-name")).textContent).toBe(
      "latest-selection",
    );

    slowRead.resolve(jobJson({ name: "stale-selection" }));
    await Promise.resolve();
    expect(screen.getByTestId("import-job-json-name").textContent).toBe("latest-selection");
  });

  test("submits the complete sanitized JobSubmit only after confirmation", async () => {
    const onOpenChange = vi.fn();
    const onImported = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <ImportJobJsonDialog open={true} onOpenChange={onOpenChange} onImported={onImported} />,
      { wrapper: wrapper(queryClient) },
    );

    chooseFile(
      jsonFile(
        jobJson({
          tags: ["chemistry", "batch"],
          envVars: { OMP_NUM_THREADS: "4" },
          softwareRequirements: [{ name: "gromacs", version: "2024.1" }],
          inputStaging: [
            {
              fileMetadataId: "file-1",
              stagePath: "inputs/topology.tpr",
              sourceUrl: "https://storage.example.invalid/presigned",
            },
          ],
          expectedOutputs: [{ descriptor: "trajectory", path: "outputs/traj.xtc", isBatch: false }],
          requires: { locality: { dataSites: ["site-a"] } },
        }),
      ),
    );
    await screen.findByTestId("import-job-json-preview");
    await waitFor(() =>
      expect(screen.getByTestId("import-job-json-submit")).not.toHaveProperty("disabled", true),
    );

    const advanced = screen.getByTestId("import-job-json-advanced-fields");
    expect(advanced.textContent).toContain("envVars");
    expect(advanced.textContent).toContain("softwareRequirements");
    expect(advanced.textContent).toContain("expectedOutputs");

    fireEvent.click(screen.getByTestId("import-job-json-submit"));

    await waitFor(() => expect(apiClient.api.post).toHaveBeenCalledTimes(1));
    expect(apiClient.api.post).toHaveBeenCalledWith("/jobs", {
      name: "imported-analysis",
      command: "python analyze.py --input input.csv",
      resources: { cpus: 4, memoryMb: 8192, gpus: 1 },
      schedulingStrategy: { queueId: "gpu-standard" },
      tags: ["chemistry", "batch"],
      envVars: { OMP_NUM_THREADS: "4" },
      softwareRequirements: [{ name: "gromacs", version: "2024.1", installable: false }],
      inputStaging: [{ fileMetadataId: "file-1", stagePath: "inputs/topology.tpr" }],
      expectedOutputs: [{ descriptor: "trajectory", path: "outputs/traj.xtc", isBatch: false }],
      requires: { locality: { dataSites: ["site-a"] } },
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["jobs-list"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
    expect(onImported).toHaveBeenCalledWith({
      id: "job-12345678",
      name: "imported-analysis",
      status: "pending",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalled();
  });

  test("does not dismiss while the confirmed submission is still running", async () => {
    const onOpenChange = vi.fn();
    const pending = deferred<{ id: string; name: string; status: string }>();
    apiClient.api.post.mockReturnValueOnce(pending.promise);
    render(<ImportJobJsonDialog open={true} onOpenChange={onOpenChange} />, {
      wrapper: wrapper(),
    });
    chooseFile(jsonFile(jobJson()));
    await screen.findByTestId("import-job-json-preview");
    await waitFor(() =>
      expect(screen.getByTestId("import-job-json-submit")).not.toHaveProperty("disabled", true),
    );
    fireEvent.click(screen.getByTestId("import-job-json-submit"));
    await waitFor(() => expect(apiClient.api.post).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("import-job-json-dialog")).toBeTruthy();

    pending.resolve({ id: "job-12345678", name: "imported-analysis", status: "pending" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test("keeps the dialog recoverable for unreadable, malformed, and schema-invalid files", async () => {
    render(<ImportJobJsonDialog open={true} onOpenChange={() => {}} />, { wrapper: wrapper() });

    const unreadable = new File([""], "unreadable.json", { type: "application/json" });
    Object.defineProperty(unreadable, "text", {
      value: vi.fn().mockRejectedValue(new Error("read")),
    });
    chooseFile(unreadable);
    expect((await screen.findByTestId("import-job-json-error")).textContent).toContain(
      "Unable to read this JSON file.",
    );

    chooseFile(jsonFile("{ invalid"));
    await waitFor(() => {
      expect(screen.getByTestId("import-job-json-error").textContent).toContain(
        "This file is not valid JSON.",
      );
    });

    chooseFile(jsonFile(JSON.stringify({ name: "missing fields" })));
    await waitFor(() => {
      expect(screen.getByTestId("import-job-json-error").textContent).toContain(
        "This JSON does not contain a valid job submission.",
      );
    });
    expect(screen.queryByTestId("import-job-json-preview")).toBeNull();
    expect(apiClient.api.post).not.toHaveBeenCalled();
    expect(screen.getByTestId("import-job-json-submit").hasAttribute("disabled")).toBe(true);
  });

  test("clears the imported file when cancelled and reopened", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<ImportJobJsonDialog open={true} onOpenChange={onOpenChange} />, {
      wrapper: wrapper(),
    });
    chooseFile(jsonFile(jobJson()));
    await screen.findByTestId("import-job-json-preview");

    fireEvent.click(screen.getByText("Cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(<ImportJobJsonDialog open={false} onOpenChange={onOpenChange} />);
    rerender(<ImportJobJsonDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.queryByTestId("import-job-json-preview")).toBeNull();
    expect(screen.getByTestId("import-job-json-submit").hasAttribute("disabled")).toBe(true);
  });
});
