import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMIT, PREVIOUS, repository } from "../routes/spack-repositories.test-helpers";
import { RecipeGitStore } from "./recipe-git-store";

const directories: string[] = [];
const METADATA = [
  { name: "identity", limit: 4096 },
  { name: "snapshot", limit: 2 * 1024 ** 2 },
] as const;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-recipe-snapshot-test-"));
  directories.push(root);
  const recipe = repository("public/snapshot-read");
  const snapshot = recipe.snapshots[0];
  if (!snapshot) throw new Error("Missing fixture snapshot");
  const identity = { id: recipe.id, repository: recipe.repository };
  const directory = join(root, "repositories", `${recipe.id}.git`);
  const history = join(root, "manifests", recipe.id);
  const paths = {
    identity: join(directory, "kq-repository.json"),
    snapshot: join(history, `${COMMIT}.json`),
  };
  const contents = {
    identity: JSON.stringify(identity),
    snapshot: JSON.stringify(snapshot),
  };
  // Deliberately omit HEAD, objects, refs, config and every Git initialization step.
  await mkdir(directory, { recursive: true });
  await mkdir(history, { recursive: true });
  await writeFile(paths.identity, contents.identity);
  await writeFile(paths.snapshot, contents.snapshot);
  return {
    root,
    directory,
    history,
    paths,
    contents,
    identity,
    snapshot,
    store: new RecipeGitStore(root),
  };
}

describe("RecipeGitStore bounded snapshot metadata reads", () => {
  test("reads an exact commit without Git or unrelated history", async () => {
    const f = await fixture();
    const previous = { ...f.snapshot, commit: PREVIOUS, importedBy: "previous-publisher" };
    await writeFile(join(f.history, `${PREVIOUS}.json`), JSON.stringify(previous));
    await writeFile(join(f.history, `${"c".repeat(40)}.json`), "corrupt unrelated history");
    const checkpoint = mock(() => {});

    expect(await readdir(f.directory)).toEqual(["kq-repository.json"]);
    expect(await f.store.getSnapshot(f.identity.id, COMMIT, checkpoint)).toEqual({
      ...f.identity,
      snapshot: f.snapshot,
    });
    expect(checkpoint).toHaveBeenCalled();
    expect(await f.store.getSnapshot(f.identity.id, PREVIOUS)).toEqual({
      ...f.identity,
      snapshot: previous,
    });
    expect(await readdir(f.directory)).toEqual(["kq-repository.json"]);
  });

  test.each(["id", "repository"])("rejects a mismatched repository identity %s", async (field) => {
    const f = await fixture();
    const identity = {
      ...f.identity,
      ...(field === "id" ? { id: "f".repeat(64) } : { repository: "public/different-repository" }),
    };
    await writeFile(f.paths.identity, JSON.stringify(identity));
    await expect(f.store.getSnapshot(f.identity.id, COMMIT)).rejects.toMatchObject({
      status: 500,
      message: "Corrupt recipe repository identity",
    });
  });

  test("rejects a snapshot whose commit differs from the requested filename", async () => {
    const f = await fixture();
    await writeFile(f.paths.snapshot, JSON.stringify({ ...f.snapshot, commit: PREVIOUS }));
    await expect(f.store.getSnapshot(f.identity.id, COMMIT)).rejects.toMatchObject({
      status: 500,
      message: "Corrupt recipe snapshot identity",
    });
  });

  test.each(METADATA)("rejects missing $name metadata", async ({ name }) => {
    const f = await fixture();
    await rm(f.paths[name]);
    await expect(f.store.getSnapshot(f.identity.id, COMMIT)).rejects.toMatchObject({
      status: 404,
      message: "Recipe snapshot not found",
    });
  });

  test("does not fall back to another commit when the requested snapshot is absent", async () => {
    const f = await fixture();
    await expect(f.store.getSnapshot(f.identity.id, PREVIOUS)).rejects.toMatchObject({
      status: 404,
      message: "Recipe snapshot not found",
    });
  });

  test.each(METADATA)("rejects a leaf symlink for $name metadata", async ({ name }) => {
    const f = await fixture();
    const target = join(f.root, `${name}-target.json`);
    await rename(f.paths[name], target);
    await symlink(target, f.paths[name]);
    await expect(f.store.getSnapshot(f.identity.id, COMMIT)).rejects.toMatchObject({
      status: 500,
    });
  });

  test.each(METADATA)("rejects a directory in place of $name metadata", async ({ name }) => {
    const f = await fixture();
    await rm(f.paths[name]);
    await mkdir(f.paths[name]);
    await expect(f.store.getSnapshot(f.identity.id, COMMIT)).rejects.toMatchObject({
      status: 500,
    });
  });

  test.each(METADATA)("accepts $name metadata at its exact byte limit", async ({ name, limit }) => {
    const f = await fixture();
    await writeFile(f.paths[name], f.contents[name].padEnd(limit, " "));
    expect(await f.store.getSnapshot(f.identity.id, COMMIT)).toEqual({
      ...f.identity,
      snapshot: f.snapshot,
    });
  });

  test.each(METADATA)("rejects oversized $name metadata before JSON parsing", async ({
    name,
    limit,
  }) => {
    const f = await fixture();
    await writeFile(f.paths[name], "x".repeat(limit + 1));
    await expect(f.store.getSnapshot(f.identity.id, COMMIT)).rejects.toMatchObject({
      status: 503,
      message: "Recipe metadata limit exceeded",
    });
  });

  test.each([1, 2])("honors cancellation at metadata checkpoint %i", async (stopAt) => {
    const f = await fixture();
    const reason = new Error("Snapshot read cancelled");
    let calls = 0;
    const checkpoint = () => {
      if (++calls === stopAt) throw reason;
    };
    await expect(f.store.getSnapshot(f.identity.id, COMMIT, checkpoint)).rejects.toBe(reason);
    expect(calls).toBe(stopAt);
    expect(await f.store.getSnapshot(f.identity.id, COMMIT)).toEqual({
      ...f.identity,
      snapshot: f.snapshot,
    });
  });
});
