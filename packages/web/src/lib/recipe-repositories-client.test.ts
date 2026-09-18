import type { RecipeRepository } from "@kuintessence/shared/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  activateRecipeRepository,
  deactivateRecipeRepository,
  getRecipeRepository,
  importRecipeRepository,
  listRecipeRepositories,
} from "./recipe-repositories-client";
import { SoftwareError } from "./software-client";

const repository: RecipeRepository = {
  id: "a".repeat(64),
  repository: "public/builtin",
  activeCommit: null,
  snapshots: [],
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("recipe repositories client", () => {
  test("reads the repository list and immutable repository id with credentials", async () => {
    localStorage.setItem("kq_token", "recipe-token");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(respond({ repositories: [repository] }))
      .mockResolvedValueOnce(respond(repository));
    vi.stubGlobal("fetch", fetcher);

    expect(await listRecipeRepositories()).toEqual([repository]);
    expect(await getRecipeRepository(repository.id)).toEqual(repository);
    expect(fetcher.mock.calls[0]).toEqual([
      "/software/api/spack/recipe-repositories",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ Authorization: "Bearer recipe-token" }),
      }),
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `/software/api/spack/recipe-repositories/${repository.id}`,
    );
  });

  test("uploads the original File as octet-stream with an encoded logical repository", async () => {
    const fetcher = vi.fn(async () => respond(repository));
    vi.stubGlobal("fetch", fetcher);
    const file = new File(["bundle"], "builtin.bundle", { type: "text/plain" });
    expect(await importRecipeRepository("public/builtin", file)).toEqual(repository);
    expect(fetcher.mock.calls[0]).toEqual([
      "/software/api/spack/recipe-repositories/import?repository=public%2Fbuiltin",
      expect.objectContaining({
        method: "POST",
        body: file,
        headers: expect.objectContaining({ "Content-Type": "application/octet-stream" }),
      }),
    ]);
  });

  test("uses CAS and executable acknowledgement for activation and rollback, preserving delete JSON", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      respond(repository),
    );
    vi.stubGlobal("fetch", fetcher);
    const activation = {
      commit: "b".repeat(40),
      expectedActiveCommit: "c".repeat(40),
      acknowledgeExecutableRecipes: true as const,
    };
    expect(await activateRecipeRepository(repository.id, activation)).toEqual(repository);
    expect(await deactivateRecipeRepository(repository.id, activation.commit)).toEqual(repository);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify(activation),
    });
    expect(fetcher.mock.calls[1]).toEqual([
      `/software/api/spack/recipe-repositories/${repository.id}/active`,
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ expectedActiveCommit: activation.commit }),
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    ]);
  });

  test.each([
    { error: { code: "CONFLICT", message: "changed", details: { activeCommit: "b".repeat(40) } } },
    {
      errors: [{ code: "CONFLICT", message: "changed", detail: { activeCommit: "b".repeat(40) } }],
    },
  ])("preserves SoftwareError status, code, and details", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(body, 409)),
    );
    await expect(listRecipeRepositories()).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      details: { activeCommit: "b".repeat(40) },
    });
    await expect(listRecipeRepositories()).rejects.toBeInstanceOf(SoftwareError);
  });

  test("maps network failures to SoftwareError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(listRecipeRepositories()).rejects.toMatchObject({
      status: 503,
      code: "REGISTRY_UNREACHABLE",
    });
  });

  test.each([
    new Response("<html>not an API</html>"),
    new Response("{broken", { headers: { "content-type": "application/json" } }),
    respond({ repositories: [{ repository: "missing fields" }] }),
  ])("rejects invalid responses instead of presenting an empty list", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(listRecipeRepositories()).rejects.toMatchObject({
      status: 502,
      code: "REGISTRY_INVALID_RESPONSE",
    });
  });
});
