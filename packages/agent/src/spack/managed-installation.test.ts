import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import type { SpackInstallRunner } from "./install-runner";
import { SpackInstallStore } from "./install-store";
import { makeInstallFixture } from "./install-test-fixture";
import { ManagedSpackInstallation } from "./managed-installation";

const fixtures: Awaited<ReturnType<typeof makeInstallFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});
async function fixture() {
  const value = await makeInstallFixture();
  fixtures.push(value);
  return value;
}

describe("managed Spack installation transaction", () => {
  test("builds at its final prefix, independently verifies, survives restart, loads and removes only its release", async () => {
    const f = await fixture();
    const calls: string[] = [];
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    const runner: SpackInstallRunner = {
      async run(action, _prepared, _input, _site, path) {
        calls.push(action);
        const records = await store.list();
        if (action === "install") {
          expect(records[0]?.state).toBe("building");
          expect(await backend.installedList()).toEqual([]);
          await mkdir(f.report(action, path).prefix);
        } else if (action === "verify") {
          expect(records[0]?.state).toBe("verifying");
          expect(await backend.installedList()).toEqual([]);
        }
        return f.report(action, path);
      },
    };
    const options = {
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner,
    };
    const backend = new ManagedSpackInstallation(options);
    const outcome = await backend.install(f.prepared, f.input);
    expect(outcome.outcome).toBe("succeeded");
    expect(calls).toEqual(["install", "verify"]);
    const records = await store.list();
    const record = records[0];
    if (!record) throw new Error("Missing transaction");
    expect(record.state).toBe("ready");
    expect((await lstat(store.path(record.id))).mode & 0o777).toBe(0o755);
    const restarted = new ManagedSpackInstallation(options);
    expect(await restarted.installedList()).toEqual([
      f.report("verify", store.path(record.id)).root,
    ]);
    const loaded = await restarted.operation("load", f.input.spec);
    expect(loaded).toMatchObject({
      outcome: "succeeded",
      stdout: expect.stringContaining(store.path(record.id)),
    });
    expect(calls).toEqual(["install", "verify", "load"]);
    expect(await restarted.operation("load", "unrelated@1.0")).toBeNull();
    expect(await restarted.operation("load", "hello@wrong+variant")).toMatchObject({
      outcome: "rejected",
    });
    expect(await restarted.operation("uninstall", f.input.spec)).toMatchObject({
      outcome: "succeeded",
      installed: [],
    });
    expect((await store.list())[0]?.state).toBe("removed");
    expect(await readdir(`${f.site.profile.storeRoot}/releases`)).toEqual([]);
    expect((await lstat(f.prepared.manifestPath)).isFile()).toBe(true);
  });

  test.each([
    "install",
    "verify",
    "binding",
  ])("does not publish on %s failure and cleans only its uncommitted prefix", async (phase) => {
    const f = await fixture();
    const calls: string[] = [];
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _prepared, _input, _site, path) {
          calls.push(action);
          if (action === phase) throw new Error("private upstream credential");
          const report = f.report(action, path);
          await mkdir(report.prefix, { recursive: true });
          return phase === "binding"
            ? { ...report, manifestDigest: `sha256:${"f".repeat(64)}` }
            : report;
        },
      },
    });
    expect(await backend.install(f.prepared, f.input)).toEqual({
      outcome: "failed",
      exitCode: 1,
      stderr: "Managed Spack operation failed; inspect the installation record before retrying",
    });
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    expect((await store.list())[0]?.state).toBe("failed");
    expect(await backend.installedList()).toEqual([]);
    expect(await readdir(`${f.site.profile.storeRoot}/releases`)).toEqual([]);
    expect(calls).toEqual(phase === "verify" ? ["install", "verify"] : ["install"]);
  });

  test("a crash-left writer lock is never stolen and no worker is dispatched", async () => {
    const f = await fixture();
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    await store.initialize();
    await mkdir(`${f.site.profile.storeRoot}/.writer-lock`);
    let runs = 0;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          runs++;
          return f.report(action, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("failed");
    expect(runs).toBe(0);
    expect((await lstat(`${f.site.profile.storeRoot}/.writer-lock`)).isDirectory()).toBe(true);
  });

  test("withdraws an installation when removal fails, retaining its record for cleanup retry", async () => {
    const f = await fixture();
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    const [record] = await store.list();
    if (!record) throw new Error("Missing record");
    const path = store.path(record.id);
    await rename(path, `${path}-retained`);
    await symlink(f.cacheDir, path);
    expect(await backend.operation("uninstall", f.input.spec)).toMatchObject({
      outcome: "failed",
      invalidatedHashes: [record.rootHash],
    });
    expect((await store.list())[0]?.state).toBe("removing");
    expect(await backend.installedList()).toEqual([]);
    expect((await lstat(f.prepared.manifestPath)).isFile()).toBe(true);
    await rm(path);
    await rename(`${path}-retained`, path);
    expect(await backend.operation("uninstall", f.input.spec)).toMatchObject({
      outcome: "succeeded",
      installed: [],
    });
  });

  test.each([
    "uninstall",
    "load",
    "install",
  ] as const)("preserves %s withdrawal when writer-lock finalization throws after mutation", async (action) => {
    const f = await fixture();
    let fail = false;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          if (fail) throw new Error("fixture verification failure");
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    const [record] = await store.list();
    if (!record) throw new Error("Missing record");
    fail = true;
    const original = SpackInstallStore.prototype.withLock;
    const locked = spyOn(SpackInstallStore.prototype, "withLock").mockImplementation(
      async function (this: SpackInstallStore, fn) {
        await original.call(this, fn);
        throw new Error("fixture writer-lock finalization failure");
      },
    );
    try {
      const result =
        action === "install"
          ? await backend.install(f.prepared, f.input)
          : await backend.operation(action, f.input.spec);
      expect(result).toMatchObject({ outcome: "failed", invalidatedHashes: [record.rootHash] });
      expect((await store.list())[0]?.state).toBe(
        action === "uninstall" ? "removed" : "unavailable",
      );
      expect(await backend.installedList()).toEqual([]);
    } finally {
      locked.mockRestore();
    }
  });

  test("missing published prefixes fail inventory instead of retaining false readiness", async () => {
    const f = await fixture();
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    const [record] = await new SpackInstallStore(f.site.profile.storeRoot).list();
    if (!record?.report) throw new Error("Missing installed record");
    await rm(record.report.prefix, { recursive: true });
    await expect(backend.installedList()).rejects.toThrow();
  });

  test.each([
    "load",
    "import_preinstalled",
    "install",
  ] as const)("withdraws readiness on %s revalidation failure and restores only after explicit verification", async (action) => {
    const f = await fixture();
    let fail = false;
    let runs = 0;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          runs++;
          if (fail) throw new Error("fixture corrupt native database");
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    const [record] = await store.list();
    if (!record) throw new Error("Missing record");
    fail = true;
    const result =
      action === "install"
        ? await backend.install(f.prepared, f.input)
        : await backend.operation(action, f.input.spec);
    expect(result).toMatchObject({ outcome: "failed", invalidatedHashes: [record.rootHash] });
    expect((await store.list())[0]?.state).toBe("unavailable");
    expect(await backend.installedList()).toEqual([]);
    expect((await lstat(store.path(record.id))).isDirectory()).toBe(true);
    expect(await backend.operation("load", f.input.spec)).toMatchObject({ outcome: "rejected" });
    expect(runs).toBe(3);
    fail = false;
    expect(await backend.operation("import_preinstalled", f.input.spec)).toMatchObject({
      outcome: "succeeded",
    });
    expect((await store.list())[0]?.state).toBe("ready");
    expect(await backend.installedList()).toHaveLength(1);
  });

  test("checks policy against the recorded software, including hash and name selectors", async () => {
    const f = await fixture();
    let runs = 0;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          runs++;
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    const [record] = await new SpackInstallStore(f.site.profile.storeRoot).list();
    if (!record) throw new Error("Missing installed record");
    for (const selector of [f.input.spec, "hello", `/${record.rootHash}`]) {
      for (const action of ["load", "uninstall"] as const) {
        expect(
          await backend.operation(action, selector, {
            lockEnabled: false,
            denyList: ["hello@*"],
          }),
        ).toMatchObject({ outcome: "rejected", reason: expect.stringContaining("denyList") });
      }
    }
    expect(runs).toBe(2);
    expect(
      await backend.operation("load", `/${record.rootHash}`, {
        lockEnabled: true,
        allowList: ["hello@*"],
      }),
    ).toMatchObject({ outcome: "succeeded" });
    expect((await backend.installedList()).length).toBe(1);
  });

  test("reuses a verified identical release without a second build", async () => {
    const f = await fixture();
    const calls: string[] = [];
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          calls.push(action);
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    expect(calls).toEqual(["install", "verify", "verify"]);
    expect(await new SpackInstallStore(f.site.profile.storeRoot).list()).toHaveLength(1);
  });

  test("refuses implicit replacement when the pinned site profile changes", async () => {
    const f = await fixture();
    let site = f.site;
    let runs = 0;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => site,
      runner: {
        async run(action, _p, _i, _s, path) {
          runs++;
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    site = { ...site, digest: `sha256:${"f".repeat(64)}` };
    expect(await backend.install(f.prepared, f.input)).toMatchObject({
      outcome: "rejected",
      reason: expect.stringContaining("explicitly uninstall"),
    });
    expect(runs).toBe(2);
  });

  test("never deletes a published release after an unrelated inventory failure", async () => {
    const f = await fixture();
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    await store.initialize();
    await store.withLock(async () => {
      const old = await store.create({
        manifestDigest: f.input.manifestDigest,
        manifestSize: f.prepared.manifestSize,
        siteProfileDigest: f.site.digest,
        spec: "previous@1.0",
        rootHash: "b".repeat(32),
      });
      const report = f.report("verify", store.path(old.id));
      await store.save({ ...old, state: "verifying" });
      await store.save({
        ...old,
        state: "ready",
        report: {
          ...report,
          root: { ...report.root, name: "previous", spec: old.spec, hash: old.rootHash },
          installedHashes: [old.rootHash],
        },
      });
    });
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    expect(await backend.install(f.prepared, f.input)).toMatchObject({
      outcome: "failed",
      stderr: expect.stringContaining("inspect the installation record"),
    });
    const installed = (await store.list()).find((record) => record.spec === f.input.spec);
    expect(installed?.state).toBe("ready");
    if (!installed?.report) throw new Error("Missing published report");
    expect((await lstat(installed.report.prefix)).isDirectory()).toBe(true);
  });

  test("an older failed attempt does not shadow a successful retry and supports explicit cleanup", async () => {
    const f = await fixture();
    let fail = true;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          if (fail) throw new Error("fixture build failure");
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("failed");
    fail = false;
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    const failed = (await store.list()).find((record) => record.state === "failed");
    if (!failed) throw new Error("Missing failed attempt");
    expect(await backend.operation("load", f.input.spec)).toMatchObject({ outcome: "succeeded" });
    expect(
      await backend.operation("uninstall", `release:${failed.id}`, {
        lockEnabled: false,
        denyList: ["hello@*"],
      }),
    ).toMatchObject({ outcome: "rejected" });
    expect(await backend.operation("uninstall", `release:${failed.id}`)).toMatchObject({
      outcome: "succeeded",
    });
    expect(await backend.installedList()).toHaveLength(1);
    expect(await backend.operation("uninstall", f.input.spec)).toMatchObject({
      outcome: "succeeded",
      installed: [],
    });
  });

  test.each([
    "profile",
    "abort",
    "prefix",
  ])("does not publish after %s changes during verification", async (change) => {
    const f = await fixture();
    const controller = new AbortController();
    let verified = false;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => {
        if (verified && change === "profile") throw new Error("site pin changed");
        return f.site;
      },
      runner: {
        async run(action, _p, _i, _s, path) {
          const report = f.report(action, path);
          await mkdir(report.prefix, { recursive: true });
          if (action === "verify") {
            verified = true;
            if (change === "abort") controller.abort();
            if (change === "prefix") return { ...report, prefix: `${path}/different` };
          }
          return report;
        },
      },
    });
    expect(
      (await backend.install(f.prepared, { ...f.input, signal: controller.signal })).outcome,
    ).toBe("failed");
    expect((await new SpackInstallStore(f.site.profile.storeRoot).list())[0]?.state).toBe("failed");
    expect(await readdir(`${f.site.profile.storeRoot}/releases`)).toEqual([]);
  });

  test("refuses concurrent writers while an installation is building", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let builds = 0;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, _i, _s, path) {
          if (action === "install") {
            builds++;
            entered.resolve();
            await release.promise;
          }
          await mkdir(f.report(action, path).prefix, { recursive: true });
          return f.report(action, path);
        },
      },
    });
    const first = backend.install(f.prepared, f.input);
    try {
      await entered.promise;
      expect((await backend.install(f.prepared, f.input)).outcome).toBe("failed");
      expect(builds).toBe(1);
    } finally {
      release.resolve();
      expect((await first).outcome).toBe("succeeded");
    }
  });

  test.each(["failed", "removing"] as const)("retries cleanup of a %s record", async (state) => {
    const f = await fixture();
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    await store.initialize();
    const record = await store.withLock(async () => {
      const record = await store.create({
        manifestDigest: f.input.manifestDigest,
        manifestSize: f.prepared.manifestSize,
        siteProfileDigest: f.site.digest,
        spec: f.input.spec,
        rootHash: f.report("install", "/srv/kq/store/releases/test").root.hash,
      });
      await store.save({ ...record, state: "failed" });
      if (state === "removing") await store.save({ ...record, state });
      return record;
    });
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run() {
          throw new Error("Cleanup must not execute a worker");
        },
      },
    });
    expect(await backend.operation("uninstall", f.input.spec)).toMatchObject({
      outcome: "succeeded",
      installed: [],
    });
    expect((await store.list())[0]?.state).toBe("removed");
    await expect(lstat(store.path(record.id))).rejects.toThrow();
  });
});
