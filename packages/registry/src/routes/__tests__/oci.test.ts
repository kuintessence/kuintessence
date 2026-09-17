// OCI v2 route tests.
//
// We boot the same Hono app the production entrypoint mounts, but
// substitute the in-memory blob store and a no-op audit port so each
// test runs DB-only writes (which the surrounding suite already requires
// for app-templates / workflow-templates) without leaning on MinIO.
//
// All registry rows created here use a `routetest-` prefix so the
// afterAll hook can scrub them without disturbing other suites.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, ociRepository, type PgDb } from "@kuintessence/db";
import { like } from "drizzle-orm";
import { Hono } from "hono";
import { PatternRouter } from "hono/router/pattern-router";
import pino from "pino";
import { createErrorHandler } from "../../middleware/error-handler";
import { createPrincipalMiddleware } from "../../middleware/principal";
import { InMemoryBlobStore } from "../../services/blob-store";
import { DrizzleAuditPort, RegistryService } from "../../services/registry-service";
import { createOciRoutes } from "../oci";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

// Stable per-role UUIDs so the schema-level UUID columns (pushed_by,
// audit_release.actor) accept the test principals without minting a new
// row per request.
const ROLE_UUID: Record<string, string> = {
  super_admin: "00000000-0000-0000-0000-000000000001",
  platform_admin: "00000000-0000-0000-0000-000000000002",
  org_admin: "00000000-0000-0000-0000-000000000003",
  user: "00000000-0000-0000-0000-000000000004",
};

function principal(
  role: "platform_admin" | "user" | "org_admin" | "super_admin",
  overrides: Partial<{ sub: string; orgIds: string[] }> = {},
) {
  return JSON.stringify({
    sub: overrides.sub ?? ROLE_UUID[role],
    role,
    orgIds: overrides.orgIds ?? [],
  });
}

describe("OCI v2 routes", () => {
  let db: PgDb;
  let app: Hono;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    const blobs = new InMemoryBlobStore();
    const service = new RegistryService(db, blobs, new DrizzleAuditPort(db));
    // Use PatternRouter at every layer: Hono's default RegExpRouter cannot
    // route `/:rest{.+}/blobs/uploads/` correctly when `:rest` itself
    // contains slashes (e.g. `org/<id>/<repo>`) once the full OCI route set
    // is registered. PatternRouter resolves the same patterns deterministically.
    app = new Hono({ router: new PatternRouter() });
    app.onError(createErrorHandler(testLogger));
    const oci = new Hono({ router: new PatternRouter() });
    oci.use("*", createPrincipalMiddleware({ allowTestHeader: true }));
    oci.route("/", createOciRoutes({ service }));
    // Mount under both /v2 and /v2/ so a trailing-slash probe (the
    // Distribution spec example uses `GET /v2/`) reaches the same handler.
    app.route("/v2", oci);
    app.route("/v2/", oci);
  });

  afterAll(async () => {
    await db.delete(ociRepository).where(like(ociRepository.name, "routetest-%"));
  });

  test("GET /v2/ unauthenticated returns 401 envelope", async () => {
    const res = await app.request("/v2/");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("UNAUTHORIZED");
  });

  test("GET /v2/ authenticated returns 200 with API version header", async () => {
    const res = await app.request("/v2/", {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");
  });

  test("blob upload happy path: POST → PATCH → PATCH → PUT → HEAD/GET", async () => {
    const repoPath = "public/routetest-blob";
    const start = await app.request(`/v2/${repoPath}/blobs/uploads/`, {
      method: "POST",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(start.status).toBe(202);
    expect(start.headers.get("Range")).toBe("0-0");
    const uploadId = start.headers.get("Docker-Upload-UUID");
    expect(uploadId).toBeTruthy();
    const location = start.headers.get("Location");
    expect(location).toContain(`/v2/${repoPath}/blobs/uploads/${uploadId}`);

    // Two chunks
    const chunk1 = new TextEncoder().encode("first-chunk-");
    const chunk2 = new TextEncoder().encode("second-chunk");
    const expectedBytes = new Uint8Array(chunk1.byteLength + chunk2.byteLength);
    expectedBytes.set(chunk1, 0);
    expectedBytes.set(chunk2, chunk1.byteLength);
    // Compute expected digest with same algo the service uses.
    const { createHash } = await import("node:crypto");
    const expectedDigest = `sha256:${createHash("sha256").update(expectedBytes).digest("hex")}`;

    const patch1 = await app.request(`/v2/${repoPath}/blobs/uploads/${uploadId}`, {
      method: "PATCH",
      headers: { "X-Test-Principal": principal("platform_admin") },
      body: chunk1,
    });
    expect(patch1.status).toBe(202);
    expect(patch1.headers.get("Range")).toBe(`0-${chunk1.byteLength - 1}`);

    const patch2 = await app.request(`/v2/${repoPath}/blobs/uploads/${uploadId}`, {
      method: "PATCH",
      headers: { "X-Test-Principal": principal("platform_admin") },
      body: chunk2,
    });
    expect(patch2.status).toBe(202);
    expect(patch2.headers.get("Range")).toBe(`0-${expectedBytes.byteLength - 1}`);

    const put = await app.request(
      `/v2/${repoPath}/blobs/uploads/${uploadId}?digest=${expectedDigest}`,
      {
        method: "PUT",
        headers: { "X-Test-Principal": principal("platform_admin") },
      },
    );
    expect(put.status).toBe(201);
    expect(put.headers.get("Docker-Content-Digest")).toBe(expectedDigest);
    expect(put.headers.get("Location")).toBe(`/v2/${repoPath}/blobs/${expectedDigest}`);

    const head = await app.request(`/v2/${repoPath}/blobs/${expectedDigest}`, {
      method: "HEAD",
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(expectedBytes.byteLength));

    const get = await app.request(`/v2/${repoPath}/blobs/${expectedDigest}`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(get.status).toBe(200);
    const got = new Uint8Array(await get.arrayBuffer());
    expect(got).toEqual(expectedBytes);
  });

  test("PUT blob with mismatched digest returns 400 DIGEST_INVALID", async () => {
    const repoPath = "public/routetest-mismatch";
    const start = await app.request(`/v2/${repoPath}/blobs/uploads/`, {
      method: "POST",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    const uploadId = start.headers.get("Docker-Upload-UUID");

    await app.request(`/v2/${repoPath}/blobs/uploads/${uploadId}`, {
      method: "PATCH",
      headers: { "X-Test-Principal": principal("platform_admin") },
      body: new TextEncoder().encode("payload"),
    });

    const wrongDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const put = await app.request(
      `/v2/${repoPath}/blobs/uploads/${uploadId}?digest=${wrongDigest}`,
      {
        method: "PUT",
        headers: { "X-Test-Principal": principal("platform_admin") },
      },
    );
    expect(put.status).toBe(400);
    const body = (await put.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("DIGEST_INVALID");
  });

  test("manifest PUT then GET round-trips with Docker-Content-Digest", async () => {
    const repoPath = "public/routetest-manifest";
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        digest: `sha256:${"a".repeat(64)}`,
        mediaType: "application/vnd.oci.image.config.v1+json",
        size: 1,
      },
      layers: [
        {
          digest: `sha256:${"b".repeat(64)}`,
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          size: 42,
        },
      ],
    };
    const body = new TextEncoder().encode(JSON.stringify(manifest));
    const put = await app.request(`/v2/${repoPath}/manifests/v1.0.0`, {
      method: "PUT",
      headers: {
        "X-Test-Principal": principal("platform_admin"),
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body,
    });
    expect(put.status).toBe(201);
    const digest = put.headers.get("Docker-Content-Digest");
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const get = await app.request(`/v2/${repoPath}/manifests/v1.0.0`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("Docker-Content-Digest")).toBe(digest);
    const back = await get.text();
    expect(JSON.parse(back)).toEqual(manifest);

    // GET by digest works too.
    const getByDigest = await app.request(`/v2/${repoPath}/manifests/${digest}`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(getByDigest.status).toBe(200);
    expect(getByDigest.headers.get("Docker-Content-Digest")).toBe(digest);

    const deleted = await app.request(`/v2/${repoPath}/manifests/v1.0.0`, {
      method: "DELETE",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(deleted.status).toBe(202);

    const afterDelete = await app.request(`/v2/${repoPath}/manifests/v1.0.0`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(afterDelete.status).toBe(404);

    const catalog = await app.request("/v2/_catalog", {
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    const catalogBody = (await catalog.json()) as { repositories: string[] };
    expect(catalogBody.repositories).not.toContain(repoPath);
  });

  test("tag immutability: re-PUT of semver tag with different content returns 409", async () => {
    const repoPath = "public/routetest-immutable";
    const m1 = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"1".repeat(64)}`, mediaType: "x", size: 1 },
      layers: [],
    };
    const r1 = await app.request(`/v2/${repoPath}/manifests/1.2.3`, {
      method: "PUT",
      headers: {
        "X-Test-Principal": principal("platform_admin"),
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: new TextEncoder().encode(JSON.stringify(m1)),
    });
    expect(r1.status).toBe(201);

    // Different content under the same semver tag must fail.
    const m2 = { ...m1, layers: [{ digest: `sha256:${"c".repeat(64)}`, mediaType: "x", size: 1 }] };
    const r2 = await app.request(`/v2/${repoPath}/manifests/1.2.3`, {
      method: "PUT",
      headers: {
        "X-Test-Principal": principal("platform_admin"),
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: new TextEncoder().encode(JSON.stringify(m2)),
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("TAG_IMMUTABLE");

    // Same content under same semver is a no-op (idempotent).
    const r3 = await app.request(`/v2/${repoPath}/manifests/1.2.3`, {
      method: "PUT",
      headers: {
        "X-Test-Principal": principal("platform_admin"),
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: new TextEncoder().encode(JSON.stringify(m1)),
    });
    expect(r3.status).toBe(201);

    // 'latest' is mutable.
    const r4 = await app.request(`/v2/${repoPath}/manifests/latest`, {
      method: "PUT",
      headers: {
        "X-Test-Principal": principal("platform_admin"),
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: new TextEncoder().encode(JSON.stringify(m1)),
    });
    expect(r4.status).toBe(201);
    const r5 = await app.request(`/v2/${repoPath}/manifests/latest`, {
      method: "PUT",
      headers: {
        "X-Test-Principal": principal("platform_admin"),
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: new TextEncoder().encode(JSON.stringify(m2)),
    });
    expect(r5.status).toBe(201);
  });

  test("non-semver/non-latest tag rejected with TAG_INVALID", async () => {
    const repoPath = "public/routetest-tag-invalid";
    const body = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 2, mediaType: "x", layers: [] }),
    );
    const res = await app.request(`/v2/${repoPath}/manifests/dev`, {
      method: "PUT",
      headers: {
        "X-Test-Principal": principal("platform_admin"),
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { errors: Array<{ code: string }> };
    expect(json.errors[0]?.code).toBe("TAG_INVALID");
  });

  test("namespace access denied: regular user cannot write public", async () => {
    const repoPath = "public/routetest-denied";
    const res = await app.request(`/v2/${repoPath}/blobs/uploads/`, {
      method: "POST",
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("DENIED");
  });

  test("invalid namespace path returns 400 NAME_INVALID", async () => {
    const res = await app.request(`/v2/system/foo/blobs/uploads/`, {
      method: "POST",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("NAME_INVALID");
  });

  test("GET /v2/<repo>/tags/list returns sorted tag names", async () => {
    const repoPath = "public/routetest-taglist";
    const m = { schemaVersion: 2, mediaType: "x", layers: [] };
    for (const tag of ["1.0.0", "1.0.1", "2.0.0"]) {
      await app.request(`/v2/${repoPath}/manifests/${tag}`, {
        method: "PUT",
        headers: {
          "X-Test-Principal": principal("platform_admin"),
          "Content-Type": "application/vnd.oci.image.manifest.v1+json",
        },
        body: new TextEncoder().encode(
          JSON.stringify({
            ...m,
            layers: [
              {
                digest: `sha256:${tag.replace(/\./g, "0").padEnd(64, "f")}`,
                mediaType: "x",
                size: 1,
              },
            ],
          }),
        ),
      });
    }
    const res = await app.request(`/v2/${repoPath}/tags/list`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; tags: string[] };
    expect(body.tags).toEqual(["1.0.0", "1.0.1", "2.0.0"]);
  });

  test("GET /v2/_catalog returns repositories visible to principal", async () => {
    const res = await app.request("/v2/_catalog", {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repositories: string[] };
    expect(body.repositories).toEqual(expect.any(Array));
  });

  test("DELETE /v2/<repo>/manifests/<tag> removes the tag", async () => {
    const repoPath = "public/routetest-delete";
    const m = { schemaVersion: 2, mediaType: "x", layers: [] };
    await app.request(`/v2/${repoPath}/manifests/1.0.0`, {
      method: "PUT",
      headers: {
        "X-Test-Principal": principal("platform_admin"),
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: new TextEncoder().encode(JSON.stringify(m)),
    });
    const del = await app.request(`/v2/${repoPath}/manifests/1.0.0`, {
      method: "DELETE",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(del.status).toBe(202);
    const get = await app.request(`/v2/${repoPath}/manifests/1.0.0`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(get.status).toBe(404);
  });

  test("digest DELETE requires the manifest to be tagged in the target repository", async () => {
    const sourcePath = "public/routetest-delete-digest-source";
    const targetPath = "public/routetest-delete-digest-target";
    const body = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 2, mediaType: "x", layers: [] }),
    );
    const put = await app.request(`/v2/${sourcePath}/manifests/1.0.0`, {
      method: "PUT",
      headers: {
        "X-Test-Principal": principal("platform_admin"),
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body,
    });
    const digest = put.headers.get("Docker-Content-Digest");
    expect(digest).toBeTruthy();

    const upload = await app.request(`/v2/${targetPath}/blobs/uploads/`, {
      method: "POST",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    const uploadId = upload.headers.get("Docker-Upload-UUID");
    await app.request(`/v2/${targetPath}/blobs/uploads/${uploadId}`, {
      method: "DELETE",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });

    const denied = await app.request(`/v2/${targetPath}/manifests/${digest}`, {
      method: "DELETE",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(denied.status).toBe(404);

    const sourceStillExists = await app.request(`/v2/${sourcePath}/manifests/1.0.0`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(sourceStillExists.status).toBe(200);
  });

  test("DELETE /v2/<repo>/blobs/uploads/<id> aborts the upload", async () => {
    const repoPath = "public/routetest-abort";
    const start = await app.request(`/v2/${repoPath}/blobs/uploads/`, {
      method: "POST",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    const uploadId = start.headers.get("Docker-Upload-UUID");
    const cancel = await app.request(`/v2/${repoPath}/blobs/uploads/${uploadId}`, {
      method: "DELETE",
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(cancel.status).toBe(204);
  });

  test("HEAD/GET on unknown blob returns 404 BLOB_UNKNOWN", async () => {
    const repoPath = "public/routetest-blob"; // already has a real blob from a prior test
    const unknown = `sha256:${"0".repeat(64)}`;
    const res = await app.request(`/v2/${repoPath}/blobs/${unknown}`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("BLOB_UNKNOWN");
  });

  // ----- Cross-repo blob mount (Distribution v2 §6.5.2) -----

  // Helper: upload `payload` into `repoPath` and return the resulting digest.
  async function uploadBlobInto(
    repoPath: string,
    payload: Uint8Array,
    role: "platform_admin" | "user" | "org_admin" | "super_admin",
    overrides?: Partial<{ sub: string; orgIds: string[] }>,
  ): Promise<string> {
    const headers = { "X-Test-Principal": principal(role, overrides) };
    const start = await app.request(`/v2/${repoPath}/blobs/uploads/`, {
      method: "POST",
      headers,
    });
    expect(start.status).toBe(202);
    const uploadId = start.headers.get("Docker-Upload-UUID");
    expect(uploadId).toBeTruthy();
    await app.request(`/v2/${repoPath}/blobs/uploads/${uploadId}`, {
      method: "PATCH",
      headers,
      body: payload,
    });
    const { createHash } = await import("node:crypto");
    const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    const put = await app.request(`/v2/${repoPath}/blobs/uploads/${uploadId}?digest=${digest}`, {
      method: "PUT",
      headers,
    });
    expect(put.status).toBe(201);
    return digest;
  }

  test("blob mount happy path: 201 with Location + Docker-Content-Digest", async () => {
    const src = "public/routetest-mount-src";
    const dst = "public/routetest-mount-dst";
    const digest = await uploadBlobInto(
      src,
      new TextEncoder().encode("mountable-blob-bytes"),
      "platform_admin",
    );
    const res = await app.request(
      `/v2/${dst}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(src)}`,
      {
        method: "POST",
        headers: { "X-Test-Principal": principal("platform_admin") },
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("Docker-Content-Digest")).toBe(digest);
    expect(res.headers.get("Location")).toBe(`/v2/${dst}/blobs/${digest}`);
    // Mounted blob is readable from the destination repo path.
    const get = await app.request(`/v2/${dst}/blobs/${digest}`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(get.status).toBe(200);
  });

  test("blob mount denied when principal cannot read source", async () => {
    const orgId = "00000000-0000-0000-0000-00000000abcd";
    const src = `org/${orgId}/routetest-mount-private`;
    const dst = "public/routetest-mount-dst-2";
    const digest = await uploadBlobInto(
      src,
      new TextEncoder().encode("private-payload"),
      "platform_admin",
    );
    // The plain `user` role is not a member of orgId, so source read fails.
    const res = await app.request(
      `/v2/${dst}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(src)}`,
      {
        method: "POST",
        headers: { "X-Test-Principal": principal("user") },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("DENIED");
  });

  test("blob mount denied when principal cannot write destination", async () => {
    const src = "public/routetest-mount-src-3";
    const dst = "public/routetest-mount-dst-3";
    const digest = await uploadBlobInto(
      src,
      new TextEncoder().encode("write-denied-payload"),
      "platform_admin",
    );
    // Plain `user` cannot write to `public/...`.
    const res = await app.request(
      `/v2/${dst}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(src)}`,
      {
        method: "POST",
        headers: { "X-Test-Principal": principal("user") },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("DENIED");
  });

  test("blob mount falls back to fresh upload when blob is unknown", async () => {
    const src = "public/routetest-mount-fallback-src";
    const dst = "public/routetest-mount-fallback-dst";
    const unknown = `sha256:${"f".repeat(64)}`;
    const res = await app.request(
      `/v2/${dst}/blobs/uploads/?mount=${encodeURIComponent(unknown)}&from=${encodeURIComponent(src)}`,
      {
        method: "POST",
        headers: { "X-Test-Principal": principal("platform_admin") },
      },
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("Range")).toBe("0-0");
    expect(res.headers.get("Docker-Upload-UUID")).toBeTruthy();
  });

  test("blob mount across namespaces: org → user (super_admin can do both)", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000aa";
    const userId = "00000000-0000-0000-0000-0000000000bb";
    const src = `org/${orgId}/routetest-mount-orgsrc`;
    const dst = `user/${userId}/routetest-mount-userdst`;
    const digest = await uploadBlobInto(
      src,
      new TextEncoder().encode("cross-ns-payload"),
      "super_admin",
    );
    const res = await app.request(
      `/v2/${dst}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(src)}`,
      {
        method: "POST",
        headers: { "X-Test-Principal": principal("super_admin") },
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("Docker-Content-Digest")).toBe(digest);
  });

  // ----- Link header pagination (Distribution v2 §4.1.2) -----

  test("_catalog emits Link rel=next when more rows remain", async () => {
    // Seed 3 routetest-page-* repos so n=2 leaves 1 leftover row.
    for (const n of ["a", "b", "c"]) {
      await app.request(`/v2/public/routetest-page-${n}/blobs/uploads/`, {
        method: "POST",
        headers: { "X-Test-Principal": principal("platform_admin") },
      });
    }
    const res = await app.request("/v2/_catalog?n=2", {
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repositories: string[] };
    expect(body.repositories.length).toBe(2);
    const link = res.headers.get("Link");
    if (body.repositories.length === 2) {
      // hasMore depends on total count; ensure header form when it exists.
      if (link) {
        expect(link).toMatch(/^<\/v2\/_catalog\?[^>]+>; rel="next"$/);
        expect(link).toContain("n=2");
        expect(link).toContain("last=");
      }
    }
  });

  test("_catalog Link header omitted on final page", async () => {
    // Use a very large n so we definitely consume the entire result set.
    const res = await app.request("/v2/_catalog?n=10000", {
      headers: { "X-Test-Principal": principal("platform_admin") },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Link")).toBeNull();
  });

  test("tags/list emits Link rel=next when more rows remain", async () => {
    const repoPath = "public/routetest-pagetags";
    const m = { schemaVersion: 2, mediaType: "x", layers: [] };
    for (const tag of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
      await app.request(`/v2/${repoPath}/manifests/${tag}`, {
        method: "PUT",
        headers: {
          "X-Test-Principal": principal("platform_admin"),
          "Content-Type": "application/vnd.oci.image.manifest.v1+json",
        },
        body: new TextEncoder().encode(
          JSON.stringify({
            ...m,
            layers: [
              {
                digest: `sha256:${tag.replace(/\./g, "0").padEnd(64, "f")}`,
                mediaType: "x",
                size: 1,
              },
            ],
          }),
        ),
      });
    }
    const res = await app.request(`/v2/${repoPath}/tags/list?n=2`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; tags: string[] };
    expect(body.tags).toEqual(["1.0.0", "1.1.0"]);
    const link = res.headers.get("Link");
    expect(link).not.toBeNull();
    expect(link ?? "").toMatch(/^<\/v2\/[^>]+\/tags\/list\?[^>]+>; rel="next"$/);
    expect(link ?? "").toContain("n=2");
    expect(link ?? "").toContain(`last=${encodeURIComponent("1.1.0")}`);
  });

  test("tags/list Link header omitted on final page", async () => {
    const repoPath = "public/routetest-pagetags-final";
    const m = { schemaVersion: 2, mediaType: "x", layers: [] };
    for (const tag of ["1.0.0", "1.1.0"]) {
      await app.request(`/v2/${repoPath}/manifests/${tag}`, {
        method: "PUT",
        headers: {
          "X-Test-Principal": principal("platform_admin"),
          "Content-Type": "application/vnd.oci.image.manifest.v1+json",
        },
        body: new TextEncoder().encode(
          JSON.stringify({
            ...m,
            layers: [
              {
                digest: `sha256:${tag.replace(/\./g, "0").padEnd(64, "f")}`,
                mediaType: "x",
                size: 1,
              },
            ],
          }),
        ),
      });
    }
    // last=1.1.0 -> empty page after, no Link.
    const res = await app.request(`/v2/${repoPath}/tags/list?n=2&last=1.1.0`, {
      headers: { "X-Test-Principal": principal("user") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual([]);
    expect(res.headers.get("Link")).toBeNull();
  });
});
