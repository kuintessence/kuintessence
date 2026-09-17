import { afterEach, describe, expect, test, vi } from "vitest";
import { dataMarketClient } from "./data-market-client";

afterEach(() => vi.restoreAllMocks());

describe("dataMarketClient", () => {
  test("loads the catalog through the Server route", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ success: true, data: { assets: [], limit: 25, offset: 0, total: 0 } }),
            { status: 200 },
          ),
        ),
    );
    await expect(dataMarketClient.catalog()).resolves.toMatchObject({ total: 0 });
    expect(fetch).toHaveBeenCalledWith(
      "/platform/api/data-market/catalog",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  test("sends licensed-material element metadata with private asset creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true, data: { id: "asset-1" } }), { status: 201 }),
        ),
    );
    await dataMarketClient.createPrivateAsset({
      name: "POTCAR",
      kind: "licensed-material",
      elements: ["Si", "O"],
    });
    expect(fetch).toHaveBeenCalledWith(
      "/platform/api/data-market/private/assets",
      expect.objectContaining({
        body: expect.stringContaining('"elements":["Si","O"]'),
      }),
    );
  });

  test("binds CP Data writes to the selected active organization", async () => {
    localStorage.setItem("kq_active_organization_id", "org-a");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true, data: { id: "asset-1" } }), { status: 201 }),
        ),
    );

    await dataMarketClient.createCpAsset({ name: "Dataset", visibility: "organization" });

    expect(fetch).toHaveBeenCalledWith(
      "/platform/api/cp/data/assets",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-KQ-Active-Organization": "org-a" }),
      }),
    );
  });

  test("uses the scoped CP route for replica creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { id: "replica-1" } }), {
          status: 201,
        }),
      ),
    );

    await dataMarketClient.createReplica("version-1", {
      agentId: "agent-1",
      clusterId: "cluster-1",
      locationKind: "cp-local",
      siteId: "site-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/platform/api/cp/data/versions/version-1/replicas",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("submits a private owner entitlement through its dedicated route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { id: "request-1" } }), {
          status: 201,
        }),
      ),
    );

    await dataMarketClient.requestOwnerEntitlement("asset-1", "Approved research license");

    expect(fetch).toHaveBeenCalledWith(
      "/platform/api/data-market/private/assets/asset-1/owner-entitlement-requests",
      expect.objectContaining({
        body: JSON.stringify({ reason: "Approved research license" }),
        method: "POST",
      }),
    );
  });

  test("loads durable access and entitlement state for the current user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { activeUseAssetIds: ["asset-1"], requests: [], total: 0 },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      dataMarketClient.myAccessRequests(["00000000-0000-4000-8000-000000000001"]),
    ).resolves.toMatchObject({
      activeUseAssetIds: ["asset-1"],
    });
    expect(fetch).toHaveBeenCalledWith(
      "/platform/api/data-market/access-requests/mine?assetIds=00000000-0000-4000-8000-000000000001",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  test("preserves structured API diagnostics without exposing them in the client contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: "Authorization denied",
              details: { reason: "RBAC" },
            },
          }),
          { status: 403 },
        ),
      ),
    );

    await expect(dataMarketClient.asset("asset-1")).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Authorization denied",
      details: { reason: "RBAC" },
    });
  });

  test("persists a private or platform object through session, PUT, and SHA-256 commit", async () => {
    const sha256 = "a".repeat(64);
    vi.stubGlobal("crypto", {
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).fill(170).buffer) },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                assetId: "asset-1",
                expiresAt: "2026-07-24T01:00:00.000Z",
                id: "session-1",
                locationKind: "user-private-object",
                objectKey: "private/object",
                uploadUrl: "https://storage.example/upload",
                version: "v1",
              },
            }),
            { status: 201 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ success: true, data: { id: "version-1", status: "ready" } }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      dataMarketClient.uploadAssetFile("asset-1", "v1", new File(["data"], "input.csv")),
    ).resolves.toMatchObject({ id: "version-1" });

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://storage.example/upload",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetch).toHaveBeenLastCalledWith(
      "/platform/api/data-market/upload-sessions/session-1/commit",
      expect.objectContaining({ body: JSON.stringify({ sha256 }) }),
    );
  });
});
