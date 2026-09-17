import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type DataAccessRequest,
  type DataAssetImport,
  type DataAssetSummary,
  type DataAssetVersion,
  dataMarketClient,
} from "../../lib/data-market-client";
import { CpDataPage } from "./CpDataPage";

const activeOrganization = vi.hoisted(() => ({ current: "org-a" as string | null }));
const notifications = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({ toast: notifications }));

vi.mock("../../lib/data-market-client", () => ({
  dataMarketClient: {
    createCpAsset: vi.fn(),
    createReplica: vi.fn(),
    cpAccessRequests: vi.fn().mockResolvedValue({ requests: [] }),
    cpAccessRequest: vi.fn(),
    cpAssets: vi.fn().mockResolvedValue({ assets: [] }),
    cpImports: vi.fn().mockResolvedValue({ imports: [] }),
    cpReplicas: vi.fn().mockResolvedValue({ replicas: [] }),
    cpVersions: vi.fn().mockResolvedValue({ versions: [] }),
    reviewCpAccessRequest: vi.fn(),
    startCpImport: vi.fn(),
    uploadAssetFileWithSession: vi.fn(),
  },
}));

vi.mock("../../lib/active-organization", () => ({
  useActiveOrganizationId: () => activeOrganization.current,
}));

vi.mock("../../lib/use-cp-agents", () => ({
  useCpAgents: () => ({
    data: [{ id: "agent-a", hostname: "compute-a", siteId: "site-a", status: "online" }],
    error: null,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useCpAgentClusterFileRoots: (agentId: string | null) => ({
    data: agentId
      ? [
          {
            id: "root-a",
            agentId: "agent-a",
            enabled: true,
            label: "Research data",
            path: "/data/research",
          },
          {
            id: "root-disabled",
            agentId: "agent-a",
            enabled: false,
            label: "Disabled",
            path: "/data/disabled",
          },
          {
            id: "root-global",
            agentId: null,
            enabled: true,
            label: "Global root",
            path: "/data/global",
          },
        ]
      : undefined,
    error: null,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

const client = vi.mocked(dataMarketClient);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("CpDataPage", () => {
  afterEach(() => {
    activeOrganization.current = "org-a";
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  test("uses an Agent to enabled-root cascade instead of internal ID inputs", () => {
    render(<CpDataPage />, { wrapper });

    const agent = screen.getByTestId("cp-data-agent-select");
    const root = screen.getByTestId("cp-data-root-select");
    expect((root as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(agent, { target: { value: "agent-a" } });
    expect((root as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByRole("option", { name: "Research data - /data/research" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Disabled - /data/disabled" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Global root - /data/global" })).toBeNull();
    expect(screen.getByPlaceholderText("cp.data.relativePath")).toBeTruthy();
    expect(screen.getByText("cp.data.cpLocalHint")).toBeTruthy();
  });

  test("does not load CP Data without an active organization", async () => {
    activeOrganization.current = null;

    render(<CpDataPage />, { wrapper });

    expect(screen.getByText("cp.data.organizationRequired")).toBeTruthy();
    await Promise.resolve();
    expect(client.cpAssets).not.toHaveBeenCalled();
    expect(client.cpImports).not.toHaveBeenCalled();
    expect(client.cpAccessRequests).not.toHaveBeenCalled();
  });

  test("keeps a failed asset query out of the empty list state and offers retry", async () => {
    const backendMessage = "权限不足";
    client.cpAssets.mockRejectedValueOnce(new Error(backendMessage));

    render(<CpDataPage />, { wrapper });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("cp.data.failed");
    expect(alert.textContent).not.toContain(backendMessage);
    expect(screen.queryByTestId(/cp-data-asset-/)).toBeNull();
    expect(screen.getByRole("button", { name: "common.refresh" })).toBeTruthy();
  });

  test("does not retain data from the previous active organization", async () => {
    client.cpAssets
      .mockResolvedValueOnce({
        assets: [
          {
            accessMode: "request",
            createdAt: "2026-08-12T00:00:00.000Z",
            description: null,
            id: "asset-a",
            kind: "scientific-dataset",
            lifecycle: "draft",
            name: "Organization A",
            ownerKind: "provider",
            ownerOrgId: "org-a",
            ownerUserId: null,
            providerOrgId: "org-a",
            sensitivity: "internal",
            tags: [],
            updatedAt: "2026-08-12T00:00:00.000Z",
            visibility: "organization",
          },
        ],
        limit: 25,
        offset: 0,
        total: 1,
      })
      .mockResolvedValueOnce({ assets: [], limit: 25, offset: 0, total: 0 });
    const result = render(<CpDataPage />, { wrapper });

    expect(await screen.findByText("Organization A")).toBeTruthy();
    fireEvent.change(screen.getByTestId("cp-data-agent-select"), {
      target: { value: "agent-a" },
    });
    fireEvent.change(screen.getByTestId("cp-data-root-select"), {
      target: { value: "root-a" },
    });
    activeOrganization.current = "org-b";
    result.rerender(<CpDataPage />);

    await waitFor(() => expect(screen.queryByText("Organization A")).toBeNull());
    expect((screen.getByTestId("cp-data-agent-select") as HTMLSelectElement).value).toBe("");
    expect((screen.getByTestId("cp-data-root-select") as HTMLSelectElement).value).toBe("");
  });

  test("locks asset creation while the first request is pending", async () => {
    let resolveCreate: (() => void) | undefined;
    client.createCpAsset.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = () =>
            resolve({
              accessMode: "request",
              createdAt: "2026-08-12T00:00:00.000Z",
              description: null,
              id: "asset-a",
              kind: "scientific-dataset",
              lifecycle: "draft",
              name: "Dataset",
              ownerKind: "provider",
              ownerOrgId: "org-a",
              ownerUserId: null,
              providerOrgId: "org-a",
              sensitivity: "internal",
              tags: [],
              updatedAt: "2026-08-12T00:00:00.000Z",
              visibility: "organization",
            });
        }),
    );
    render(<CpDataPage />, { wrapper });
    fireEvent.change(screen.getByPlaceholderText("dataMarket.name"), {
      target: { value: "Dataset" },
    });
    const button = screen.getByRole("button", { name: "cp.data.create" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(client.createCpAsset).toHaveBeenCalledTimes(1);
    resolveCreate?.();
  });

  test("does not apply an asset mutation response after switching organization", async () => {
    const deferred = createDeferred<DataAssetSummary>();
    client.createCpAsset.mockImplementation(() => deferred.promise);
    const result = render(<CpDataPage />, { wrapper });
    fireEvent.change(screen.getByPlaceholderText("dataMarket.name"), {
      target: { value: "Dataset A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "cp.data.create" }));

    activeOrganization.current = "org-b";
    result.rerender(<CpDataPage />);
    deferred.resolve(asset("asset-a", "Dataset A", "org-a"));

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "cp.data.create" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(notifications.success).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("dataMarket.name") as HTMLInputElement).value).toBe(
      "Dataset A",
    );
  });

  test("does not show import success after switching organization while it is pending", async () => {
    client.cpAssets.mockResolvedValueOnce({
      assets: [asset("asset-a", "Dataset A", "org-a")],
      limit: 25,
      offset: 0,
      total: 1,
    });
    const deferred = createDeferred<{
      dataImport: DataAssetImport;
      dispatchState: "dispatched" | "queued";
      replayed: boolean;
      version: DataAssetVersion;
    }>();
    client.startCpImport.mockImplementation(() => deferred.promise);
    const result = render(<CpDataPage />, { wrapper });
    fireEvent.click(await screen.findByTestId("cp-data-asset-asset-a"));
    fireEvent.change(screen.getByTestId("cp-data-agent-select"), { target: { value: "agent-a" } });
    fireEvent.change(screen.getByTestId("cp-data-root-select"), {
      target: { value: "root-a" },
    });
    fireEvent.change(screen.getByPlaceholderText("cp.data.relativePath"), {
      target: { value: "inputs/a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "cp.data.import" }));

    activeOrganization.current = "org-b";
    result.rerender(<CpDataPage />);
    deferred.resolve({
      dataImport: importRecord(),
      dispatchState: "dispatched",
      replayed: false,
      version: versionRecord(),
    });

    await waitFor(() => expect(client.cpImports).toHaveBeenCalledTimes(2));
    expect(notifications.success).not.toHaveBeenCalled();
  });

  test.each([
    ["dispatched", "cp.data.importDispatched"],
    ["queued", "cp.data.importQueued"],
  ] as const)("reports an import as %s based on the dispatch result", async (dispatchState, toastKey) => {
    client.cpAssets.mockResolvedValueOnce({
      assets: [asset("asset-a", "Dataset A", "org-a")],
      limit: 25,
      offset: 0,
      total: 1,
    });
    client.startCpImport.mockResolvedValue({
      dataImport: importRecord(),
      dispatchState,
      replayed: false,
      version: versionRecord(),
    });

    render(<CpDataPage />, { wrapper });
    fireEvent.click(await screen.findByTestId("cp-data-asset-asset-a"));
    fireEvent.change(screen.getByTestId("cp-data-agent-select"), { target: { value: "agent-a" } });
    fireEvent.change(screen.getByTestId("cp-data-root-select"), {
      target: { value: "root-a" },
    });
    fireEvent.change(screen.getByPlaceholderText("cp.data.relativePath"), {
      target: { value: "inputs/a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "cp.data.import" }));

    await waitFor(() => expect(notifications.success).toHaveBeenCalledWith(toastKey));
  });

  test("reports a replayed failed import from its persisted terminal state", async () => {
    client.cpImports.mockResolvedValue({ imports: [], limit: 25, offset: 0, total: 0 });
    client.cpAssets.mockResolvedValueOnce({
      assets: [asset("asset-a", "Dataset A", "org-a")],
      limit: 25,
      offset: 0,
      total: 1,
    });
    client.startCpImport.mockResolvedValue({
      dataImport: importRecord("failed", "Agent scan failed"),
      dispatchState: "dispatched",
      replayed: true,
      version: versionRecord(),
    });

    render(<CpDataPage />, { wrapper });
    fireEvent.click(await screen.findByTestId("cp-data-asset-asset-a"));
    fireEvent.change(screen.getByTestId("cp-data-agent-select"), { target: { value: "agent-a" } });
    fireEvent.change(screen.getByTestId("cp-data-root-select"), {
      target: { value: "root-a" },
    });
    fireEvent.change(screen.getByPlaceholderText("cp.data.relativePath"), {
      target: { value: "inputs/a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "cp.data.import" }));

    await waitFor(() => expect(client.startCpImport).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(notifications.error).toHaveBeenCalledWith("cp.data.importFailed"));
    expect(notifications.error).not.toHaveBeenCalledWith("Agent scan failed");
    expect(notifications.success).not.toHaveBeenCalled();
  });

  test("polls active imports until completion and labels completed imports as available", async () => {
    vi.useFakeTimers();
    client.cpImports
      .mockReset()
      .mockResolvedValueOnce({ imports: [importRecord("pending")], limit: 25, offset: 0, total: 1 })
      .mockResolvedValueOnce({ imports: [importRecord("running")], limit: 25, offset: 0, total: 1 })
      .mockResolvedValueOnce({
        imports: [importRecord("completed")],
        limit: 25,
        offset: 0,
        total: 1,
      });

    render(<CpDataPage />, { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(client.cpImports).toHaveBeenCalledTimes(3);
    expect(screen.getByText("cp.data.importAvailable")).toBeTruthy();
  });

  test("labels failed imports without exposing scan details", async () => {
    client.cpImports.mockReset().mockResolvedValueOnce({
      imports: [importRecord("failed", "Agent could not read /data/research/inputs/a")],
      limit: 25,
      offset: 0,
      total: 1,
    });

    render(<CpDataPage />, { wrapper });

    expect((await screen.findAllByText("cp.data.importFailed")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Agent could not read /data/research/inputs/a")).toBeNull();
  });

  test("does not show review success after switching organization while it is pending", async () => {
    client.cpAccessRequests.mockResolvedValueOnce({
      limit: 25,
      offset: 0,
      requests: [accessRequest()],
      total: 1,
    });
    const deferred = createDeferred<{ request: DataAccessRequest }>();
    client.reviewCpAccessRequest.mockImplementation(() => deferred.promise);
    const result = render(<CpDataPage />, { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "cp.data.approve" }));

    activeOrganization.current = "org-b";
    result.rerender(<CpDataPage />);
    deferred.resolve({ request: accessRequest() });

    await waitFor(() => expect(client.cpAccessRequests).toHaveBeenCalledTimes(2));
    expect(notifications.success).not.toHaveBeenCalled();
  });

  test("refreshes the selected access-request detail after an approval", async () => {
    const pending = accessRequest();
    const approved = {
      ...pending,
      reviewedAt: "2026-08-12T01:00:00.000Z",
      status: "approved" as const,
    };
    client.cpAccessRequests.mockResolvedValue({
      limit: 25,
      offset: 0,
      requests: [pending],
      total: 1,
    });
    client.cpAccessRequest.mockResolvedValueOnce(pending).mockResolvedValueOnce(approved);
    client.reviewCpAccessRequest.mockResolvedValue({ request: approved });

    render(<CpDataPage />, { wrapper });
    fireEvent.click(await screen.findByText("view · pending"));
    await waitFor(() => expect(client.cpAccessRequest).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "cp.data.approve" }));

    await waitFor(() => expect(notifications.success).toHaveBeenCalledWith("cp.data.reviewed"));
    expect(client.cpAccessRequest).toHaveBeenCalledTimes(2);
  });
});

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function asset(id: string, name: string, providerOrgId: string): DataAssetSummary {
  return {
    accessMode: "request" as const,
    createdAt: "2026-08-12T00:00:00.000Z",
    description: null,
    id,
    kind: "scientific-dataset" as const,
    lifecycle: "draft" as const,
    name,
    ownerKind: "provider" as const,
    ownerOrgId: providerOrgId,
    ownerUserId: null,
    providerOrgId,
    sensitivity: "internal" as const,
    tags: [],
    updatedAt: "2026-08-12T00:00:00.000Z",
    visibility: "organization" as const,
  };
}

function versionRecord(): DataAssetVersion {
  return {
    assetId: "asset-a",
    createdAt: "2026-08-12T00:00:00.000Z",
    createdBy: "user-a",
    id: "version-a",
    immutableAt: null,
    manifest: {},
    manifestDigest: null,
    status: "draft" as const,
    version: "v1",
  };
}

function importRecord(
  status: DataAssetImport["status"] = "pending",
  errorMessage: string | null = null,
): DataAssetImport {
  return {
    agentId: "agent-a",
    assetId: "asset-a",
    completedAt: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    errorMessage,
    id: "import-a",
    managedRootId: "root-a",
    relativePath: "inputs/a",
    sourceKind: "cp-local" as const,
    status,
    version: "v1",
  };
}

function accessRequest(): DataAccessRequest {
  return {
    assetId: "asset-a",
    capability: "view" as const,
    createdAt: "2026-08-12T00:00:00.000Z",
    decisionReason: null,
    expiresAt: null,
    id: "request-a",
    reason: null,
    requesterOrgId: null,
    requesterUserId: "user-a",
    reviewedAt: null,
    reviewedBy: null,
    status: "pending" as const,
    subjectId: "user-a",
    subjectKind: "user" as const,
  };
}
