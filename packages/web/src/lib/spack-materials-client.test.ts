import type {
  SpackMaterialBinding,
  SpackMaterialBlob,
  SpackMaterialManifest,
  SpackMaterialPublish,
  SpackMaterialSummary,
} from "@kuintessence/shared/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SoftwareError } from "./software-client";
import {
  getSpackMaterial,
  listSpackMaterials,
  publishSpackMaterial,
  uploadSpackMaterial,
} from "./spack-materials-client";

const BASE = "/software/api/spack/material-repositories";
const blob: SpackMaterialBlob = { digest: `sha256:${"a".repeat(64)}`, size: 6 };
const binding: SpackMaterialBinding = {
  repositoryId: "b".repeat(64),
  manifestDigest: `sha256:${"c".repeat(64)}`,
};
const release: SpackMaterialPublish = {
  version: 1,
  repository: "org/research/sources",
  spec: "zlib@1.3.1",
  spackVersion: "0.23.1",
  target: "x86_64",
  redistribution: "unrestricted",
  sources: [{ path: "zlib/source.tar.gz", blob }],
  lockfile: { digest: `sha256:${"d".repeat(64)}`, size: 12 },
  recipes: [{ repositoryId: "e".repeat(64), commit: "f".repeat(40), roots: ["."] }],
};
const manifest: SpackMaterialManifest = {
  ...release,
  recipes: release.recipes.map((recipe) => ({
    ...recipe,
    archive: { digest: `sha256:${"1".repeat(64)}`, size: 20 },
  })),
};
const summary: SpackMaterialSummary = {
  ...binding,
  repository: release.repository,
  spec: release.spec,
  target: release.target,
  spackVersion: release.spackVersion,
  redistribution: "unrestricted",
  sourceCount: 1,
  totalBytes: 38,
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sourceFile() {
  return new File(["source"], "source.tar.gz", { type: "text/plain" });
}

const operations = [
  {
    name: "list",
    response: { releases: [summary] },
    run: (signal?: AbortSignal) => listSpackMaterials({}, signal),
  },
  {
    name: "upload",
    response: blob,
    run: (signal?: AbortSignal) =>
      uploadSpackMaterial(release.repository, blob, sourceFile(), signal),
  },
  {
    name: "publish",
    response: binding,
    run: (signal?: AbortSignal) => publishSpackMaterial(release, signal),
  },
  {
    name: "get",
    response: manifest,
    run: (signal?: AbortSignal) => getSpackMaterial(binding, signal),
  },
];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Spack materials client", () => {
  test("lists the complete catalog without server pagination or persistent caching", async () => {
    localStorage.setItem("kq_token", "materials-token");
    const catalog = { releases: [summary] };
    const fetcher = vi.fn().mockResolvedValue(respond(catalog));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();
    await expect(listSpackMaterials({}, signal)).resolves.toEqual(catalog);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      BASE,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: expect.objectContaining({ Authorization: "Bearer materials-token" }),
      }),
    );
    expect(fetcher.mock.calls[0]?.[1].body).toBeUndefined();
  });

  test.each([
    "public/sources",
    "org/research/sources",
    "user/alice/sources",
  ])("encodes the exact repository filter %s", async (repository) => {
    const fetcher = vi.fn().mockResolvedValue(respond({ releases: [{ ...summary, repository }] }));
    vi.stubGlobal("fetch", fetcher);
    await expect(listSpackMaterials({ repository })).resolves.toEqual({
      releases: [{ ...summary, repository }],
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `${BASE}?repository=${encodeURIComponent(repository)}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  test.each([
    { repository: "" },
    { repository: "sources" },
    { repository: "org/research" },
    { repository: "org/research/../sources" },
    { repository: "public/sources?repository=other" },
    { repository: "https://example.test/source" },
    { repository: "public/sources", page: 1 },
  ])("rejects invalid catalog query %j before fetch", async (query) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(listSpackMaterials(query)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    {},
    { releases: null },
    { releases: [binding] },
    { releases: [{ ...summary, repositoryId: "../secret" }] },
    { releases: [{ ...summary, manifestDigest: "invalid" }] },
    { releases: [{ ...summary, redistribution: "restricted" }] },
    { releases: [{ ...summary, sourceCount: 0 }] },
    { releases: [{ ...summary, sourceCount: 1.5 }] },
    { releases: [{ ...summary, totalBytes: -1 }] },
    { releases: [{ ...summary, totalBytes: Number.MAX_SAFE_INTEGER }] },
    { releases: [{ ...summary, url: "https://example.test" }] },
    { releases: [], nextPage: 2 },
    { releases: Array.from({ length: 201 }, () => summary) },
  ])("rejects malformed or oversized catalog responses", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(body)));
    await expect(listSpackMaterials()).rejects.toMatchObject({
      status: 502,
      code: "REGISTRY_INVALID_RESPONSE",
    });
  });

  test.each([0, 200])("accepts a complete catalog of %i releases", async (count) => {
    const catalog = { releases: Array.from({ length: count }, () => summary) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(catalog)));
    await expect(listSpackMaterials()).resolves.toEqual(catalog);
  });

  test("rejects a filtered response containing another repository", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ releases: [summary] })));
    await expect(listSpackMaterials({ repository: "public/sources" })).rejects.toMatchObject({
      status: 502,
      code: "REGISTRY_INVALID_RESPONSE",
    });
  });

  test("propagates budget failure without treating it as an empty or partial catalog", async () => {
    const error = {
      code: "MATERIAL_CATALOG_LIMIT",
      message: "Catalog budget exceeded",
      details: { limit: 200 },
    };
    const fetcher = vi.fn().mockResolvedValue(respond({ error, releases: [summary] }, 503));
    vi.stubGlobal("fetch", fetcher);
    await expect(listSpackMaterials()).rejects.toMatchObject({ status: 503, ...error });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test.each([
    "public/sources",
    "org/research/sources",
    "user/alice/sources",
  ])("uploads the original File with encoded repository %s", async (repository) => {
    localStorage.setItem("kq_token", "materials-token");
    const file = sourceFile();
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const text = vi.spyOn(file, "text");
    const fetcher = vi.fn().mockResolvedValue(respond(blob, 201));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();

    await expect(uploadSpackMaterial(repository, blob, file, signal)).resolves.toEqual(blob);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `${BASE}/blobs?repository=${encodeURIComponent(repository)}&digest=${encodeURIComponent(blob.digest)}`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: expect.objectContaining({
          Authorization: "Bearer materials-token",
          "Content-Type": "application/octet-stream",
        }),
        signal,
        redirect: "error",
      }),
    );
    expect(fetcher.mock.calls[0]?.[1].body).toBe(file);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  test.each([
    "",
    "https://example.org/source",
    "org/team/../source",
    "public/a?org=other",
  ])("rejects invalid repository %s before upload", async (repository) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(uploadSpackMaterial(repository, blob, sourceFile())).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    { ...blob, digest: "invalid" },
    { ...blob, size: 0 },
    { ...blob, size: -1 },
    { ...blob, size: 1.5 },
    { ...blob, size: 16 * 1024 ** 3 + 1 },
    { ...blob, size: 7 },
  ])("rejects invalid blob or mismatching File size: %j", async (input) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      uploadSpackMaterial(release.repository, input, sourceFile()),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    { ...blob, digest: `sha256:${"2".repeat(64)}` },
    { ...blob, size: blob.size + 1 },
    { digest: blob.digest },
    { ...blob, url: "https://example.org/source" },
  ])("rejects invalid or mismatching upload receipt: %j", async (receipt) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(receipt)));
    await expect(uploadSpackMaterial(release.repository, blob, sourceFile())).rejects.toMatchObject(
      { status: 502, code: "REGISTRY_INVALID_RESPONSE" },
    );
  });

  test("publishes schema-validated JSON with write authentication", async () => {
    localStorage.setItem("kq_token", "materials-token");
    const fetcher = vi.fn().mockResolvedValue(respond(binding, 201));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();
    await expect(publishSpackMaterial(release, signal)).resolves.toEqual(binding);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `${BASE}/releases`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(release),
        signal,
        redirect: "error",
        credentials: "same-origin",
        headers: expect.objectContaining({
          Authorization: "Bearer materials-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  test.each([
    { ...release, sources: [] },
    { ...release, repository: "org/../sources" },
    {
      ...release,
      sources: [
        { path: "source", blob },
        { path: "source", blob },
      ],
    },
    { ...release, lockfile: { ...blob, size: blob.size + 1 } },
    { ...release, recipes: [] },
  ])("rejects invalid publish input before fetch", async (input) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(publishSpackMaterial(input)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([0, 1])("enforces the exact 2 MiB UTF-8 publish limit (excess %i)", async (excess) => {
    const limit = 2 * 1024 ** 2;
    const input: SpackMaterialPublish = {
      ...release,
      target: "\u4e2d".repeat(256),
      sources: Array.from({ length: 4000 }, (_, index) => ({
        path: `${index}/${"x".repeat(406)}`,
        blob,
      })),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    const padding = limit - bytes + excess;
    input.spec += "x".repeat(padding);
    expect(padding).toBeGreaterThan(0);
    expect(input.spec.length).toBeLessThanOrEqual(4096);
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBe(limit + excess);
    expect(JSON.stringify(input).length).toBeLessThan(limit);
    const fetcher = vi.fn().mockResolvedValue(respond(binding));
    vi.stubGlobal("fetch", fetcher);
    if (excess) {
      await expect(publishSpackMaterial(input)).rejects.toMatchObject({
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
      });
      expect(fetcher).not.toHaveBeenCalled();
    } else {
      await expect(publishSpackMaterial(input)).resolves.toEqual(binding);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  test("gets the manifest from the same-origin encoded binding path", async () => {
    localStorage.setItem("kq_token", "materials-token");
    const fetcher = vi.fn().mockResolvedValue(respond(manifest));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();
    await expect(getSpackMaterial(binding, signal)).resolves.toEqual(manifest);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `${BASE}/${encodeURIComponent(binding.repositoryId)}/releases/${encodeURIComponent(binding.manifestDigest)}`,
      expect.objectContaining({
        method: "GET",
        signal,
        redirect: "error",
        credentials: "same-origin",
        headers: expect.objectContaining({ Authorization: "Bearer materials-token" }),
      }),
    );
    expect(fetcher.mock.calls[0]?.[1].body).toBeUndefined();
  });

  test.each([
    { ...binding, repositoryId: "../another-namespace" },
    { ...binding, manifestDigest: `${blob.digest}?url=https://example.org` },
  ])("rejects invalid binding on both input and publish response", async (invalidBinding) => {
    const fetcher = vi.fn().mockResolvedValue(respond(invalidBinding));
    vi.stubGlobal("fetch", fetcher);
    await expect(getSpackMaterial(invalidBinding)).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(publishSpackMaterial(release)).rejects.toMatchObject({
      status: 502,
      code: "REGISTRY_INVALID_RESPONSE",
    });
  });

  test.each([
    release,
    { ...manifest, sources: [] },
    { ...manifest, sources: [{ path: "../source", blob }] },
    { ...manifest, upstream: "https://example.org/materials" },
  ])("rejects invalid manifest responses without following upstream URLs", async (body) => {
    const fetcher = vi.fn().mockResolvedValue(respond(body));
    vi.stubGlobal("fetch", fetcher);
    await expect(getSpackMaterial(binding)).rejects.toMatchObject({
      status: 502,
      code: "REGISTRY_INVALID_RESPONSE",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  describe.each(operations)("$name request guarantees", ({ run, response }) => {
    test("passes redirect and optional signal settings without bearer authentication", async () => {
      const fetcher = vi.fn().mockResolvedValue(respond(response));
      vi.stubGlobal("fetch", fetcher);
      await run();
      const init = fetcher.mock.calls[0]?.[1] as RequestInit;
      expect(init).toMatchObject({ signal: undefined, redirect: "error" });
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
    });

    test("does not fetch when already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(run(controller.signal)).rejects.toBe(controller.signal.reason);
      expect(fetcher).not.toHaveBeenCalled();
    });

    test.each([
      "fetch rejection",
      "fetch resolution",
      "body rejection",
      "body resolution",
    ])("preserves abort reason after %s", async (stage) => {
      const controller = new AbortController();
      const reason = new DOMException("Cancelled by user", "AbortError");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const result = respond(response);
          if (stage.startsWith("body")) {
            vi.spyOn(result, "json").mockImplementation(async () => {
              controller.abort(reason);
              if (stage === "body rejection") throw reason;
              return response;
            });
          } else {
            controller.abort(reason);
            if (stage === "fetch rejection") throw reason;
          }
          return result;
        }),
      );
      await expect(run(controller.signal)).rejects.toBe(reason);
    });

    test("preserves a custom abort reason", async () => {
      const controller = new AbortController();
      const reason = new Error("Batch stopped");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          controller.abort(reason);
          throw reason;
        }),
      );
      await expect(run(controller.signal)).rejects.toBe(reason);
    });

    test.each([
      () => new Response("<html>not JSON</html>"),
      () => new Response("{broken", { headers: { "content-type": "application/json" } }),
      () => respond(null),
    ])("rejects invalid response bodies", async (makeResponse) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse()));
      await expect(run()).rejects.toMatchObject({
        status: 502,
        code: "REGISTRY_INVALID_RESPONSE",
      });
    });

    test("keeps HTTP error status, code, and details", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          respond(
            { error: { code: "FORBIDDEN", message: "Denied", details: { namespace: "org" } } },
            403,
          ),
        ),
      );
      await expect(run()).rejects.toBeInstanceOf(SoftwareError);
      await expect(run()).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
        details: { namespace: "org" },
      });
    });

    test("keeps non-abort network failures as SoftwareError", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      await expect(run()).rejects.toMatchObject({ status: 503, code: "REGISTRY_UNREACHABLE" });
    });
  });
});
