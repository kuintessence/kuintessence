import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, uploadFileToNetDrive } from "../../lib/api-client";
import { CommandWorkdirDialog, type CommandWorkdirEntry } from "./CommandWorkdirDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string; count?: number }) =>
      opts?.defaultValue ?? String(opts?.count ?? _key),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  api: {
    get: vi.fn(),
  },
  uploadFileToNetDrive: vi.fn(),
}));

function withQueryClient(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderDialog(props?: Partial<React.ComponentProps<typeof CommandWorkdirDialog>>) {
  const onApply = vi.fn();
  const onOpenChange = vi.fn();
  render(
    withQueryClient(
      <CommandWorkdirDialog
        entries={[]}
        onApply={onApply}
        onOpenChange={onOpenChange}
        open={true}
        uploadPrefix="jobs/command-drafts/test-draft"
        {...props}
      />,
    ),
  );
  return { onApply, onOpenChange };
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({
    success: true,
    data: {
      files: [
        {
          id: "cloud-a",
          path: "datasets/input/a.txt",
          size: 5,
          mtime: "2026-07-03T00:00:00.000Z",
        },
        {
          id: "cloud-b",
          path: "datasets/input/nested/b.txt",
          size: 7,
          mtime: "2026-07-03T00:00:00.000Z",
        },
        {
          id: "cloud-root",
          path: "root.txt",
          size: 3,
          mtime: "2026-07-03T00:00:00.000Z",
        },
      ],
      total: 1,
    },
  });
  vi.mocked(uploadFileToNetDrive).mockResolvedValue({
    id: "upload-1",
    path: "jobs/command-drafts/test-draft/local.txt",
    size: 9,
    sha256: "abc",
    contentType: "text/plain",
    storageKey: "storage-key",
    mtime: "2026-07-03T00:00:00.000Z",
    createdAt: "2026-07-03T00:00:00.000Z",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("CommandWorkdirDialog", () => {
  test("keeps a fixed dialog height and scrolls pane content", async () => {
    renderDialog();

    const dialog = await screen.findByTestId("command-workdir-dialog");
    expect(dialog.className).toContain("h-[min(88vh,900px)]");
    expect(dialog.className).toContain("overflow-hidden");
    expect(screen.getByTestId("command-workdir-entries").className).toContain("overflow-auto");
  });

  test("adds a NetDrive file to the draft workdir with basename stagePath", async () => {
    const { onApply } = renderDialog();

    fireEvent.click(await screen.findByTestId("command-workdir-cloud-dir-datasets"));
    fireEvent.click(await screen.findByTestId("command-workdir-cloud-dir-datasets-input"));
    fireEvent.click(await screen.findByTestId("command-workdir-add-cloud-a"));
    const rightPane = screen.getByTestId("command-workdir-entries");
    expect(within(rightPane).getByDisplayValue("a.txt")).toBeTruthy();

    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    await waitFor(() => expect(onApply).toHaveBeenCalled());
    const entries = onApply.mock.calls[0]?.[0] as CommandWorkdirEntry[];
    expect(entries).toEqual([
      {
        id: "cloud:cloud-a",
        source: "cloud",
        fileMetadataId: "cloud-a",
        fileMetadataName: "a.txt",
        cloudPath: "datasets/input/a.txt",
        stagePath: "a.txt",
        size: 5,
      },
    ]);
  });

  test("browses NetDrive files by folder hierarchy", async () => {
    renderDialog();

    expect(await screen.findByTestId("command-workdir-cloud-dir-datasets")).toBeTruthy();
    expect(screen.getByTestId("command-workdir-add-cloud-root")).toBeTruthy();
    expect(screen.queryByTestId("command-workdir-add-cloud-a")).toBeNull();

    fireEvent.click(screen.getByTestId("command-workdir-cloud-dir-datasets"));
    expect(await screen.findByTestId("command-workdir-cloud-dir-datasets-input")).toBeTruthy();
    expect(screen.queryByTestId("command-workdir-add-cloud-root")).toBeNull();

    fireEvent.click(screen.getByTestId("command-workdir-cloud-dir-datasets-input"));
    expect(await screen.findByTestId("command-workdir-add-cloud-a")).toBeTruthy();
    expect(screen.getByTestId("command-workdir-cloud-dir-datasets-input-nested")).toBeTruthy();
  });

  test("disables cloud upload while NetDrive files are still loading", () => {
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}));
    renderDialog();

    expect(screen.getByTestId("command-workdir-cloud-search")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("command-workdir-upload")).toHaveProperty("disabled", true);
  });

  test("surfaces NetDrive list errors and blocks cloud upload", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("NetDrive scope denied"));
    renderDialog();

    const error = await screen.findByTestId("command-workdir-cloud-error");
    expect(error.textContent).toContain("Unavailable");
    expect(error.textContent).toContain("无法加载 NetDrive 文件，请稍后重试。");
    expect(error.textContent).not.toContain("NetDrive scope denied");
    expect(error.textContent).not.toContain("Authorization denied");
    expect(error.textContent).not.toContain("FORBIDDEN");
    expect(screen.getByTestId("command-workdir-cloud-search")).toHaveProperty("disabled", true);
    const upload = screen.getByTestId("command-workdir-upload");
    expect(upload).toHaveProperty("disabled", true);
    const file = new File(["local"], "local.txt", { type: "text/plain" });

    fireEvent.change(upload, { target: { files: [file] } });

    expect(uploadFileToNetDrive).not.toHaveBeenCalled();
  });

  test("blocks applying staged files while NetDrive files are still loading", () => {
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}));
    const { onApply } = renderDialog({
      entries: [
        {
          id: "existing",
          source: "cloud",
          fileMetadataId: "cloud-a",
          fileMetadataName: "a.txt",
          cloudPath: "datasets/input/a.txt",
          stagePath: "a.txt",
          size: 5,
        },
      ],
    });

    expect(screen.getByTestId("command-workdir-confirm")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    expect(onApply).not.toHaveBeenCalled();
  });

  test("blocks applying staged files when NetDrive list fails", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("NetDrive scope denied"));
    const { onApply } = renderDialog({
      entries: [
        {
          id: "existing",
          source: "cloud",
          fileMetadataId: "cloud-a",
          fileMetadataName: "a.txt",
          cloudPath: "datasets/input/a.txt",
          stagePath: "a.txt",
          size: 5,
        },
      ],
    });

    const error = await screen.findByTestId("command-workdir-cloud-error");
    expect(error.textContent).toContain("无法加载 NetDrive 文件，请稍后重试。");
    expect(error.textContent).not.toContain("NetDrive scope denied");
    expect(error.textContent).not.toContain("FORBIDDEN");
    expect(screen.getByTestId("command-workdir-confirm")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    expect(onApply).not.toHaveBeenCalled();
  });

  test("allows folder-only changes while NetDrive files are still loading", async () => {
    vi.mocked(api.get).mockImplementation(() => new Promise(() => {}));
    const { onApply } = renderDialog();

    fireEvent.change(screen.getByTestId("command-workdir-new-folder-name"), {
      target: { value: "scratch" },
    });
    fireEvent.click(screen.getByTestId("command-workdir-create-folder"));

    expect(await screen.findByTestId("command-workdir-open-dir-scratch")).toBeTruthy();
    expect(screen.getByTestId("command-workdir-confirm")).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    await waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(onApply.mock.calls[0]?.[0]).toEqual([]);
    expect(onApply.mock.calls[0]?.[1]).toEqual(["scratch/"]);
  });

  test("creates, renames, and deletes workdir subfolders", async () => {
    const { onApply } = renderDialog();

    fireEvent.change(screen.getByTestId("command-workdir-new-folder-name"), {
      target: { value: "inputs" },
    });
    fireEvent.click(screen.getByTestId("command-workdir-create-folder"));
    expect(await screen.findByTestId("command-workdir-open-dir-inputs")).toBeTruthy();
    fireEvent.click(await screen.findByTestId("command-workdir-open-dir-inputs"));

    fireEvent.click(await screen.findByTestId("command-workdir-cloud-dir-datasets"));
    fireEvent.click(await screen.findByTestId("command-workdir-cloud-dir-datasets-input"));
    fireEvent.click(await screen.findByTestId("command-workdir-add-cloud-a"));
    expect(await screen.findByDisplayValue("inputs/a.txt")).toBeTruthy();

    fireEvent.click(screen.getByTestId("command-workdir-up"));
    fireEvent.change(screen.getByTestId("command-workdir-rename-dir-inputs"), {
      target: { value: "renamed" },
    });
    fireEvent.click(await screen.findByTestId("command-workdir-open-dir-renamed"));
    expect(await screen.findByDisplayValue("renamed/a.txt")).toBeTruthy();

    fireEvent.click(screen.getByTestId("command-workdir-up"));
    fireEvent.click(screen.getByTestId("command-workdir-delete-dir-renamed"));
    expect(screen.queryByDisplayValue("renamed/a.txt")).toBeNull();

    fireEvent.click(screen.getByTestId("command-workdir-confirm"));
    await waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(onApply.mock.calls[0]?.[0]).toEqual([]);
  });

  test("shows slash-created empty folder hierarchies immediately and after confirm", async () => {
    const { onApply } = renderDialog();

    fireEvent.change(screen.getByTestId("command-workdir-new-folder-name"), {
      target: { value: "inputs/nested" },
    });
    fireEvent.click(screen.getByTestId("command-workdir-create-folder"));

    expect(await screen.findByTestId("command-workdir-open-dir-inputs")).toBeTruthy();
    fireEvent.click(screen.getByTestId("command-workdir-open-dir-inputs"));
    expect(await screen.findByTestId("command-workdir-open-dir-inputs-nested")).toBeTruthy();
    expect(screen.getByText("Empty folder")).toBeTruthy();

    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    await waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(onApply.mock.calls[0]?.[1]).toEqual(["inputs/", "inputs/nested/"]);
  });

  test("creates an empty workdir folder with Enter and keeps it visible", async () => {
    const { onApply } = renderDialog();

    fireEvent.change(screen.getByTestId("command-workdir-new-folder-name"), {
      target: { value: "scratch" },
    });
    fireEvent.keyDown(screen.getByTestId("command-workdir-new-folder-name"), {
      key: "Enter",
      code: "Enter",
    });

    expect(await screen.findByTestId("command-workdir-open-dir-scratch")).toBeTruthy();
    expect(screen.getByText("Empty folder")).toBeTruthy();

    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    await waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(onApply.mock.calls[0]?.[0]).toEqual([]);
    expect(onApply.mock.calls[0]?.[1]).toEqual(["scratch/"]);
  });

  test("keeps long paths inside truncating rows", () => {
    const longPath = [
      "workflow-runs",
      "ab708862-477d-4e48-a004-cad47e27408d",
      "jobs",
      "202452d6-fd96-4412-a931-very-long-folder-name",
      "chunks_b.txt",
    ].join("/");
    const longStagePath =
      "chunks_b_with_a_very_long_flat_stage_name_that_should_not_resize_the_dialog.txt";
    renderDialog({
      entries: [
        {
          id: "long-entry",
          source: "cloud",
          fileMetadataId: "long",
          fileMetadataName: "chunks_b.txt",
          cloudPath: longPath,
          stagePath: longStagePath,
          size: 5,
        },
      ],
    });

    const row = screen.getByTestId("command-workdir-entry-long");
    expect(row.className).toContain("min-w-0");
    expect(screen.getByTestId("command-workdir-entry-cloud-long").className).toContain("truncate");
    expect(screen.getByTestId("command-workdir-stage-long").className).toContain("truncate");
  });

  test("uploads a local file to NetDrive and adds it to the draft workdir", async () => {
    const { onApply } = renderDialog();
    const upload = screen.getByTestId("command-workdir-upload");
    const file = new File(["local"], "local.txt", { type: "text/plain" });

    await waitFor(() => expect(upload).toHaveProperty("disabled", false));
    fireEvent.change(upload, { target: { files: [file] } });

    await waitFor(() =>
      expect(uploadFileToNetDrive).toHaveBeenCalledWith(file, "jobs/command-drafts/test-draft"),
    );
    expect(await screen.findByDisplayValue("local.txt")).toBeTruthy();

    fireEvent.click(screen.getByTestId("command-workdir-confirm"));
    await waitFor(() => expect(onApply).toHaveBeenCalled());
    const entries = onApply.mock.calls[0]?.[0] as CommandWorkdirEntry[];
    expect(entries[0]).toMatchObject({
      source: "upload",
      fileMetadataId: "upload-1",
      fileMetadataName: "local.txt",
      cloudPath: "jobs/command-drafts/test-draft/local.txt",
      stagePath: "local.txt",
      size: 9,
    });
  });

  test("blocks confirmation when two entries target the same stagePath", async () => {
    const duplicateEntries: CommandWorkdirEntry[] = [
      {
        id: "one",
        source: "cloud",
        fileMetadataId: "one",
        fileMetadataName: "one.txt",
        cloudPath: "one.txt",
        stagePath: "inputs/data.txt",
        size: 1,
      },
      {
        id: "two",
        source: "cloud",
        fileMetadataId: "two",
        fileMetadataName: "two.txt",
        cloudPath: "two.txt",
        stagePath: "inputs/data.txt",
        size: 1,
      },
    ];
    const { onApply } = renderDialog({ entries: duplicateEntries });

    await waitFor(() =>
      expect(screen.getByTestId("command-workdir-confirm")).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByTestId("command-workdir-confirm"));

    expect(await screen.findByTestId("command-workdir-error")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });
});
