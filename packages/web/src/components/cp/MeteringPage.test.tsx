import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock("echarts-for-react", () => ({ default: () => null }));

vi.mock("../ThemeProvider", () => ({
  useTheme: () => ({ resolved: "light", theme: "light", setTheme: vi.fn() }),
}));

// Keep `api` real (the query path uses the fetch stub below); only replace the
// file-download helper so the export test asserts the call without touching
// happy-dom's missing URL.createObjectURL / anchor-click.
vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return { ...actual, downloadAuthedFile: vi.fn(() => Promise.resolve()) };
});

import { downloadAuthedFile } from "../../lib/api-client";
import { MeteringPage } from "./MeteringPage";

const downloadMock = vi.mocked(downloadAuthedFile);

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

interface MeteringRow {
  groupKey: string;
  cpuCoreSeconds: number;
  gpuSeconds: number;
  memoryMbSeconds: number;
  storageMbSeconds: number;
  networkEgressMb: number;
  jobCount: number;
}

function row(over: Partial<MeteringRow> = {}): MeteringRow {
  return {
    groupKey: "org-A",
    cpuCoreSeconds: 7200,
    gpuSeconds: 0,
    memoryMbSeconds: 0,
    storageMbSeconds: 0,
    networkEgressMb: 0,
    jobCount: 3,
    ...over,
  };
}

function stubFetch(payload: { rows: MeteringRow[]; total: number }, ok = true) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: ok ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubErrorFetch(status: number, code: string, message: string) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  const calls = fetchMock.mock.calls;
  const last = calls[calls.length - 1];
  const input = last?.[0];
  return typeof input === "string" ? input : String(input);
}

beforeEach(() => {
  localStorage.setItem("kq_token", "test-token");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("MeteringPage", () => {
  test("can render a read-only report without webhook management", async () => {
    stubFetch({ rows: [row()], total: 1 });

    render(<MeteringPage showWebhooks={false} />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("metering-row-0")).toBeTruthy();
    });
    expect(screen.queryByTestId("metering-webhooks")).toBeNull();
  });

  test("defaults recent usage queries to the raw tier", async () => {
    stubFetch({ rows: [row()], total: 1 });

    render(<MeteringPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("metering-row-0")).toBeTruthy();
    });
    expect((screen.getByTestId("metering-period") as HTMLSelectElement).value).toBe("raw");
  });

  test("renders a usage row with CPU core-hours and jobCount", async () => {
    stubFetch({ rows: [row()], total: 1 });

    render(<MeteringPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("metering-row-0")).toBeTruthy();
    });

    const rowEl = screen.getByTestId("metering-row-0");
    expect(rowEl.textContent).toContain("org-A");
    expect(rowEl.textContent).toContain("2.00");
    expect(rowEl.textContent).toContain("3");
    const scroller = screen.getByTestId("metering-table-scroll");
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.querySelector("table")?.className).toContain("min-w-[44rem]");
  });

  test("changing grouping refires the query with grouping=cluster", async () => {
    const fetchMock = stubFetch({ rows: [row()], total: 1 });

    render(<MeteringPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("metering-row-0")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("metering-grouping"), {
      target: { value: "cluster" },
    });

    await waitFor(() => {
      expect(lastUrl(fetchMock)).toContain("grouping=cluster");
    });
  });

  test("scopes CP queries and exports to the selected provider organization", async () => {
    const fetchMock = stubFetch({ rows: [row()], total: 1 });
    localStorage.setItem("kq_active_organization_id", "org-selected");

    render(<MeteringPage scopeToActiveOrganization />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(lastUrl(fetchMock)).toContain("orgIds=org-selected");
    });
    await screen.findByTestId("metering-row-0");
    fireEvent.click(screen.getByTestId("metering-export"));
    await waitFor(() => expect(downloadMock).toHaveBeenCalled());
    expect(String(downloadMock.mock.calls[0]?.[0])).toContain("orgIds=org-selected");
  });

  test("updates the query scope when the active organization changes without remounting", async () => {
    const fetchMock = stubFetch({ rows: [row()], total: 1 });
    localStorage.setItem("kq_active_organization_id", "org-a");

    render(<MeteringPage scopeToActiveOrganization />, { wrapper: makeWrapper() });
    await waitFor(() => expect(lastUrl(fetchMock)).toContain("orgIds=org-a"));

    localStorage.setItem("kq_active_organization_id", "org-b");
    window.dispatchEvent(new Event("kq:active-organization-change"));

    await waitFor(() => expect(lastUrl(fetchMock)).toContain("orgIds=org-b"));
  });

  test("empty result renders the empty state", async () => {
    stubFetch({ rows: [], total: 0 });

    render(<MeteringPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("metering-empty")).toBeTruthy();
    });
  });

  test("non-ok fetch renders the error state", async () => {
    stubFetch({ rows: [], total: 0 }, false);

    render(<MeteringPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId("metering-error")).toBeTruthy();
    });
  });

  test("forbidden query renders only the error state, not empty results or table", async () => {
    stubErrorFetch(403, "FORBIDDEN", "Not authorized to view metering");

    render(<MeteringPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      const error = screen.getByTestId("metering-error");
      expect(error.textContent).toMatch(/does not have permission|没有执行此操作的权限/);
      expect(error.textContent).not.toContain("Not authorized to view metering");
    });
    expect(screen.queryByTestId("metering-empty")).toBeNull();
    expect(screen.queryByTestId("metering-table")).toBeNull();
  });

  test("export button downloads CSV from the export endpoint with the current params", async () => {
    stubFetch({ rows: [row()], total: 1 });

    render(<MeteringPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("metering-row-0")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("metering-export"));

    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalled();
    });
    const call = downloadMock.mock.calls[0];
    expect(String(call?.[0])).toContain("/metering/export?");
    expect(String(call?.[0])).toContain("format=csv");
    expect(String(call?.[0])).toContain("grouping=org");
    expect(String(call?.[1])).toContain(".csv");
  });

  test("export failure renders friendly copy without exposing backend details", async () => {
    stubFetch({ rows: [row()], total: 1 });
    downloadMock.mockRejectedValueOnce(new Error("Parquet export is not enabled"));

    render(<MeteringPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("metering-row-0")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("metering-export"));

    await waitFor(() => {
      const error = screen.getByTestId("metering-export-error");
      expect(error.textContent).toContain("cp.metering.exportFailed");
      expect(error.textContent).not.toContain("Parquet export is not enabled");
    });
  });

  test("export button is disabled when there are no rows", async () => {
    stubFetch({ rows: [], total: 0 });

    render(<MeteringPage />, { wrapper: makeWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId("metering-empty")).toBeTruthy();
    });
    expect(screen.getByTestId("metering-export").hasAttribute("disabled")).toBe(true);
  });

  test("does not replace an invalid time with the current time and avoids a query", async () => {
    const fetchMock = stubFetch({ rows: [row()], total: 1 });

    render(<MeteringPage showWebhooks={false} />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("metering-row-0")).toBeTruthy());
    const callsBeforeInvalidInput = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByTestId("metering-from"), { target: { value: "not-a-date" } });

    expect(screen.getByTestId("metering-range-error").textContent).toContain(
      "cp.metering.invalidRange",
    );
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeInvalidInput);
    expect((screen.getByTestId("metering-export") as HTMLButtonElement).disabled).toBe(true);
  });

  test("rejects a reversed time window before requesting or exporting usage", async () => {
    const fetchMock = stubFetch({ rows: [row()], total: 1 });

    render(<MeteringPage showWebhooks={false} />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("metering-row-0")).toBeTruthy());
    const callsBeforeReverseRange = fetchMock.mock.calls.length;
    const from = screen.getByTestId("metering-from") as HTMLInputElement;
    const to = screen.getByTestId("metering-to") as HTMLInputElement;

    fireEvent.change(from, { target: { value: "2026-09-02T12:00" } });
    fireEvent.change(to, { target: { value: "2026-09-01T12:00" } });

    expect(screen.getByTestId("metering-range-error").textContent).toContain(
      "cp.metering.fromAfterTo",
    );
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(callsBeforeReverseRange + 1);
    fireEvent.click(screen.getByTestId("metering-export"));
    expect(downloadMock).not.toHaveBeenCalled();
  });

  test("labels a metering result that was truncated at the shared export limit", async () => {
    stubFetch({ rows: [row()], total: 1_001 });

    render(<MeteringPage showWebhooks={false} />, { wrapper: makeWrapper() });

    await waitFor(() => expect(screen.getByTestId("metering-partial-result")).toBeTruthy());
    expect(screen.getByTestId("metering-partial-result").textContent).toContain(
      "cp.metering.partialResult",
    );
  });
});
