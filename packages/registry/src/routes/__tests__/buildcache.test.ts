// Spack buildcache route tests.
//
// Same harness as the OCI tests: real Postgres, in-memory blob store,
// no-op + Drizzle audit. Exercises the namespace + RBAC matrix and
// the put → index → fetch round trip.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, type PgDb, spackPackage } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../../middleware/error-handler";
import { createPrincipalMiddleware } from "../../middleware/principal";
import { InMemoryBlobStore } from "../../services/blob-store";
import { DrizzleAuditPort, RegistryService } from "../../services/registry-service";
import { createBuildcacheRoutes } from "../buildcache";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

const ROLE_UUID: Record<string, string> = {
  super_admin: "00000000-0000-0000-0000-000000000001",
  platform_admin: "00000000-0000-0000-0000-000000000002",
  org_admin: "00000000-0000-0000-0000-000000000003",
  user: "00000000-0000-0000-0000-000000000004",
};

function principal(role: keyof typeof ROLE_UUID, orgIds: string[] = []) {
  return JSON.stringify({ sub: ROLE_UUID[role], role, orgIds });
}

const TEST_HASH = `bctesthash${"1".repeat(22)}`; // 32 hex-ish chars

describe("Spack buildcache routes", () => {
  let db: PgDb;
  let app: Hono;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    const service = new RegistryService(db, new InMemoryBlobStore(), new DrizzleAuditPort(db));
    app = new Hono();
    app.onError(createErrorHandler(testLogger));
    const bc = new Hono();
    bc.use("*", createPrincipalMiddleware({ allowTestHeader: true }));
    bc.route("/", createBuildcacheRoutes({ service }));
    app.route("/buildcache", bc);
    app.route("/buildcache/", bc);
  });

  afterAll(async () => {
    await db.delete(spackPackage).where(eq(spackPackage.hash, TEST_HASH));
  });

  test("GET /buildcache/<ns>/index.json on unknown ns is empty array", async () => {
    const res = await app.request("/buildcache/public/bctest-empty/index.json", {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  test("PUT then GET round-trip: put .spack tarball, list index, fetch back", async () => {
    const repoPath = "public/bctest-roundtrip";
    const tar = new TextEncoder().encode("fake-tar-bytes");
    const filename = `gromacs-${TEST_HASH}.spack`;
    const put = await app.request(
      `/buildcache/${repoPath}/build_cache/${filename}?arch=linux-x86_64&spec=${encodeURIComponent("gromacs@2024.1")}`,
      {
        method: "PUT",
        headers: { "X-Test-Principal": principal("platform_admin") },
        body: tar,
      },
    );
    expect(put.status).toBe(201);
    const entry = (await put.json()) as { hash: string; arch: string; sizeBytes: number };
    expect(entry.hash).toBe(TEST_HASH);
    expect(entry.arch).toBe("linux-x86_64");
    expect(entry.sizeBytes).toBe(tar.byteLength);

    const idx = await app.request(`/buildcache/${repoPath}/index.json`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(idx.status).toBe(200);
    const body = (await idx.json()) as { entries: Array<{ hash: string }> };
    expect(body.entries.some((e) => e.hash === TEST_HASH)).toBe(true);

    const get = await app.request(`/buildcache/${repoPath}/build_cache/${filename}`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(get.status).toBe(200);
    const fetched = new Uint8Array(await get.arrayBuffer());
    expect(fetched).toEqual(tar);

    const wrongPackage = await app.request(
      `/buildcache/${repoPath}/build_cache/not-gromacs-${TEST_HASH}.spack`,
      {
        method: "DELETE",
        headers: { "X-Test-Principal": principal("platform_admin") },
      },
    );
    expect(wrongPackage.status).toBe(404);

    const deleted = await app.request(`/buildcache/${repoPath}/build_cache/${filename}`, {
      method: "DELETE",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(deleted.status).toBe(204);

    const afterDelete = await app.request(`/buildcache/${repoPath}/build_cache/${filename}`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(afterDelete.status).toBe(404);

    const indexAfterDelete = await app.request(`/buildcache/${repoPath}/index.json`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    const emptyIndex = (await indexAfterDelete.json()) as { entries: unknown[] };
    expect(emptyIndex.entries).toHaveLength(0);
  });

  test("PUT denied for regular user on public namespace", async () => {
    const filename = `gromacs-${TEST_HASH}.spack`;
    const res = await app.request(`/buildcache/public/bctest-denied/build_cache/${filename}`, {
      method: "PUT",
      headers: { "X-Test-Principal": principal("user") },
      body: new TextEncoder().encode("noop"),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("DENIED");
  });

  test("invalid namespace returns 400 NAME_INVALID", async () => {
    const res = await app.request("/buildcache/system/wat/index.json", {
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("NAME_INVALID");
  });

  test("malformed buildcache filename returns 400", async () => {
    const res = await app.request("/buildcache/public/bctest-roundtrip/build_cache/garbage.txt", {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("MANIFEST_INVALID");
  });

  test("PUT spec.json is rejected (only .spack accepted on write)", async () => {
    const filename = `gromacs-${TEST_HASH}.spec.json`;
    const res = await app.request(`/buildcache/public/bctest-specjson/build_cache/${filename}`, {
      method: "PUT",
      headers: { "X-Test-Principal": principal("platform_admin") },
      body: new TextEncoder().encode("{}"),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("MANIFEST_INVALID");
  });

  test("PUT rejects a filename package that does not match the spec", async () => {
    const filename = `gromacs-${TEST_HASH}.spack`;
    const res = await app.request(
      `/buildcache/public/bctest-mismatch/build_cache/${filename}?spec=${encodeURIComponent("lammps@1.0")}`,
      {
        method: "PUT",
        headers: { "X-Test-Principal": principal("platform_admin") },
        body: new TextEncoder().encode("noop"),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("MANIFEST_INVALID");
  });

  test("missing principal returns 401 envelope", async () => {
    const res = await app.request("/buildcache/public/bctest-roundtrip/index.json");
    expect(res.status).toBe(401);
  });
});
