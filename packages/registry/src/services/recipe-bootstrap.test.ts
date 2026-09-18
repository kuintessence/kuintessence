import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecipeRepository } from "@kuintessence/shared";
import { bootstrapRecipeRepositories } from "./recipe-bootstrap";
import { RecipeStoreError } from "./recipe-git";
import { RecipeGitStore } from "./recipe-git-store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kq-recipe-bootstrap-"));
  directories.push(directory);
  await mkdir(join(directory, "imports"));
  const manifest = join(directory, "imports", "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      repositories: [{ repository: "public/builtin", bundlePath: "builtin.bundle" }],
    }),
  );
  await writeFile(join(directory, "imports", "builtin.bundle"), "fixture bundle bytes");
  return { directory, manifest };
}

describe("recipe bootstrap", () => {
  test("resolves local manifest inputs and stages through the shared importer", async () => {
    const f = await fixture();
    let imported: { repository: string; actor: string; bytes: string } | undefined;
    const store = {
      get: async () => {
        throw new RecipeStoreError(404, "missing");
      },
      importBundle: async (
        repository: string,
        input: ReadableStream<Uint8Array>,
        actor: string,
      ) => {
        imported = { repository, actor, bytes: await new Response(input).text() };
        return {
          id: RecipeGitStore.repositoryId(repository),
          repository,
          activeCommit: null,
          snapshots: [],
        } satisfies RecipeRepository;
      },
    };
    const result = await bootstrapRecipeRepositories(store, f.manifest);
    expect(imported).toEqual({
      repository: "public/builtin",
      actor: "registry-bootstrap",
      bytes: "fixture bundle bytes",
    });
    expect(result[0]?.status).toBe("imported");
  });

  test("never reimports or overwrites a repository already maintained by operators", async () => {
    const f = await fixture();
    const existing = {
      id: RecipeGitStore.repositoryId("public/builtin"),
      repository: "public/builtin",
      activeCommit: "a".repeat(40),
      snapshots: [
        {
          commit: "a".repeat(40),
          importedAt: "2026-09-17T00:00:00.000Z",
          importedBy: "operator",
          bundleSha256: "b".repeat(64),
          fileCount: 1,
          totalBytes: 1,
          roots: [],
          diagnostics: [],
          validation: "static-only" as const,
        },
      ],
    };
    const store = {
      get: async () => existing,
      importBundle: async () => {
        throw new Error("must not import existing repository");
      },
    };
    expect(await bootstrapRecipeRepositories(store, f.manifest)).toEqual([
      { repository: "public/builtin", status: "skipped-existing" },
    ]);
  });

  test("rejects URL inputs, unknown activation flags and duplicate repositories", async () => {
    const f = await fixture();
    const store = new RecipeGitStore(join(f.directory, "store"));
    for (const repositories of [
      [{ repository: "public/builtin", bundlePath: "https://example.com/repo.bundle" }],
      [{ repository: "public/builtin", bundlePath: "builtin.bundle", activate: true }],
      [
        { repository: "public/builtin", bundlePath: "builtin.bundle" },
        { repository: "public/builtin", bundlePath: "other.bundle" },
      ],
    ]) {
      await writeFile(f.manifest, JSON.stringify({ version: 1, repositories }));
      await expect(bootstrapRecipeRepositories(store, f.manifest)).rejects.toThrow();
    }
  });
});
