import { createHash } from "node:crypto";
import type { RecipeRepository, SpackUpstreamImport } from "@kuintessence/shared/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setMobileManagementPolicy } from "./mobile-management-policy";
import {
  importSpackUpstream,
  parseSpackUpstreamImport,
  readSpackUpstreamManifest,
} from "./spack-upstream-client";

const recipe = {
  kind: "recipe" as const,
  repository: "public/builtin",
  url: "https://downloads.example.test/recipes.bundle",
  digest: `sha256:${"a".repeat(64)}`,
  size: 100,
};
const repository: RecipeRepository = {
  id: "b".repeat(64),
  repository: recipe.repository,
  activeCommit: null,
  snapshots: [],
};
const source = { digest: `sha256:${"c".repeat(64)}`, size: 6 };
const lockfile = { digest: `sha256:${"d".repeat(64)}`, size: 4 };
const material: SpackUpstreamImport = {
  kind: "material",
  files: [
    { url: "https://downloads.example.test/source.tar.gz", blob: source },
    { url: "https://downloads.example.test/spack.lock", blob: lockfile },
  ],
  release: {
    version: 1,
    repository: "org/research/sources",
    spec: "hello@2.12.1",
    spackVersion: "1.0.0",
    target: "x86_64",
    redistribution: "unrestricted",
    sources: [{ path: "hello/source.tar.gz", blob: source }],
    lockfile,
    recipes: [{ repositoryId: "e".repeat(64), commit: "f".repeat(40), roots: ["."] }],
  },
};
const binding = {
  repositoryId: createHash("sha256").update(material.release.repository).digest("hex"),
  manifestDigest: `sha256:${"2".repeat(64)}`,
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  { kind: "recipe", request: recipe, receipt: { kind: "recipe", repository } },
  { kind: "material", request: material, receipt: { kind: "material", binding } },
])("$kind online import transport", ({ request, receipt }) => {
  test("posts validated JSON through the authenticated same-origin API", async () => {
    localStorage.setItem("kq_token", "test-online-import-token");
    const fetcher = vi.fn().mockResolvedValue(response(receipt));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();
    await expect(importSpackUpstream(request, signal)).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/software/api/spack/upstream-imports",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        signal,
        body: JSON.stringify(request),
        headers: expect.objectContaining({
          Authorization: "Bearer test-online-import-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  test("does not send an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(importSpackUpstream(request, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each(["fetch", "body"])("preserves cancellation during %s", async (stage) => {
    const controller = new AbortController();
    const reason = new Error("Stopped");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const result = response(receipt);
        if (stage === "body") {
          vi.spyOn(result, "json").mockImplementation(async () => {
            controller.abort(reason);
            return receipt;
          });
        } else {
          controller.abort(reason);
          throw reason;
        }
        return result;
      }),
    );
    await expect(importSpackUpstream(request, controller.signal)).rejects.toBe(reason);
  });

  test("rejects malformed receipts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...receipt, url: recipe.url })));
    await expect(importSpackUpstream(request)).rejects.toMatchObject({
      status: 502,
      code: "REGISTRY_INVALID_RESPONSE",
    });
  });

  test("cannot bypass the existing mobile mutation policy", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    setMobileManagementPolicy(true);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(importSpackUpstream(request)).rejects.toMatchObject({
      code: "MOBILE_HIGH_RISK_MUTATION_BLOCKED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

test.each([
  "http://downloads.example.test/recipes.bundle",
  "https://user:password@downloads.example.test/recipes.bundle",
  "https://downloads.example.test/recipes.bundle?token=secret",
  "https://downloads.example.test/recipes.bundle#secret",
  "https://downloads.example.test:8443/recipes.bundle",
  "https://[2606:4700:4700::1111]/recipes.bundle",
])("rejects forbidden URL syntax before fetching", async (url) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(importSpackUpstream({ ...recipe, url })).rejects.toMatchObject({
    status: 422,
    code: "VALIDATION_ERROR",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

const invalidRequests: SpackUpstreamImport[] = [
  { ...recipe, repository: "org/../source" },
  { ...recipe, digest: "invalid" },
  { ...recipe, size: 0 },
  { ...recipe, size: 128 * 1024 ** 2 + 1 },
  { ...material, files: [] },
  {
    ...material,
    files: [{ url: "https://downloads.example.test/source.tar.gz", blob: source }],
  },
  {
    ...material,
    files: Array.from({ length: 257 }, () => ({
      url: "https://downloads.example.test/source.tar.gz",
      blob: source,
    })),
  },
];

test.each(invalidRequests)("rejects invalid manifests before fetching", async (input) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(() => parseSpackUpstreamImport(input)).toThrow();
  await expect(importSpackUpstream(input)).rejects.toMatchObject({
    status: 422,
    code: "VALIDATION_ERROR",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  { kind: "material", binding },
  { kind: "recipe", repository: { ...repository, repository: "org/other/private" } },
])("rejects a receipt for a different kind or recipe namespace", async (receipt) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(receipt)));
  await expect(importSpackUpstream(recipe)).rejects.toMatchObject({
    status: 502,
    code: "REGISTRY_INVALID_RESPONSE",
  });
});

test("material submission includes publication, not only downloads", async () => {
  const hash = vi.spyOn(crypto.subtle, "digest");
  const fetcher = vi.fn().mockResolvedValue(response({ kind: "material", binding }));
  vi.stubGlobal("fetch", fetcher);
  await expect(importSpackUpstream(material)).resolves.toEqual({ kind: "material", binding });
  expect(fetcher.mock.calls[0]?.[1].body).toBe(JSON.stringify(material));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(hash).toHaveBeenCalledExactlyOnceWith(
    "SHA-256",
    new TextEncoder().encode(material.release.repository),
  );
});

test("rejects a valid material receipt belonging to another repository", async () => {
  const unrelated = {
    ...binding,
    repositoryId: createHash("sha256").update("org/other/sources").digest("hex"),
  };
  const fetcher = vi.fn().mockResolvedValue(response({ kind: "material", binding: unrelated }));
  vi.stubGlobal("fetch", fetcher);
  await expect(importSpackUpstream(material)).rejects.toMatchObject({
    status: 502,
    code: "REGISTRY_INVALID_RESPONSE",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("preserves cancellation while hashing a material receipt's repository", async () => {
  const controller = new AbortController();
  const reason = new Error("Receipt check cancelled");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ kind: "material", binding })));
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async () => {
    controller.abort(reason);
    return new Uint8Array(32).buffer;
  });
  await expect(importSpackUpstream(material, controller.signal)).rejects.toBe(reason);
});

test("a failed digest check never accepts a material receipt", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ kind: "material", binding })));
  const error = new Error("WebCrypto unavailable");
  vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(error);
  await expect(importSpackUpstream(material)).rejects.toBe(error);
});

test("enforces the serialized manifest limit before sending a valid large release", async () => {
  const input: SpackUpstreamImport = {
    ...material,
    release: {
      ...material.release,
      sources: Array.from({ length: 6000 }, (_, index) => ({
        path: `${index}/${"x".repeat(400)}`,
        blob: source,
      })),
    },
  };
  expect(parseSpackUpstreamImport(input)).toEqual(input);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(importSpackUpstream(input)).rejects.toMatchObject({
    status: 413,
    code: "PAYLOAD_TOO_LARGE",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test("reads a single JSON manifest without fetching its URLs", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    readSpackUpstreamManifest(new File([JSON.stringify(recipe)], "online.json")),
  ).resolves.toEqual(recipe);
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  "empty",
  "oversized",
  "malformed",
  "invalid-utf8",
])("rejects a %s manifest without leaking its contents", async (kind) => {
  const contents =
    kind === "empty"
      ? ""
      : kind === "oversized"
        ? " ".repeat(2 * 1024 ** 2 + 1)
        : kind === "malformed"
          ? recipe.url
          : new Uint8Array([0xff]);
  const file = new File([contents], "online.json");
  await expect(readSpackUpstreamManifest(file)).rejects.toMatchObject({
    code: "VALIDATION_ERROR",
    diagnosticMessage: expect.not.stringContaining(recipe.url),
  });
});

test("rejects a network response loss without retrying", async () => {
  const fetcher = vi.fn().mockRejectedValue(new TypeError("Network error"));
  vi.stubGlobal("fetch", fetcher);
  await expect(importSpackUpstream(recipe)).rejects.toMatchObject({
    code: "REGISTRY_UNREACHABLE",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("a cancelled file read preserves the caller's reason", async () => {
  const controller = new AbortController();
  const file = new File([JSON.stringify(recipe)], "online.json");
  vi.spyOn(file, "arrayBuffer").mockImplementation(async () => {
    controller.abort();
    return new TextEncoder().encode(JSON.stringify(recipe)).buffer;
  });
  await expect(readSpackUpstreamManifest(file, controller.signal)).rejects.toBe(
    controller.signal.reason,
  );
});
