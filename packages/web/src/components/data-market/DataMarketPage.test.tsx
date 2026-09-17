import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DataMarketPage } from "./DataMarketPage";

const {
  catalog,
  createPrivateAsset,
  myAccessRequests,
  requestAccess,
  requestOwnerEntitlement,
  uploadAssetFile,
} = vi.hoisted(() => ({
  catalog: vi.fn(),
  createPrivateAsset: vi.fn(),
  myAccessRequests: vi.fn(),
  requestAccess: vi.fn(),
  requestOwnerEntitlement: vi.fn(),
  uploadAssetFile: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      key === "dataMarket.requestStatus" ? `${key}:${values?.status}` : key,
  }),
}));

vi.mock("../../lib/data-market-client", () => ({
  dataMarketClient: {
    catalog,
    createPrivateAsset,
    myAccessRequests,
    requestAccess,
    requestOwnerEntitlement,
    uploadAssetFile,
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  myAccessRequests.mockResolvedValue({
    activeUseAssetIds: [],
    requests: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DataMarketPage", () => {
  test("does not present a detached data-source selection action", async () => {
    catalog.mockResolvedValue({ assets: [], limit: 25, offset: 0, total: 0 });

    render(<DataMarketPage />, { wrapper });

    expect(await screen.findByText("dataMarket.empty")).toBeTruthy();
    expect(screen.queryByTestId("data-source-picker")).toBeNull();
    expect(screen.queryByText("dataMarket.picker.title")).toBeNull();
  });

  test("shows an asset detail and persists the returned access-request status", async () => {
    catalog.mockResolvedValue({
      assets: [
        {
          createdAt: "2026-07-24T00:00:00.000Z",
          description: "受控数据集",
          id: "asset-1",
          name: "测试数据",
          ownerUserId: "user-1",
          providerOrgId: "org-1",
          status: "published",
          tags: [],
          updatedAt: "2026-07-24T00:00:00.000Z",
          visibility: "organization",
        },
      ],
      limit: 25,
      offset: 0,
      total: 1,
    });
    requestAccess.mockResolvedValue({
      assetId: "asset-1",
      createdAt: "2026-07-24T00:00:00.000Z",
      id: "request-1",
      reason: null,
      requesterOrgId: "org-2",
      requesterUserId: "user-2",
      reviewedAt: null,
      reviewedBy: null,
      status: "pending",
    });
    myAccessRequests
      .mockResolvedValueOnce({ activeUseAssetIds: [], requests: [] })
      .mockResolvedValueOnce({
        activeUseAssetIds: [],
        requests: [{ assetId: "asset-1", id: "request-1", status: "pending" }],
      });

    render(<DataMarketPage />, { wrapper });

    fireEvent.click(await screen.findByTestId("data-asset-asset-1"));
    fireEvent.click(screen.getByText("dataMarket.requestAccess"));

    expect((await screen.findByTestId("data-access-request-status")).textContent).toBe(
      "dataMarket.requestStatus:pending",
    );
    expect(requestAccess).toHaveBeenCalledWith("asset-1", null);
  });

  test("creates a private POTCAR as licensed material with its element set", async () => {
    catalog.mockResolvedValue({ assets: [], limit: 25, offset: 0, total: 0 });
    createPrivateAsset.mockResolvedValue({ id: "asset-potcar" });
    uploadAssetFile.mockResolvedValue({ id: "version-potcar" });
    render(<DataMarketPage />, { wrapper });

    fireEvent.change(await screen.findByPlaceholderText("dataMarket.name"), {
      target: { value: "My POTCAR" },
    });
    fireEvent.change(screen.getByLabelText("dataMarket.privateKind"), {
      target: { value: "licensed-material" },
    });
    fireEvent.change(screen.getByLabelText("dataMarket.elements"), {
      target: { value: "si, O" },
    });
    fireEvent.change(screen.getByLabelText("dataMarket.privateFile"), {
      target: { files: [new File(["POTCAR"], "POTCAR")] },
    });
    fireEvent.click(screen.getByText("dataMarket.privateUpload"));

    await vi.waitFor(() => {
      expect(createPrivateAsset).toHaveBeenCalledWith({
        name: "My POTCAR",
        kind: "licensed-material",
        accessMode: "entitlement",
        sensitivity: "restricted",
        elements: ["si", "O"],
      });
    });
  });

  test("shows owner access for an ordinary private asset without a failing request action", async () => {
    catalog.mockResolvedValue({
      assets: [
        {
          accessMode: "request",
          createdAt: "2026-08-07T00:00:00.000Z",
          id: "asset-private",
          kind: "scientific-dataset",
          lifecycle: "draft",
          name: "Private dataset",
          visibility: "private",
        },
      ],
      limit: 25,
      offset: 0,
      total: 1,
    });
    render(<DataMarketPage />, { wrapper });

    fireEvent.click(await screen.findByTestId("data-asset-asset-private"));

    expect(screen.getByTestId("data-private-owner-access")).toBeTruthy();
    expect(screen.queryByText("dataMarket.requestAccess")).toBeNull();
  });

  test("submits a private licensed-material owner entitlement with an explicit reason", async () => {
    catalog.mockResolvedValue({
      assets: [
        {
          accessMode: "entitlement",
          createdAt: "2026-08-07T00:00:00.000Z",
          id: "asset-licensed",
          kind: "licensed-material",
          lifecycle: "draft",
          name: "Private licensed material",
          visibility: "private",
        },
      ],
      limit: 25,
      offset: 0,
      total: 1,
    });
    requestOwnerEntitlement.mockResolvedValue({
      assetId: "asset-licensed",
      id: "request-owner-1",
      status: "pending",
    });
    myAccessRequests
      .mockResolvedValueOnce({ activeUseAssetIds: [], requests: [] })
      .mockResolvedValueOnce({
        activeUseAssetIds: [],
        requests: [{ assetId: "asset-licensed", id: "request-owner-1", status: "pending" }],
      });
    render(<DataMarketPage />, { wrapper });

    fireEvent.click(await screen.findByTestId("data-asset-asset-licensed"));
    fireEvent.change(screen.getByLabelText("dataMarket.ownerEntitlementReason"), {
      target: { value: "Approved research license" },
    });
    fireEvent.click(screen.getByText("dataMarket.requestOwnerEntitlement"));

    await vi.waitFor(() => {
      expect(requestOwnerEntitlement).toHaveBeenCalledWith(
        "asset-licensed",
        "Approved research license",
      );
    });
    expect((await screen.findByTestId("data-access-request-status")).textContent).toContain(
      "pending",
    );
  });

  test("restores active owner entitlement state after a page reload", async () => {
    catalog.mockResolvedValue({
      assets: [
        {
          accessMode: "entitlement",
          createdAt: "2026-08-07T00:00:00.000Z",
          id: "asset-licensed",
          kind: "licensed-material",
          lifecycle: "draft",
          name: "Private licensed material",
          visibility: "private",
        },
      ],
      limit: 25,
      offset: 0,
      total: 1,
    });
    myAccessRequests.mockResolvedValue({
      activeUseAssetIds: ["asset-licensed"],
      requests: [{ assetId: "asset-licensed", id: "request-owner-1", status: "approved" }],
    });
    render(<DataMarketPage />, { wrapper });

    fireEvent.click(await screen.findByTestId("data-asset-asset-licensed"));

    expect((await screen.findByTestId("data-access-request-status")).textContent).toContain(
      "active",
    );
    expect(screen.queryByText("dataMarket.requestOwnerEntitlement")).toBeNull();
  });

  test("shows revoked owner entitlement as inactive and allows a new request", async () => {
    catalog.mockResolvedValue({
      assets: [
        {
          accessMode: "entitlement",
          createdAt: "2026-08-07T00:00:00.000Z",
          id: "asset-licensed",
          kind: "licensed-material",
          lifecycle: "draft",
          name: "Private licensed material",
          visibility: "private",
        },
      ],
      limit: 25,
      offset: 0,
      total: 1,
    });
    myAccessRequests.mockResolvedValue({
      activeUseAssetIds: [],
      requests: [{ assetId: "asset-licensed", id: "request-owner-1", status: "approved" }],
    });
    render(<DataMarketPage />, { wrapper });

    fireEvent.click(await screen.findByTestId("data-asset-asset-licensed"));

    expect((await screen.findByTestId("data-access-request-status")).textContent).toContain(
      "inactive",
    );
    expect(screen.getByText("dataMarket.requestOwnerEntitlement")).toBeTruthy();
  });

  test("keeps request actions closed while durable access state is loading", async () => {
    catalog.mockResolvedValue({
      assets: [
        {
          accessMode: "request",
          id: "asset-request",
          kind: "scientific-dataset",
          lifecycle: "published",
          name: "Request data",
          visibility: "organization",
        },
      ],
      limit: 25,
      offset: 0,
      total: 1,
    });
    myAccessRequests.mockReturnValue(new Promise(() => undefined));
    render(<DataMarketPage />, { wrapper });

    fireEvent.click(await screen.findByTestId("data-asset-asset-request"));

    expect(screen.getByTestId("data-access-state-unavailable").textContent).toBe(
      "dataMarket.accessStateLoading",
    );
    expect(screen.queryByText("dataMarket.requestAccess")).toBeNull();
  });

  test("keeps request actions closed when durable access state fails", async () => {
    catalog.mockResolvedValue({
      assets: [
        {
          accessMode: "request",
          id: "asset-request",
          kind: "scientific-dataset",
          lifecycle: "published",
          name: "Request data",
          visibility: "organization",
        },
      ],
      limit: 25,
      offset: 0,
      total: 1,
    });
    myAccessRequests.mockRejectedValue(new Error("access state unavailable"));
    render(<DataMarketPage />, { wrapper });

    fireEvent.click(await screen.findByTestId("data-asset-asset-request"));

    expect((await screen.findByTestId("data-access-state-unavailable")).textContent).toBe(
      "dataMarket.accessStateUnavailable",
    );
    expect(screen.queryByText("dataMarket.requestAccess")).toBeNull();
  });

  test.each([
    "rejected",
    "approved",
  ])("allows an ordinary request asset to be requested again after %s without active use", async (status) => {
    catalog.mockResolvedValue({
      assets: [
        {
          accessMode: "request",
          id: "asset-request",
          kind: "scientific-dataset",
          lifecycle: "published",
          name: "Request data",
          visibility: "organization",
        },
      ],
      limit: 25,
      offset: 0,
      total: 1,
    });
    myAccessRequests.mockResolvedValue({
      activeUseAssetIds: [],
      requests: [{ assetId: "asset-request", id: "request-1", status }],
    });
    render(<DataMarketPage />, { wrapper });

    fireEvent.click(await screen.findByTestId("data-asset-asset-request"));

    expect(await screen.findByText("dataMarket.requestAccess")).toBeTruthy();
  });
});
