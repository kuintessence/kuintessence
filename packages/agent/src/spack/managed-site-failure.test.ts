import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm, symlink } from "node:fs/promises";
import type { SpackPolicy } from "@kuintessence/shared";
import { SpackInstallStore } from "./install-store";
import { makeInstallFixture } from "./install-test-fixture";
import { ManagedSpackInstallation } from "./managed-installation";

const fixtures: Awaited<ReturnType<typeof makeInstallFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

async function fixture() {
  const f = await makeInstallFixture();
  fixtures.push(f);
  let drift = false;
  let bytes = f.site.bytes;
  const calls: string[] = [];
  const options = {
    cacheDir: f.cacheDir,
    site: {
      ...f.siteOptions,
      inspect: async (path: string) =>
        path === f.siteOptions.path
          ? { sha256: createHash("sha256").update(bytes).digest("hex"), bytes }
          : {
              sha256: drift
                ? "f".repeat(64)
                : path === "/etc/os-release"
                  ? f.site.profile.osReleaseSha256
                  : (f.site.profile.hostFiles[0]?.sha256 ?? ""),
            },
    },
    runner: {
      async run(
        action: "install" | "verify" | "load",
        _prepared: unknown,
        _input: unknown,
        _site: unknown,
        path: string,
      ) {
        calls.push(action);
        const report = f.report(action, path);
        await mkdir(report.prefix, { recursive: true });
        return report;
      },
    },
  };
  const initial = new ManagedSpackInstallation(options);
  expect((await initial.install(f.prepared, f.input)).outcome).toBe("succeeded");
  const store = new SpackInstallStore(f.site.profile.storeRoot);
  const [record] = await store.list();
  if (!record) throw new Error("Missing fixture record");
  return {
    ...f,
    store,
    record,
    options,
    calls,
    backend: () => new ManagedSpackInstallation(options),
    drift: () => {
      drift = true;
    },
    restore: () => {
      drift = false;
    },
    changeProfile: (value: unknown) => {
      bytes = new TextEncoder().encode(JSON.stringify(value));
    },
  };
}

describe("managed Spack site failure withdrawal", () => {
  test.each([
    "load",
    "import_preinstalled",
    "install",
    "uninstall",
  ] as const)("a cold %s operation withdraws a verified record when host contents drift", async (action) => {
    const f = await fixture();
    f.drift();
    const backend = f.backend();
    const outcome =
      action === "install"
        ? await backend.install(f.prepared, f.input)
        : await backend.operation(action, `/${f.record.rootHash}`);
    expect(outcome).toMatchObject({
      outcome: "failed",
      invalidatedHashes: [f.record.rootHash],
    });
    const [unavailable] = await f.store.list();
    expect(unavailable).toMatchObject({
      ...f.record,
      state: "unavailable",
      updatedAt: expect.any(String),
    });
    expect(f.calls).toEqual(["install", "verify"]);
    expect((await lstat(f.store.path(f.record.id))).isDirectory()).toBe(true);
    f.restore();
    expect(await backend.installedList()).toEqual([]);
    expect(await backend.operation("load", f.input.spec)).toMatchObject({ outcome: "rejected" });
    expect(await backend.operation("import_preinstalled", f.input.spec)).toMatchObject({
      outcome: "succeeded",
    });
    expect((await f.store.list())[0]?.state).toBe("ready");
    expect(f.calls).toEqual(["install", "verify", "verify"]);
  });

  test("changed profile bytes cannot redirect withdrawal into a different store", async () => {
    const f = await fixture();
    const alternateRoot = `${f.root}/alternate/store`;
    f.changeProfile({ ...f.site.profile, storeRoot: alternateRoot });
    expect(await f.backend().operation("load", f.input.spec)).toMatchObject({ outcome: "failed" });
    expect((await f.store.list())[0]).toEqual(f.record);
    await expect(lstat(alternateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls).toEqual(["install", "verify"]);
  });

  test.each([
    "unknown",
    "policy",
    "ambiguous",
    "different-profile",
  ] as const)("does not withdraw an unselected or unauthorized record: %s", async (scenario) => {
    const f = await fixture();
    let selector = f.input.spec;
    let policy: SpackPolicy = { lockEnabled: false };
    if (scenario === "unknown") selector = "unrelated@1.0";
    if (scenario === "policy") policy = { lockEnabled: false, denyList: ["hello@*"] };
    if (scenario === "ambiguous" || scenario === "different-profile") {
      await f.store.withLock(async () => {
        const other = await f.store.create({
          manifestDigest: f.record.manifestDigest,
          manifestSize: f.record.manifestSize,
          siteProfileDigest:
            scenario === "different-profile" ? `sha256:${"f".repeat(64)}` : f.site.digest,
          spec: f.record.spec,
          rootHash: "b".repeat(32),
        });
        const report = {
          ...f.report("verify", f.store.path(other.id)),
          siteProfileDigest: other.siteProfileDigest,
          root: { ...f.report("verify", f.store.path(other.id)).root, hash: other.rootHash },
          installedHashes: [other.rootHash],
        };
        await f.store.save({ ...other, state: "verifying" });
        await f.store.save({ ...other, state: "ready", report });
        if (scenario === "different-profile") selector = `/${other.rootHash}`;
      });
    }
    const before = await f.store.list();
    f.drift();
    const result = await f.backend().operation("load", selector, policy);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result).not.toHaveProperty("invalidatedHashes");
    expect(await f.store.list()).toEqual(before);
    expect(f.calls).toEqual(["install", "verify"]);
  });

  test("retains the known invalidated hash if the unavailable write fails", async () => {
    const f = await fixture();
    f.drift();
    const save = spyOn(SpackInstallStore.prototype, "save").mockRejectedValue(
      new Error("fixture write failure"),
    );
    try {
      expect(await f.backend().operation("load", f.input.spec)).toMatchObject({
        outcome: "failed",
        invalidatedHashes: [f.record.rootHash],
      });
    } finally {
      save.mockRestore();
    }
    expect(await f.store.list()).toEqual([f.record]);
    await expect(lstat(`${f.site.profile.storeRoot}/.writer-lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test.each([
    "missing",
    "symlink",
    "locked",
    "cache-overlap",
  ] as const)("never recreates or writes an unsafe withdrawal store: %s", async (scenario) => {
    const f = await fixture();
    f.drift();
    const root = f.site.profile.storeRoot;
    const saved = `${root}-saved`;
    if (scenario === "missing" || scenario === "symlink") {
      await rename(root, saved);
      if (scenario === "symlink") await symlink(saved, root);
    } else if (scenario === "locked") {
      await mkdir(`${root}/.writer-lock`, { mode: 0o700 });
    } else {
      f.options.cacheDir = `${root}/cache`;
    }
    const result = await f.backend().operation("load", f.input.spec);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result).not.toHaveProperty("invalidatedHashes");
    if (scenario === "missing" || scenario === "symlink") {
      if (scenario === "missing") {
        await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect((await lstat(root)).isSymbolicLink()).toBe(true);
        await rm(root);
      }
      await rename(saved, root);
    }
    expect(await f.store.list()).toEqual([f.record]);
    expect(f.calls).toEqual(["install", "verify"]);
  });
});
