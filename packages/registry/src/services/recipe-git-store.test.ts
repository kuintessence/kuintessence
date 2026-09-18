import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { createSpackRepositoryRoutes } from "../routes/spack-repositories";
import { RecipeGitStore } from "./recipe-git-store";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

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
