import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, readdir } from "node:fs/promises";
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

describe("managed Spack lifecycle cancellation", () => {
  test("an aborted request cannot inspect the site or create a store", async () => {
    const f = await fixture();
    let calls = 0;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => {
        calls++;
        return f.site;
      },
      runner: {
        async run(action, _p, _i, _s, path) {
          calls++;
          return f.report(action, path);
        },
      },
    });
    const signal = AbortSignal.abort();
    expect((await backend.install(f.prepared, { ...f.input, signal })).outcome).toBe("failed");
    for (const action of ["load", "uninstall", "import_preinstalled"] as const) {
      expect(
        await backend.operation(action, f.input.spec, { lockEnabled: false }, signal),
      ).toMatchObject({ outcome: "failed" });
    }
    expect(calls).toBe(0);
    await expect(lstat(f.site.profile.storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("abort after build prevents verify and still cleans the uncommitted store", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const calls: string[] = [];
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(action, _p, input, _s, path) {
          calls.push(action);
          expect(input.signal).toBe(controller.signal);
          await mkdir(f.report(action, path).prefix);
          controller.abort();
          return f.report(action, path);
        },
      },
    });
    expect(
      (await backend.install(f.prepared, { ...f.input, signal: controller.signal })).outcome,
    ).toBe("failed");
    expect(calls).toEqual(["install"]);
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    expect((await store.list())[0]?.state).toBe("failed");
    expect(await readdir(`${f.site.profile.storeRoot}/releases`)).toEqual([]);
    await expect(lstat(`${f.site.profile.storeRoot}/.writer-lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test.each([
    "load",
    "import_preinstalled",
  ] as const)("passes cancellation to %s and withdraws a stopped verification", async (action) => {
    const f = await fixture();
    const controller = new AbortController();
    let active = false;
    const backend = new ManagedSpackInstallation({
      cacheDir: f.cacheDir,
      site: f.siteOptions,
      loadSite: async () => f.site,
      runner: {
        async run(nativeAction, _p, input, _s, path) {
          await mkdir(f.report(nativeAction, path).prefix, { recursive: true });
          if (active) {
            expect(input.signal).toBe(controller.signal);
            controller.abort();
          }
          return f.report(nativeAction, path);
        },
      },
    });
    expect((await backend.install(f.prepared, f.input)).outcome).toBe("succeeded");
    active = true;
    const store = new SpackInstallStore(f.site.profile.storeRoot);
    const [record] = await store.list();
    if (!record) throw new Error("Missing fixture record");
    expect(
      await backend.operation(action, f.input.spec, { lockEnabled: false }, controller.signal),
    ).toMatchObject({ outcome: "failed", invalidatedHashes: [record.rootHash] });
    expect((await store.list())[0]?.state).toBe("unavailable");
    expect((await lstat(store.path(record.id))).isDirectory()).toBe(true);
    await expect(lstat(`${f.site.profile.storeRoot}/.writer-lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("cancellation during ready publication withdraws the record without deleting its files", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const original = SpackInstallStore.prototype.save;
    const save = spyOn(SpackInstallStore.prototype, "save").mockImplementation(async function (
      this: SpackInstallStore,
      record,
    ) {
      await original.call(this, record);
      if (record.state === "ready") controller.abort();
    });
    try {
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
      const result = await backend.install(f.prepared, { ...f.input, signal: controller.signal });
      const store = new SpackInstallStore(f.site.profile.storeRoot);
      const [record] = await store.list();
      if (!record) throw new Error("Missing fixture record");
      expect(result).toMatchObject({ outcome: "failed", invalidatedHashes: [record.rootHash] });
      expect(record.state).toBe("unavailable");
      expect((await lstat(store.path(record.id))).isDirectory()).toBe(true);
      await expect(lstat(`${f.site.profile.storeRoot}/.writer-lock`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      save.mockRestore();
    }
  });
});
