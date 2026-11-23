import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgDb, type PgDb, spackPackage } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../../middleware/error-handler";
import { createPrincipalMiddleware } from "../../middleware/principal";
import { FilesystemBlobStore } from "../../services/blob-store";
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

  let peer: Hono;
  let peerDb: PgDb;
  let root: string;
  function routes(pool: PgDb) {
    const service = new RegistryService(
      pool,
      new FilesystemBlobStore(root),
      new DrizzleAuditPort(pool),
    );
    const app = new Hono();
    app.onError(createErrorHandler(testLogger));
    const bc = new Hono();
    bc.use("*", createPrincipalMiddleware({ allowTestHeader: true }));
    bc.route("/", createBuildcacheRoutes({ service }));
    app.route("/buildcache", bc);
    app.route("/buildcache/", bc);
    return app;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "kq-buildcache-"));
    db = createPgDb(TEST_DB_URL);
    peerDb = createPgDb(TEST_DB_URL);
    app = routes(db);
    peer = routes(peerDb);
  });

  afterAll(async () => {
    await db.delete(spackPackage).where(eq(spackPackage.hash, TEST_HASH));
    await Promise.all([
      db.$client.end(),
      peerDb.$client.end(),
      rm(root, { recursive: true, force: true }),
    ]);
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

    const specPath = `/buildcache/${repoPath}/build_cache/gromacs-${TEST_HASH}.spec.json`;
    const read = { headers: { "X-Test-Principal": principal("user") } };
    expect((await app.request(specPath, read)).status).toBe(404);
    const metadata = JSON.stringify({
      spec: { nodes: [{ name: "gromacs", hash: TEST_HASH }] },
      binary_cache_checksum: {
        hash_algorithm: "sha256",
        hash: new Bun.CryptoHasher("sha256").update(tar).digest("hex"),
      },
    });
    const attach = {
      method: "PUT",
      headers: { "X-Test-Principal": principal("platform_admin") },
      body: metadata,
    };
    expect((await app.request(specPath.replace(repoPath, "public/other"), attach)).status).toBe(
      409,
    );
    expect((await app.request(specPath, attach)).status).toBe(201);
    expect(await (await app.request(specPath, read)).text()).toBe(metadata);

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

  test("concurrent rewrites and deletion retain the winning binary and shared references", async () => {
    const root = "/buildcache/public/bc-concurrent/build_cache";
    const shared = "/buildcache/public/bc-neighbor/build_cache";
    const path = (base: string) => base + "/hello-" + TEST_HASH + ".spack";
    const headers = { "X-Test-Principal": principal("platform_admin") };
    const put = (base: string, body: string, writer = app) =>
      writer.request(path(base) + "?arch=linux&spec=hello", { method: "PUT", headers, body });
    const get = (base: string) => app.request(path(base), { headers });
    const initial = await Promise.all([put(root, "A"), put(root, "A", peer), put(shared, "A")]);
    expect(initial.map((r) => r.status)).toEqual([201, 201, 201]);
    const [removed, updated] = await Promise.all([
      app.request(path(root), { method: "DELETE", headers }),
      put(root, "B", peer),
    ]);
    expect([removed.status, updated.status]).toEqual([204, 201]);
    const selected = await get(root);
    if (selected.status === 200) expect(await selected.text()).toBe("B");
    else expect(selected.status).toBe(404);
    expect(await (await get(shared)).text()).toBe("A");
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

  test("PUT rejects invalid native metadata", async () => {
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
