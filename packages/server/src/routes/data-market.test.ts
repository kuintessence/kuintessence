import { describe, expect, test } from "bun:test";
import { AppError } from "@kuintessence/shared";
import { Hono } from "hono";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { DataAsset, DataMarketService } from "../services/data-market";
import { createDataMarketRoutes } from "./data-market";

const principal = {
  userId: "user-1",
  role: "user",
  orgId: "org-1",
  orgIds: ["org-1"],
} as BoundPrincipal;

const privateAsset: DataAsset = {
  id: "asset-1",
  providerOrgId: null,
  ownerUserId: "user-1",
  ownerOrgId: null,
  ownerKind: "user",
  kind: "scientific-dataset",
  name: "private",
  description: null,
  visibility: "private",
  lifecycle: "draft",
  accessMode: "request",
  sensitivity: "internal",
  tags: [],
  elements: [],
  createdAt: new Date("2026-07-24T00:00:00.000Z"),
  updatedAt: new Date("2026-07-24T00:00:00.000Z"),
};

function appWith(service: Partial<DataMarketService>) {
  const app = new Hono<{ Variables: { principal: BoundPrincipal } }>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  app.onError((error, c) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    return c.json({ message: error.message }, status as 400 | 500);
  });
  app.route("/api", createDataMarketRoutes({ service: service as DataMarketService }));
  return app;
}

describe("Data Market routes", () => {
  test("returns the current user's access requests and active use assets", async () => {
    const response = await appWith({
      getMyAccessState: async () => ({
        requests: [],
        activeUseAssetIds: ["asset-1"],
      }),
    }).request(
      "/api/data-market/access-requests/mine?assetIds=00000000-0000-4000-8000-000000000001",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { activeUseAssetIds: ["asset-1"] },
    });
  });

  test("rejects unknown fields at the strict Zod upload boundary", async () => {
    const app = appWith({});
    const response = await app.request("/api/data-market/private/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "asset-1" },
      body: JSON.stringify({
        name: "private",
        visibility: "private",
        tags: [],
        untrusted: true,
      }),
    });
    expect(response.status).toBe(400);
  });

  test("requires an idempotency key for a private upload metadata mutation", async () => {
    const app = appWith({
      createPrivateAsset: async () => privateAsset,
    });
    const response = await app.request("/api/data-market/private/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "private", visibility: "private", tags: [] }),
    });
    expect(response.status).toBe(400);
  });

  test("rejects legacy CP data mutations before they reach the service", async () => {
    let assetCalls = 0;
    let replicaCalls = 0;
    const app = appWith({
      createProviderAsset: async () => {
        assetCalls += 1;
        return privateAsset;
      },
      createReplica: async () => {
        replicaCalls += 1;
        throw new Error("should not be called");
      },
    });
    const assetResponse = await app.request("/api/data-market/cp/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "legacy-asset" },
      body: JSON.stringify({ name: "legacy", visibility: "organization", tags: [] }),
    });
    const replicaResponse = await app.request("/api/data-market/cp/versions/version-1/replicas", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "legacy-replica" },
      body: JSON.stringify({
        agentId: "agent-1",
        siteId: "site-1",
        clusterId: "cluster-1",
        locationKind: "cp-local",
      }),
    });

    expect(assetResponse.status).toBe(409);
    expect(replicaResponse.status).toBe(409);
    expect(assetCalls).toBe(0);
    expect(replicaCalls).toBe(0);
  });

  test("returns the service-created private asset without accepting byte payloads", async () => {
    const app = appWith({
      createPrivateAsset: async () => privateAsset,
    });
    const response = await app.request("/api/data-market/private/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "asset-1" },
      body: JSON.stringify({ name: "private", visibility: "private", tags: [] }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: "asset-1", visibility: "private" },
    });
  });

  test("normalizes licensed-material element symbols before the service boundary", async () => {
    const received: unknown[] = [];
    const app = appWith({
      createPrivateAsset: async (_actor, input) => {
        received.push(input);
        return { ...privateAsset, kind: "licensed-material", elements: ["Si", "O"] };
      },
    });
    const response = await app.request("/api/data-market/private/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "asset-elements" },
      body: JSON.stringify({
        name: "POTCAR",
        kind: "licensed-material",
        visibility: "public",
        accessMode: "open",
        sensitivity: "open",
        tags: [],
        elements: ["si", "O", "SI"],
      }),
    });
    expect(response.status).toBe(201);
    expect(received).toEqual([
      expect.objectContaining({ elements: ["Si", "O"], accessMode: "open", sensitivity: "open" }),
    ]);
  });

  test("commits only a strict persisted upload session reference", async () => {
    const commits: unknown[] = [];
    const app = appWith({
      commitUploadSession: async (_actor, sessionId, sha256) => {
        commits.push({ sessionId, sha256 });
        return {
          id: "version-1",
          assetId: "asset-1",
          version: "v1",
          status: "ready",
        } as Awaited<ReturnType<DataMarketService["commitUploadSession"]>>;
      },
    });
    const valid = await app.request("/api/data-market/upload-sessions/session-1/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256: "a".repeat(64) }),
    });
    const invalid = await app.request("/api/data-market/upload-sessions/session-1/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha256: "a".repeat(64), storageKey: "untrusted" }),
    });

    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(commits).toEqual([{ sessionId: "session-1", sha256: "a".repeat(64) }]);
  });

  test("accepts only strict owner-entitlement requests with an idempotency key", async () => {
    const requests: unknown[] = [];
    const app = appWith({
      requestOwnerEntitlement: async (_actor, assetId, reason, idempotencyKey) => {
        requests.push({ assetId, reason, idempotencyKey });
        return { id: "request-1" } as Awaited<
          ReturnType<DataMarketService["requestOwnerEntitlement"]>
        >;
      },
    });
    const valid = await app.request(
      "/api/data-market/private/assets/asset-1/owner-entitlement-requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "owner-entitlement" },
        body: JSON.stringify({ reason: "License agreement accepted" }),
      },
    );
    const invalid = await app.request(
      "/api/data-market/private/assets/asset-1/owner-entitlement-requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "owner-entitlement-2" },
        body: JSON.stringify({ reason: "License agreement accepted", extra: true }),
      },
    );
    expect(valid.status).toBe(201);
    expect(invalid.status).toBe(400);
    expect(requests).toEqual([
      {
        assetId: "asset-1",
        reason: "License agreement accepted",
        idempotencyKey: "owner-entitlement",
      },
    ]);
  });
});
