import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { SpackInstallRecordSchema, type SpackInstallReport } from "./install-contract";
import { SpackInstallStore } from "./install-store";

const input = {
  manifestDigest: `sha256:${"a".repeat(64)}`,
  manifestSize: 120,
  siteProfileDigest: `sha256:${"b".repeat(64)}`,
  spec: "zlib@1.3.1",
  rootHash: "a".repeat(32),
};
let base: string;
let root: string;
let store: SpackInstallStore;
const recordPath = (id: string) => join(root, "records", `${id}.json`);
const mode = async (path: string) => (await lstat(path)).mode & 0o777;
const create = () => store.withLock(() => store.create(input));
function report(id: string): SpackInstallReport {
  return {
    version: 1,
    validation: "isolated-install",
    action: "verify",
    manifestDigest: input.manifestDigest,
    siteProfileDigest: input.siteProfileDigest,
    storePath: store.path(id),
    prefix: `${store.path(id)}/zlib`,
    root: { name: "zlib", version: "1.3.1", spec: input.spec, hash: input.rootHash },
    installedHashes: [input.rootHash],
  };
}
beforeEach(async () => {
  base = await mkdtemp(join(await realpath("/tmp"), "install-store-"));
  root = join(base, "store");
  store = new SpackInstallStore(root);
  await store.initialize();
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("SpackInstallStore transaction lifecycle", () => {
  test("enforces the complete transition matrix, including recovery through failed", async () => {
    const allowed = {
      building: ["building", "verifying", "failed"],
      verifying: ["verifying", "ready", "failed"],
      ready: ["ready", "unavailable", "removing"],
      unavailable: ["unavailable", "ready", "removing"],
      failed: ["failed", "removing"],
      removing: ["removing", "removed"],
      removed: ["removed"],
    };
    const record = await create();
    const states = SpackInstallRecordSchema.shape.state.options;
    await store.withLock(async () => {
      for (const from of states) {
        for (const to of states) {
          const previous = { ...record, state: from, report: report(record.id) };
          await writeFile(recordPath(record.id), JSON.stringify(previous));
          const update = store.save({ ...previous, state: to });
          if (allowed[from].includes(to)) await update;
          else await expect(update).rejects.toThrow();
          expect((await store.list())[0]?.state).toBe(allowed[from].includes(to) ? to : from);
        }
      }
    });
  });

  test("rejects create input outside the exact identity fields", async () => {
    await store.withLock(async () => {
      for (const extra of [{ state: "ready" }, { id: randomUUID() }, { extra: true }]) {
        await expect(store.create({ ...input, ...extra })).rejects.toThrow();
      }
      expect(await store.list()).toEqual([]);
      expect(await readdir(join(root, "releases"))).toEqual([]);
    });
  });

  test("atomically replaces records and rejects oversized UTF-8 without damaging prior bytes", async () => {
    const record = await create();
    const before = await lstat(recordPath(record.id));
    await store.withLock(async () => {
      const verifying = { ...record, state: "verifying" as const };
      await store.save(verifying);
      expect((await lstat(recordPath(record.id))).ino).not.toBe(before.ino);
      const bytes = await readFile(recordPath(record.id), "utf8");
      const large = report(record.id);
      large.root.name = "\u4e00".repeat(700_000);
      await expect(store.save({ ...verifying, report: large })).rejects.toThrow();
      expect(await readFile(recordPath(record.id), "utf8")).toBe(bytes);
      expect(await readdir(join(root, "records"))).toEqual([`${record.id}.json`]);
    });
  });

  test("persists private records and unpublished releases across restart", async () => {
    const record = await create();
    expect(record).toMatchObject({ ...input, state: "building", version: 1 });
    expect(store.path(record.id)).toBe(join(root, "releases", record.id));
    expect(await mode(join(root, "releases"))).toBe(0o755);
    expect(await mode(join(root, "records"))).toBe(0o700);
    expect(await mode(store.path(record.id))).toBe(0o700);
    expect(await mode(recordPath(record.id))).toBe(0o600);
    const restarted = new SpackInstallStore(root);
    await restarted.initialize();
    expect(await restarted.list()).toEqual([record]);
    expect(await readdir(join(root, "records"))).toEqual([`${record.id}.json`]);
  });

  test("publishes after verification, then removes only the UUID tree", async () => {
    await store.withLock(async () => {
      const record = await store.create(input);
      await expect(store.publishFiles(record.id)).rejects.toThrow();
      await expect(store.removeFiles(record.id)).rejects.toThrow();
      record.state = "verifying";
      await store.save(record);
      await mkdir(join(store.path(record.id), "zlib"));
      await store.publishFiles(record.id);
      expect(await mode(store.path(record.id))).toBe(0o755);
      record.state = "ready";
      record.report = report(record.id);
      await store.save(record);
      await expect(store.removeFiles(record.id)).rejects.toThrow();
      record.state = "removing";
      await store.save(record);
      await writeFile(join(base, "outside"), "keep");
      await symlink(base, join(store.path(record.id), "outside"));
      await store.removeFiles(record.id);
      await store.removeFiles(record.id);
      record.state = "removed";
      await store.save(record);
      expect(await readFile(join(base, "outside"), "utf8")).toBe("keep");
      expect((await store.list())[0]?.state).toBe("removed");
    });
  });

  test("rejects illegal transitions and identity changes without replacing the record", async () => {
    const record = await create();
    await store.withLock(async () => {
      for (const state of ["ready", "removing", "removed"] as const) {
        await expect(store.save({ ...record, state })).rejects.toThrow();
      }
      for (const change of [
        { manifestDigest: `sha256:${"c".repeat(64)}` },
        { manifestSize: 121 },
        { siteProfileDigest: `sha256:${"c".repeat(64)}` },
        { spec: "other@1" },
        { rootHash: "b".repeat(32) },
        { id: randomUUID() },
      ])
        await expect(store.save({ ...record, ...change })).rejects.toThrow();
      await store.save(record);
      expect(await store.list()).toEqual([record]);
      await store.save({ ...record, state: "failed" });
      await expect(store.save({ ...record, state: "building" })).rejects.toThrow();
      await store.removeFiles(record.id);
      expect(await readdir(join(root, "releases"))).toEqual([]);
      await store.save({ ...record, state: "removing" });
      await store.removeFiles(record.id);
      await store.save({ ...record, state: "removed" });
    });
  });

  test("requires a strictly bound verify report for ready", async () => {
    const record = await create();
    await store.withLock(async () => {
      await store.save({ ...record, state: "verifying" });
      const valid = report(record.id);
      for (const invalid of [
        undefined,
        { ...valid, action: "install" as const },
        { ...valid, action: "load" as const, loadShell: "" },
        {
          ...valid,
          root: { ...valid.root, hash: "b".repeat(32) },
          installedHashes: ["b".repeat(32)],
        },
        { ...valid, root: { ...valid.root, spec: "zlib@2" } },
        { ...valid, manifestDigest: `sha256:${"c".repeat(64)}` },
        { ...valid, siteProfileDigest: `sha256:${"c".repeat(64)}` },
        { ...valid, storePath: `${root}/other`, prefix: `${root}/other/zlib` },
      ])
        await expect(store.save({ ...record, state: "ready", report: invalid })).rejects.toThrow();
      await store.publishFiles(record.id);
      await store.save({ ...record, state: "ready", report: valid });
    });
  });
});

describe("writer lock", () => {
  test("requires the owning async context and refuses same-instance reentry", async () => {
    const record = await create();
    await expect(store.create(input)).rejects.toThrow();
    await expect(store.save(record)).rejects.toThrow();
    await expect(store.removeFiles(record.id)).rejects.toThrow();
    await expect(store.publishFiles(record.id)).rejects.toThrow();
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = store.withLock(async () => {
      entered();
      await expect(store.withLock(async () => {})).rejects.toThrow();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started;
    await expect(store.create(input)).rejects.toThrow();
    release();
    await held;
  });

  test("does not steal another writer or a stale lock, and cleans up after errors", async () => {
    const other = new SpackInstallStore(root);
    await store.withLock(async () => {
      await expect(other.withLock(async () => {})).rejects.toThrow();
      expect((await lstat(join(root, ".writer-lock"))).isDirectory()).toBe(true);
    });
    await expect(
      store.withLock(async () => {
        throw new Error("fixture");
      }),
    ).rejects.toThrow("fixture");
    expect(await other.withLock(async () => 42)).toBe(42);
    await mkdir(join(root, ".writer-lock"));
    await expect(store.withLock(async () => {})).rejects.toThrow();
    expect((await lstat(join(root, ".writer-lock"))).isDirectory()).toBe(true);
  });

  test("does not delete a replacement lock", async () => {
    await store.withLock(async () => {
      await rename(join(root, ".writer-lock"), join(root, "old-lock"));
      await mkdir(join(root, ".writer-lock"));
      await expect(store.create(input)).rejects.toThrow();
    });
    expect((await lstat(join(root, ".writer-lock"))).isDirectory()).toBe(true);
  });
});

describe("filesystem boundary", () => {
  test.skipIf(process.getuid?.() !== 0)(
    "rejects foreign-owner files, releases and ancestors",
    async () => {
      const record = await create();
      await store.withLock(async () => {
        await chown(recordPath(record.id), 1, -1);
        await expect(store.list()).rejects.toThrow();
        await expect(store.save(record)).rejects.toThrow();
        await chown(recordPath(record.id), 0, -1);
        await store.save({ ...record, state: "verifying" });
        await chown(store.path(record.id), 1, -1);
        await expect(store.publishFiles(record.id)).rejects.toThrow();
        await store.save({ ...record, state: "failed" });
        await expect(store.removeFiles(record.id)).rejects.toThrow();
      });
      await chown(base, 1, -1);
      await expect(store.initialize()).rejects.toThrow();
    },
  );

  test("rejects hardlinked records without overwriting the linked file", async () => {
    const record = await create();
    const outside = join(base, "linked-record");
    await link(recordPath(record.id), outside);
    await expect(store.list()).rejects.toThrow();
    await store.withLock(async () => {
      await expect(store.save({ ...record, state: "failed" })).rejects.toThrow();
    });
    expect(JSON.parse(await readFile(outside, "utf8")).state).toBe("building");
  });

  test.each([
    "records",
    "releases",
  ])("rejects replaced %s directory at every operation", async (name) => {
    const record = await create();
    await rename(join(root, name), join(root, `${name}-original`));
    await symlink(join(root, `${name}-original`), join(root, name));
    await expect(store.initialize()).rejects.toThrow();
    await expect(store.list()).rejects.toThrow();
    await expect(store.withLock(() => store.save(record))).rejects.toThrow();
  });

  test("validates roots and UUID-derived paths", () => {
    for (const path of ["/usr/local/store", "/tmp", `${root}/../other`, `${root}/`, "relative"]) {
      expect(() => new SpackInstallStore(path)).toThrow();
    }
    for (const id of ["../outside", "x", `${randomUUID()}/other`]) {
      expect(() => store.path(id)).toThrow();
    }
  });

  test("rejects symlink components and writable parents without changing their permissions", async () => {
    await symlink(root, join(base, "alias"));
    await expect(
      new SpackInstallStore(join(base, "alias", "nested")).initialize(),
    ).rejects.toThrow();
    await chmod(base, 0o777);
    await expect(store.initialize()).rejects.toThrow();
    expect(await mode(base)).toBe(0o777);
  });

  test("preserves site permissions and rejects nonprivate records directories", async () => {
    await chmod(root, 0o750);
    await store.initialize();
    expect(await mode(root)).toBe(0o750);
    await chmod(join(root, "records"), 0o755);
    await expect(store.initialize()).rejects.toThrow();
    expect(await mode(join(root, "records"))).toBe(0o755);
  });

  test.each([
    "symlink",
    "directory",
    "writable",
    "oversize",
    "unknown",
    "invalid",
    "id",
  ])("rejects unsafe %s records on restart and save", async (kind) => {
    const record = await create();
    const path = recordPath(record.id);
    if (kind === "symlink" || kind === "directory") {
      await rm(path);
      if (kind === "symlink") await symlink(join(base, "outside"), path);
      else await mkdir(path);
    } else if (kind === "writable") await chmod(path, 0o620);
    else if (kind === "oversize") await writeFile(path, " ".repeat(2 * 1024 ** 2 + 1));
    else if (kind === "unknown") await writeFile(path, JSON.stringify({ ...record, extra: true }));
    else if (kind === "id") await writeFile(path, JSON.stringify({ ...record, id: randomUUID() }));
    else await writeFile(path, "{");
    await expect(store.list()).rejects.toThrow();
    await store.withLock(async () => {
      await expect(store.save(record)).rejects.toThrow();
    });
  });

  test("refuses release symlinks on removal and publication", async () => {
    const record = await create();
    await rm(store.path(record.id), { recursive: true });
    await symlink(base, store.path(record.id));
    await store.withLock(async () => {
      await store.save({ ...record, state: "verifying" });
      await expect(store.publishFiles(record.id)).rejects.toThrow();
      await store.save({ ...record, state: "failed" });
      await expect(store.removeFiles(record.id)).rejects.toThrow();
    });
    expect((await lstat(base)).isDirectory()).toBe(true);
  });

  test("caps committed records at 1024 while allowing existing-record updates", async () => {
    const record = await create();
    for (let index = 1; index < 1024; index++) {
      const id = randomUUID();
      await writeFile(recordPath(id), JSON.stringify({ ...record, id }), { mode: 0o600 });
    }
    await store.withLock(async () => {
      await expect(store.create(input)).rejects.toThrow();
      await store.save({ ...record, state: "failed" });
    });
    expect((await store.list()).length).toBe(1024);
    const id = randomUUID();
    await writeFile(recordPath(id), JSON.stringify({ ...record, id }), { mode: 0o600 });
    await expect(store.list()).rejects.toThrow();
  });

  test("retains incomplete states, orphan release files, and interrupted-write fixtures", async () => {
    const record = await create();
    await store.withLock(() => store.save({ ...record, state: "verifying" }));
    const temporary = join(root, "records", `.${randomUUID()}.tmp`);
    await writeFile(temporary, "{", { mode: 0o600 });
    const orphan = join(root, "releases", randomUUID());
    await mkdir(orphan);
    const restarted = new SpackInstallStore(root);
    await restarted.initialize();
    expect((await restarted.list())[0]?.state).toBe("verifying");
    expect(await readFile(temporary, "utf8")).toBe("{");
    expect((await lstat(orphan)).isDirectory()).toBe(true);
  });
});
