import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { spackMaterialCatalogPosition } from "@kuintessence/shared";
import { cleanupMaterials } from "../routes/spack-materials.test-helpers";
import { OTHER_ORG, SUPER, USER } from "../routes/spack-repositories.test-helpers";
import { withMaterialStorageLock } from "./spack-material-collection";
import { ACTOR, managementFixture, QUERY } from "./spack-material-management.test-helpers";
import { indexedMaterialDigests } from "./spack-material-name-index";
import { materialDigest } from "./spack-material-storage";
import { SpackMaterialStore } from "./spack-material-store";

afterEach(cleanupMaterials);

test("existing large repositories support indexed seek, restart, publication, purge and revocation", async () => {
  const f = await managementFixture();
  const original = f.bindings[0];
  if (!original) throw new Error("Missing binding");
  const id = original.repositoryId;
  const directory = join(f.root, "manifests", id);
  const indexPath = join(f.root, "catalog-index", id);
  const { manifest } = await f.store.getManifest(id, original.manifestDigest);
  const expected = [original.manifestDigest];
  for (let i = 0; i < 10_020; ++i) {
    const data = JSON.stringify({
      ...manifest,
      sources: [{ ...manifest.sources[0], path: `source-${i}.tar` }],
    });
    const digest = materialDigest(Buffer.from(data));
    writeFileSync(join(directory, `${digest.slice(7)}.json`), data);
    expected.push(digest);
  }
  expected.sort();
  const query = { repository: manifest.repository, limit: 8 };
  const first = await f.store.list(query, USER);
  expect(first.releases.map((x) => x.manifestDigest)).toEqual(expected.slice(0, 8));
  const info = await stat(indexPath);
  const restarted = new SpackMaterialStore(f.root, f.recipes, {}, undefined, f.port);
  const tail = expected.at(-8);
  if (!tail) throw new Error("Missing tail");
  const after = spackMaterialCatalogPosition({ repositoryId: id, manifestDigest: tail });
  // The child can seek while another process holds a shared lock, so it must reuse the index.
  const script = `
    const [module, root, id, after] = Bun.argv.slice(1);
    const { indexedMaterialDigests } = await import(module);
    for await (const digest of indexedMaterialDigests(root, id, after, () => {}, () => {}, () => Error("budget")))
      console.log("sha256:" + digest);
  `;
  await withMaterialStorageLock(f.root, false, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        script,
        new URL("./spack-material-name-index.ts", import.meta.url).href,
        f.root,
        id,
        tail.slice(7),
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim().split("\n")).toEqual(expected.slice(-7));
  });
  const last = await withMaterialStorageLock(f.root, false, () =>
    restarted.list({ ...query, after }, USER),
  );
  expect(last.releases.map((x) => x.manifestDigest)).toEqual(expected.slice(-7));
  expect(last.nextCursor).toBeUndefined();
  const recipeName = f.recipe.repository;
  f.recipe.repository = `org/${OTHER_ORG}/recipes`;
  expect(await restarted.list({ ...query, after }, USER)).toEqual({ releases: [] });
  f.recipe.repository = recipeName;
  expect((await f.list({ ...QUERY, limit: 8 })).releases.map((x) => x.manifestDigest)).toEqual(
    expected.slice(0, 8),
  );
  expect((await stat(indexPath)).ino).toBe(info.ino);

  const seen: string[] = [];
  for await (const digest of indexedMaterialDigests(
    f.root,
    id,
    undefined,
    () => {},
    () => {},
    () => new Error("scan budget"),
  ))
    seen.push(`sha256:${digest}`);
  expect(seen).toEqual(expected);

  const added = await Promise.all(
    [f.store, restarted].map((store, i) =>
      store.publish(
        {
          ...f.input,
          repository: manifest.repository,
          sources: f.input.sources.map((s) => ({ ...s, path: `concurrent-${i}.tar` })),
        },
        SUPER,
      ),
    ),
  );
  await expect(stat(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
  await withMaterialStorageLock(f.root, false, async () => {
    await expect(f.store.list(query, USER)).rejects.toMatchObject({ status: 503 });
  });
  expected.push(...added.map((b) => b.manifestDigest));
  expected.sort();
  for (const binding of added) {
    const prev = expected[expected.indexOf(binding.manifestDigest) - 1];
    const page = await restarted.list(
      {
        ...query,
        ...(prev
          ? { after: spackMaterialCatalogPosition({ repositoryId: id, manifestDigest: prev }) }
          : {}),
      },
      USER,
    );
    expect(page.releases[0]?.manifestDigest).toBe(binding.manifestDigest);
  }
  const removed = added[0];
  if (!removed) throw new Error("Missing published binding");
  f.control.withdrawn.add(removed.manifestDigest);
  const deleting = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.port.purgeWithdrawn = async (binding, _subject, _revision, remove) => {
    expect(f.control.withdrawn.has(binding.manifestDigest)).toBe(true);
    deleting.resolve();
    await resume.promise;
    await remove();
  };
  const purge = restarted.purgeWithdrawn(id, removed.manifestDigest, SUPER.sub, 1);
  await deleting.promise;
  try {
    await expect(
      f.store.publish({ ...f.input, repository: manifest.repository }, SUPER),
    ).rejects.toMatchObject({ status: 503 });
  } finally {
    resume.resolve();
    await purge;
  }
  await expect(stat(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
  const prev = expected[expected.indexOf(removed.manifestDigest) - 1];
  const result = await f.store.list(
    {
      ...query,
      ...(prev
        ? { after: spackMaterialCatalogPosition({ repositoryId: id, manifestDigest: prev }) }
        : {}),
    },
    USER,
  );
  expect(result.releases.map((x) => x.manifestDigest)).toEqual(
    expected.slice(
      expected.indexOf(removed.manifestDigest) + 1,
      expected.indexOf(removed.manifestDigest) + 9,
    ),
  );
  f.control.canonical = { ...ACTOR, role: "user" };
  await expect(f.list()).rejects.toMatchObject({ status: 403 });

  // Corruption in a seek block must not turn into an empty successful page.
  const file = await open(indexPath, "r+");
  try {
    const byte = Buffer.alloc(1);
    await file.read(byte, 0, 1, 256);
    byte[0] = (byte[0] ?? 0) ^ 1;
    await file.write(byte, 0, 1, 256);
  } finally {
    await file.close();
  }
  await expect(restarted.list(query, USER)).rejects.toMatchObject({ status: 503 });
  await expect(stat(indexPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await restarted.list(query, USER)).releases).toHaveLength(query.limit);
}, 120_000);
