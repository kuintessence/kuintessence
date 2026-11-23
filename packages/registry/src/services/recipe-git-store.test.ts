import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RecipeRepositorySchema } from "@kuintessence/shared";
import { Hono } from "hono";
import { cleanupMaterials, materialFixture } from "../routes/spack-materials.test-helpers";
import { createSpackRepositoryRoutes } from "../routes/spack-repositories";
import { BASE, headers, ORG, OWNER, SUPER } from "../routes/spack-repositories.test-helpers";
import { RecipeGitStore } from "./recipe-git-store";
import { withMaterialStorageLock } from "./spack-material-collection";
import { materialDigest } from "./spack-material-storage";
import { SpackMaterialStore } from "./spack-material-store";
import { SpackUpstreamImportService } from "./spack-upstream-import";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(cleanupMaterials);
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function observe<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Test operation did not settle")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-recipe-test-"));
  directories.push(root);
  const source = join(root, "source");
  await mkdir(source);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Recipe Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Recipe Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  async function git(...args: string[]) {
    return (await exec("git", ["-C", source, ...args], { env })).stdout.trim();
  }
  await git("init", "--template=");
  await git("symbolic-ref", "HEAD", "refs/heads/main");
  await mkdir(join(source, "spack_repo/science/packages/hello"), { recursive: true });
  await writeFile(
    join(source, "spack_repo/science/repo.yaml"),
    "repo:\n  namespace: science\n  api: v2.0\n",
  );
  await writeFile(
    join(source, "spack_repo/science/packages/hello/package.py"),
    'from spack.package import *\nclass Hello(Package):\n    version("1.0", sha256="' +
      "a".repeat(64) +
      '")\n',
  );
  let version = 0;
  async function bundle() {
    await git("add", ".");
    await git("commit", "-m", `snapshot ${++version}`);
    const path = join(root, `recipes-${version}.bundle`);
    await git("bundle", "create", path, "HEAD");
    return { bytes: new Uint8Array(await readFile(path)), commit: await git("rev-parse", "HEAD") };
  }
  return { root, source, git, bundle, store: new RecipeGitStore(join(root, "store")) };
}

describe("RecipeGitStore", () => {
  test("grants apply to a single repository and queued writes recheck revocation", async () => {
    const f = await fixture();
    const bundle = await f.bundle();
    const source = await f.store.importBundle(`org/${ORG}/recipes`, bundle.bytes, OWNER.sub);
    await f.store.importBundle(`org/${ORG}/another`, bundle.bytes, OWNER.sub);
    const subject = "55555555-5555-4555-8555-555555555555";
    const guest = { sub: subject, role: "org_admin" as const, orgIds: [] };
    const app = new Hono().route(
      "/api",
      createSpackRepositoryRoutes(f.store, { allowTestHeader: true }),
    );
    const base = `${BASE}/${source.id}`;
    const grant = (access: "read" | "write") =>
      app.request(`${base}/grants`, {
        method: "PUT",
        headers: headers(OWNER),
        body: JSON.stringify({ subject, access }),
      });
    const upload = (actor = guest) =>
      app.request(`${BASE}/import?repository=${encodeURIComponent(source.repository)}`, {
        method: "POST",
        headers: headers(actor, "application/octet-stream"),
        body: bundle.bytes,
      });
    expect((await app.request(base, { headers: headers(guest) })).status).toBe(404);
    expect((await grant("read")).status).toBe(200);
    const visible = await (await app.request(BASE, { headers: headers(guest) })).json();
    expect(visible).toEqual({ repositories: [source] });
    expect((await upload()).status).toBe(403);
    expect((await grant("write")).status).toBe(200);
    expect((await app.request(base, { headers: headers(guest) })).status).toBe(200);
    expect(await (await upload()).json()).toMatchObject({ id: source.id, delegatedWrite: true });
    expect((await app.request(`${base}/grants`, { headers: headers(guest) })).status).toBe(403);
    expect(
      (await app.request(`${base}/migrate`, { method: "POST", headers: headers(guest) })).status,
    ).toBe(403);
    expect(
      (
        await app.request(`${base}/snapshots/${bundle.commit}`, {
          method: "DELETE",
          headers: headers(guest),
        })
      ).status,
    ).toBe(403);
    const regular = { ...guest, role: "user" as const };
    expect(
      (await app.request(`${base}/active`, { method: "PUT", headers: headers(regular) })).status,
    ).toBe(403);
    const tar = await app.request(`${base}/snapshots/${bundle.commit}/archive`, {
      headers: headers(regular),
    });
    expect(tar.status).toBe(200);
    await tar.arrayBuffer();
    const restarted = new RecipeGitStore(f.store.root);
    expect(await restarted.grants(source.id)).toEqual([{ subject, access: "write" }]);
    const revoke = restarted.setGrant(source.id, subject, null);
    const activation = restarted.activate(source.id, bundle.commit, null, subject, true);
    await expect(activation).rejects.toMatchObject({ status: 403 });
    await revoke;
    expect((await app.request(base, { headers: headers(guest) })).status).toBe(404);
    expect(
      (
        await app.request(`${base}/grants/${subject}`, {
          method: "DELETE",
          headers: headers(OWNER),
        })
      ).status,
    ).toBe(200);
  });

  test("migration preserves material bindings, export bytes and history; collection checks the material lock and Git reachability", async () => {
    const f = await fixture();
    const first = await f.bundle();
    const name = `org/${ORG}/science`;
    const source = await f.store.importBundle(name, first.bytes, OWNER.sub);
    const m = await materialFixture({}, source);
    await m.seed();
    const materials = new SpackMaterialStore(m.root, f.store);
    const binding = await materials.publish(
      {
        ...m.input,
        recipes: [{ repositoryId: source.id, commit: first.commit, roots: ["spack_repo/science"] }],
      },
      OWNER,
    );
    const stored = await materials.getManifest(binding.repositoryId, binding.manifestDigest);
    const bytes = async (id: string) =>
      new Uint8Array(
        await new Response((await f.store.archive(id, first.commit)).stream).arrayBuffer(),
      );
    const before = await bytes(source.id);
    await writeFile(join(f.source, "README.md"), "second");
    const second = await f.bundle();
    await f.store.importBundle(name, second.bytes, OWNER.sub);
    const active = await f.store.activate(source.id, second.commit, null, OWNER.sub);
    await f.store.setGrant(source.id, "55555555-5555-4555-8555-555555555555", "read");
    const app = new Hono().route(
      "/api",
      createSpackRepositoryRoutes(f.store, { allowTestHeader: true }, materials),
    );
    const move = (repository: string, consent = false, actor = SUPER) =>
      app.request(`${BASE}/${source.id}/migrate`, {
        method: "POST",
        headers: headers(actor),
        body: JSON.stringify({
          repository,
          ...(consent ? { acknowledgePublicHistory: true } : {}),
        }),
      });
    const remove = (id: string, commit: string) =>
      app.request(`${BASE}/${id}/snapshots/${commit}`, {
        method: "DELETE",
        headers: headers(SUPER),
      });
    expect((await move("public/science", true, OWNER)).status).toBe(403);
    expect((await move("public/science")).status).toBe(422);
    await f.store.importBundle("public/existing", first.bytes, SUPER.sub);
    expect((await move("public/existing", true)).status).toBe(409);
    expect((await remove(source.id, second.commit)).status).toBe(409);
    const moved = await move("public/science", true);
    expect(moved.status).toBe(200);
    const target = RecipeRepositorySchema.parse(await moved.json());
    expect(target).toMatchObject({
      id: RecipeGitStore.repositoryId("public/science"),
      snapshots: active.snapshots,
      activeCommit: second.commit,
    });
    expect(await (await move("public/science", true)).json()).toEqual(target);
    expect(await f.store.grants(target.id)).toEqual([]);
    expect(await f.store.get(source.id)).toMatchObject({ migrated: true, activeCommit: null });
    await expect(f.store.importBundle(name, second.bytes, SUPER.sub)).rejects.toMatchObject({
      status: 409,
    });
    expect(await bytes(source.id)).toEqual(before);
    expect(await bytes(target.id)).toEqual(before);
    expect(
      (await materials.getManifest(binding.repositoryId, binding.manifestDigest)).bytes,
    ).toEqual(stored.bytes);
    const protectedSnapshot = await remove(source.id, first.commit);
    expect(protectedSnapshot.status).toBe(409);
    expect(await protectedSnapshot.json()).toMatchObject({
      error: { code: "RECIPE_SNAPSHOT_IN_USE" },
    });
    const materialTar = await materials.getBlob(
      binding.repositoryId,
      binding.manifestDigest,
      materialDigest(before),
      OWNER,
    );
    expect(new Uint8Array(await new Response(materialTar.stream).arrayBuffer())).toEqual(before);
    await withMaterialStorageLock(m.root, false, async () => {
      expect((await remove(source.id, second.commit)).status).toBe(503);
    });
    const outstanding = await f.store.archive(source.id, second.commit);
    expect((await remove(source.id, second.commit)).status).toBe(204);
    expect((await new Response(outstanding.stream).arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await remove(source.id, second.commit)).status).toBe(204);
    await expect(f.store.getSnapshot(source.id, second.commit)).rejects.toMatchObject({
      status: 404,
    });
    const bare = join(f.store.root, "repositories", `${source.id}.git`);
    await expect(exec("git", ["-C", bare, "cat-file", "-e", second.commit])).rejects.toThrow();
    expect(
      (await exec("git", ["-C", bare, "rev-list", "--count", "refs/kq/audit/head"])).stdout.trim(),
    ).toBe("2");
    expect(await bytes(source.id)).toEqual(before);
    expect((await f.store.get(target.id)).activeCommit).toBe(second.commit);
  });

  test("a restart finishes an interrupted migration before another write", async () => {
    const f = await fixture();
    const first = await f.bundle();
    const source = await f.store.importBundle("user/alice/recipes", first.bytes, "alice");
    await f.store.activate(source.id, first.commit, null, "alice");
    const lock = join(f.store.root, "repositories", `${source.id}.git`, "refs/kq/audit/head.lock");
    await writeFile(lock, "");
    await expect(f.store.migrate(source.id, "public/new", "alice")).rejects.toMatchObject({
      status: 409,
    });
    await rm(lock);
    const restarted = new RecipeGitStore(f.store.root);
    await expect(
      restarted.importBundle(source.repository, first.bytes, "alice"),
    ).rejects.toMatchObject({ status: 409 });
    expect(await restarted.migrate(source.id, "public/new", "alice")).toMatchObject({
      activeCommit: first.commit,
    });
    expect(await restarted.get(source.id)).toMatchObject({ migrated: true, activeCommit: null });
    expect(await readdir(join(f.store.root, "staging"))).toEqual([]);
  });

  test("online imports persist a real Git bundle and preserve post-commit cancellation", async () => {
    const f = await fixture();
    const bundle = await f.bundle();
    const controller = new AbortController();
    const service = new SpackUpstreamImportService({
      recipeStore: f.store,
      downloader: {
        async withDownload(input, signal, consume) {
          expect(input.digest).toBe(materialDigest(bundle.bytes));
          expect(input.size).toBe(bundle.bytes.byteLength);
          signal.throwIfAborted();
          return consume(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(bundle.bytes);
                stream.close();
              },
            }),
          );
        },
      },
    });
    const input = {
      kind: "recipe" as const,
      repository: "public/science",
      url: "https://sources.example.org/science.bundle",
      digest: materialDigest(bundle.bytes),
      size: bundle.bytes.byteLength,
    };
    const actor = { sub: "publisher", role: "super_admin" as const, orgIds: [] };
    const originalGet = f.store.get.bind(f.store);
    const receiptRead = spyOn(f.store, "get").mockImplementation(async (id) => {
      const result = await originalGet(id);
      controller.abort();
      return result;
    });
    try {
      await expect(service.import(input, actor, controller.signal)).rejects.toMatchObject({
        status: 409,
        code: "UPSTREAM_IMPORT_RESULT_UNKNOWN",
      });
    } finally {
      receiptRead.mockRestore();
    }
    const stored = await f.store.get(RecipeGitStore.repositoryId(input.repository));
    expect(stored.activeCommit).toBeNull();
    expect(stored.snapshots).toHaveLength(1);
    expect(stored.snapshots[0]?.commit).toBe(bundle.commit);
    expect(stored.snapshots[0]?.bundleSha256).toBe(input.digest.slice(7));
    expect(await readdir(join(f.root, "store/staging"))).toEqual([]);
    const retry = await service.import(input, actor, new AbortController().signal);
    expect(retry).toEqual({ kind: "recipe", repository: stored });
  });

  test("cancelled queue entries retain admission until the blocked write retires", async () => {
    const f = await fixture();
    const bundle = await f.bundle();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalGet = f.store.get.bind(f.store);
    const receiptRead = spyOn(f.store, "get").mockImplementationOnce(async (id) => {
      entered.resolve();
      await release.promise;
      return originalGet(id);
    });
    const first = f.store.importBundle("public/science", bundle.bytes, "admin");
    const firstOutcome = observe(first);
    try {
      await within(entered.promise);
      for (let index = 0; index < 3; index++) {
        const controller = new AbortController();
        const queued = Promise.withResolvers<void>();
        const input = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(bundle.bytes);
            stream.close();
          },
        });
        const addListener = controller.signal.addEventListener.bind(controller.signal);
        const listener = spyOn(controller.signal, "addEventListener").mockImplementation(
          (type, callback, options) => {
            addListener(type, callback, options);
            // Staging owns the reader; the queue installs its listener only after releaseLock().
            if (type === "abort" && !input.locked) queued.resolve();
          },
        );
        const pending = f.store.importBundle("public/science", input, "admin", controller.signal);
        const outcome = observe(pending);
        try {
          await within(queued.promise);
        } finally {
          controller.abort();
          listener.mockRestore();
          await within(outcome);
        }
        expect(await outcome).toMatchObject({ status: "rejected", reason: expect.any(Error) });
      }
      const rejected = observe(f.store.importBundle("public/science", bundle.bytes, "admin"));
      expect(await within(rejected)).toMatchObject({
        status: "rejected",
        reason: { status: 429 },
      });
    } finally {
      release.resolve();
      try {
        await within(firstOutcome);
      } finally {
        receiptRead.mockRestore();
      }
    }
    expect(await firstOutcome).toMatchObject({ status: "fulfilled" });
    await f.store.list();
    expect(
      (await f.store.importBundle("public/science", bundle.bytes, "admin")).snapshots,
    ).toHaveLength(1);
  });

  test("pre-cancelled imports never create a repository", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.store.importBundle("public/science", new Uint8Array([1]), "admin", controller.signal),
    ).rejects.toThrow();
    expect(await f.store.list()).toEqual([]);
  });

  test("cancellation while staging closes the source and leaves no snapshot", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const cancel = mock(() => {});
    const input = new ReadableStream<Uint8Array>(
      {
        pull() {
          entered.resolve();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const pending = f.store.importBundle("public/science", input, "admin", controller.signal);
    const outcome = observe(pending);
    try {
      await within(entered.promise);
    } finally {
      controller.abort();
      await within(outcome);
    }
    expect(await outcome).toMatchObject({ status: "rejected", reason: expect.any(Error) });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await f.store.list()).toEqual([]);
    expect(await readdir(join(f.root, "store/staging"))).toEqual([]);
    const bundle = await f.bundle();
    expect(
      (await f.store.importBundle("public/science", bundle.bytes, "admin")).snapshots,
    ).toHaveLength(1);
  });

  test("starts empty and persists a complete native repository without executing recipes", async () => {
    const f = await fixture();
    expect(await f.store.list()).toEqual([]);
    await writeFile(
      join(f.source, "spack_repo/science/packages/hello/helper.patch"),
      "--- a/hello\n+++ b/hello\n",
    );
    const bundle = await f.bundle();
    const imported = await f.store.importBundle("public/science", bundle.bytes, "admin");
    expect(imported.activeCommit).toBeNull();
    expect(imported.snapshots).toHaveLength(1);
    expect(imported.snapshots[0]?.commit).toBe(bundle.commit);
    expect(imported.snapshots[0]?.fileCount).toBe(3);
    expect(imported.snapshots[0]?.validation).toBe("static-only");
    expect(imported.snapshots[0]?.roots[0]?.namespace).toBe("science");
    const restarted = new RecipeGitStore(join(f.root, "store"));
    expect(await restarted.get(imported.id)).toEqual(imported);
    expect(await readdir(join(f.root, "store/staging"))).toEqual([]);
  });

  test("repeated imports are idempotent and cannot change active state", async () => {
    const f = await fixture();
    const bundle = await f.bundle();
    const first = await f.store.importBundle("public/science", bundle.bytes, "admin");
    await f.store.activate(first.id, bundle.commit, null, "admin");
    const repeated = await f.store.importBundle("public/science", bundle.bytes, "another-admin");
    expect(repeated.activeCommit).toBe(bundle.commit);
    expect(repeated.snapshots).toEqual(first.snapshots);
  });

  test("resolves snapshots from explicit refs, never a preexisting FETCH_HEAD", async () => {
    const f = await fixture();
    const first = await f.bundle();
    const repository = await f.store.importBundle("public/science", first.bytes, "admin");
    await f.store.activate(repository.id, first.commit, null, "admin");
    const directory = join(f.root, "store/repositories", `${repository.id}.git`);
    await writeFile(join(directory, "FETCH_HEAD"), "invalid prior fetch metadata\n");
    await writeFile(join(f.source, "README.md"), "second snapshot");
    const second = await f.bundle();
    const updated = await f.store.importBundle("public/science", second.bytes, "admin");
    expect(updated.activeCommit).toBe(first.commit);
    expect(updated.snapshots.map((snapshot) => snapshot.commit)).toContain(second.commit);
    const archive = await f.store.archive(repository.id, first.commit);
    const text = new TextDecoder().decode(await new Response(archive.stream).arrayBuffer());
    expect(text).toContain("spack_repo/science/repo.yaml");
    expect(text).not.toContain("second snapshot");
  });

  test("activation uses compare-and-swap and preserves history on rollback or deactivation", async () => {
    const f = await fixture();
    const first = await f.bundle();
    const repository = await f.store.importBundle("org/provider/science", first.bytes, "operator");
    await f.store.activate(repository.id, first.commit, null, "operator");
    await writeFile(join(f.source, "README.md"), "updated recipes");
    const second = await f.bundle();
    await f.store.importBundle("org/provider/science", second.bytes, "operator");
    await expect(
      f.store.activate(repository.id, second.commit, null, "operator"),
    ).rejects.toMatchObject({ status: 409 });
    await f.store.activate(repository.id, second.commit, first.commit, "operator");
    await f.store.activate(repository.id, first.commit, second.commit, "operator");
    await f.store.deactivate(repository.id, first.commit, "operator");
    const result = await f.store.get(repository.id);
    expect(result.activeCommit).toBeNull();
    expect(result.snapshots).toHaveLength(2);
    const directory = join(f.root, "store/repositories", `${repository.id}.git`);
    const audit = await exec("git", ["-C", directory, "rev-list", "refs/kq/audit/head"]);
    const events = audit.stdout.trim().split("\n");
    expect(events).toHaveLength(4);
    const latest = JSON.parse(
      (await exec("git", ["-C", directory, "show", "refs/kq/audit/head:event.json"])).stdout,
    );
    expect(latest).toMatchObject({
      action: "deactivate",
      actor: "operator",
      previousActiveCommit: first.commit,
      activeCommit: null,
      previousEvent: events[1],
    });
    const previous = JSON.parse(
      (await exec("git", ["-C", directory, "show", `${events[1]}:event.json`])).stdout,
    );
    expect(previous).toMatchObject({
      action: "activate",
      previousActiveCommit: second.commit,
      activeCommit: first.commit,
      previousEvent: events[2],
    });
  });

  test("audit ref lock failure prevents partial activation and deactivation", async () => {
    const f = await fixture();
    const bundle = await f.bundle();
    const repository = await f.store.importBundle("public/science", bundle.bytes, "admin");
    const auditDirectory = join(f.root, "store/repositories", `${repository.id}.git/refs/kq/audit`);
    await mkdir(auditDirectory, { recursive: true });
    const lock = join(auditDirectory, "head.lock");
    await writeFile(lock, "");
    await expect(
      f.store.activate(repository.id, bundle.commit, null, "admin"),
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.store.get(repository.id)).activeCommit).toBeNull();
    expect(await readdir(auditDirectory)).toEqual(["head.lock"]);
    await rm(lock);
    await f.store.activate(repository.id, bundle.commit, null, "admin");
    const auditBefore = await readFile(join(auditDirectory, "head"), "utf8");
    await writeFile(lock, "");
    await expect(f.store.deactivate(repository.id, bundle.commit, "admin")).rejects.toMatchObject({
      status: 409,
    });
    expect((await f.store.get(repository.id)).activeCommit).toBe(bundle.commit);
    expect(await readFile(join(auditDirectory, "head"), "utf8")).toBe(auditBefore);
    await rm(lock);
    const deactivated = await f.store.deactivate(repository.id, bundle.commit, "admin");
    expect(deactivated.activeCommit).toBeNull();
  });

  test("rejects invalid bundles, paths, symlinks and resource overruns without publication", async () => {
    const f = await fixture();
    await expect(
      f.store.importBundle("public/../escape", new Uint8Array([1]), "admin"),
    ).rejects.toThrow();
    await expect(
      f.store.importBundle("public/science", new Uint8Array([1, 2, 3]), "admin"),
    ).rejects.toThrow();
    await symlink("/etc/passwd", join(f.source, "escape"));
    const bundle = await f.bundle();
    await expect(
      f.store.importBundle("public/science", bundle.bytes, "admin"),
    ).rejects.toMatchObject({ status: 422 });
    expect(await f.store.list()).toEqual([]);
    const limited = new RecipeGitStore(join(f.root, "limited"), { maxBundleBytes: 2 });
    await expect(
      limited.importBundle("public/science", bundle.bytes, "admin"),
    ).rejects.toMatchObject({ status: 413 });
    expect(await readdir(join(f.root, "store/staging"))).toEqual([]);
  });

  test("keeps structurally invalid snapshots staged and refuses activation", async () => {
    const f = await fixture();
    await writeFile(join(f.source, "spack_repo/science/repo.yaml"), "repo: [bad]");
    const bundle = await f.bundle();
    const result = await f.store.importBundle("user/operator/science", bundle.bytes, "operator");
    expect(result.snapshots[0]?.diagnostics.some((item) => item.severity === "error")).toBe(true);
    await expect(
      f.store.activate(result.id, bundle.commit, null, "operator"),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("rolls back only the new snapshot ref when manifest publication fails", async () => {
    const f = await fixture();
    const first = await f.bundle();
    const repository = await f.store.importBundle("public/science", first.bytes, "admin");
    await f.store.activate(repository.id, first.commit, null, "admin");
    await writeFile(join(f.source, "README.md"), "second snapshot");
    const second = await f.bundle();
    const manifest = join(f.root, "store/manifests", repository.id, `${second.commit}.json`);
    await mkdir(manifest);
    await expect(
      f.store.importBundle("public/science", second.bytes, "admin"),
    ).rejects.toMatchObject({ status: 500 });
    const refs = (
      await exec("git", [
        "-C",
        join(f.root, "store/repositories", `${repository.id}.git`),
        "for-each-ref",
        "--format=%(refname)",
        "refs/kq/snapshots/",
      ])
    ).stdout;
    expect(refs).toContain(first.commit);
    expect(refs).not.toContain(second.commit);
    await rm(manifest, { recursive: true });
    expect((await f.store.get(repository.id)).activeCommit).toBe(first.commit);
    expect((await f.store.get(repository.id)).snapshots).toHaveLength(1);
    expect(await readdir(join(f.root, "store/staging"))).toEqual([]);
    expect(
      (await f.store.importBundle("public/science", second.bytes, "admin")).snapshots,
    ).toHaveLength(2);
  });

  test("exports only an imported commit and isolates repository identities", async () => {
    const f = await fixture();
    const bundle = await f.bundle();
    const first = await f.store.importBundle("public/science", bundle.bytes, "admin");
    const second = await f.store.importBundle("org/provider/science", bundle.bytes, "admin");
    expect(first.id).not.toBe(second.id);
    const archive = await f.store.archive(first.id, bundle.commit);
    expect(new TextDecoder().decode(await new Response(archive.stream).arrayBuffer())).toContain(
      "spack_repo/science/repo.yaml",
    );
    await expect(f.store.archive(first.id, "f".repeat(40))).rejects.toMatchObject({ status: 404 });
    await expect(f.store.get("../escape")).rejects.toMatchObject({ status: 400 });
  });

  test("exported snapshots retain all recipe files regardless of uploaded Git attributes", async () => {
    const f = await fixture();
    await writeFile(join(f.source, ".gitattributes"), "* export-ignore export-subst\n");
    const bundle = await f.bundle();
    const repository = await f.store.importBundle("public/science", bundle.bytes, "admin");
    const archive = await f.store.archive(repository.id, bundle.commit);
    const text = new TextDecoder().decode(await new Response(archive.stream).arrayBuffer());
    expect(text.includes("spack_repo/science/packages/hello/package.py")).toBe(true);
    expect(text.includes("class Hello(Package)")).toBe(true);
  });

  test("limits pending exports and releases staging files on cancellation", async () => {
    const f = await fixture();
    const bundle = await f.bundle();
    const repository = await f.store.importBundle("public/science", bundle.bytes, "admin");
    const archives = await Promise.all(
      Array.from({ length: 4 }, () => f.store.archive(repository.id, bundle.commit)),
    );
    await expect(f.store.archive(repository.id, bundle.commit)).rejects.toMatchObject({
      status: 429,
    });
    await Promise.all(archives.map((archive) => archive.stream.cancel()));
    expect(await readdir(join(f.root, "store/staging"))).toEqual([]);
    const retry = await f.store.archive(repository.id, bundle.commit);
    await retry.stream.cancel();
    expect(await readdir(join(f.root, "store/staging"))).toEqual([]);
  });

  test("serves the real raw upload, activation and authenticated archive lifecycle without a server", async () => {
    const f = await fixture();
    const bundle = await f.bundle();
    const app = new Hono();
    app.route("/api", createSpackRepositoryRoutes(f.store, { allowTestHeader: true }));
    const headers = {
      "X-Test-Principal": JSON.stringify({
        sub: "operator",
        role: "platform_admin",
        orgIds: [],
      }),
      "Content-Type": "application/octet-stream",
    };
    const uploaded = await app.request(
      "/api/spack/recipe-repositories/import?repository=public%2Fscience",
      {
        method: "POST",
        headers,
        body: bundle.bytes,
      },
    );
    expect(uploaded.status).toBe(201);
    const repository = await f.store.get(RecipeGitStore.repositoryId("public/science"));
    const activated = await app.request(`/api/spack/recipe-repositories/${repository.id}/active`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        commit: bundle.commit,
        expectedActiveCommit: null,
        acknowledgeExecutableRecipes: true,
      }),
    });
    expect(activated.status).toBe(200);
    expect((await f.store.get(repository.id)).activeCommit).toBe(bundle.commit);
    const path = `/api/spack/recipe-repositories/${repository.id}/snapshots/${bundle.commit}/archive`;
    expect((await app.request(path)).status).toBe(401);
    const archive = await app.request(path, { headers });
    expect(archive.status).toBe(200);
    expect(archive.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await archive.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(await readdir(join(f.root, "store/staging"))).toEqual([]);
  });
});
