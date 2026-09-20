import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpackAuditProcess } from "./audit-process";
import { SPACK_INSTALL_RESULT_PREFIX } from "./install-contract";
import { buildSpackInstallCommand, IsolatedSpackInstallRunner } from "./install-runner";
import { SpackInstallStore } from "./install-store";
import { installRuntime, makeInstallFixture } from "./install-test-fixture";

const fixtures: Awaited<ReturnType<typeof makeInstallFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});
async function fixture() {
  const f = await makeInstallFixture();
  fixtures.push(f);
  const store = new SpackInstallStore(f.site.profile.storeRoot);
  await store.initialize();
  const record = await store.withLock(() =>
    store.create({
      manifestDigest: f.input.manifestDigest,
      manifestSize: f.prepared.manifestSize,
      siteProfileDigest: f.site.digest,
      spec: f.input.spec,
      rootHash: "a".repeat(32),
    }),
  );
  return { ...f, path: store.path(record.id) };
}
const runtimeDeps = {
  platform: "linux",
  uid: 1000,
  inspect: async (path: string) => ({
    canonicalPath: path,
    uid: 0,
    mode: path === installRuntime.apptainerPath ? 0o100755 : 0o100444,
    regular: true,
    symlink: false,
    protectedParents: true,
    sha256:
      path === installRuntime.apptainerPath
        ? installRuntime.apptainerSha256
        : installRuntime.sifSha256,
  }),
};
function runner(process: SpackAuditProcess) {
  return new IsolatedSpackInstallRunner({
    runtime: installRuntime,
    process,
    runtimeDeps,
    runtimeContext: async () => ({ hostNetworkNamespace: "net:[1]", hostPidNamespace: "pid:[2]" }),
  });
}

describe("isolated persistent Spack worker", () => {
  test.each([
    "install",
    "verify",
    "load",
  ] as const)("binds only one exact persistent prefix for %s with private inputs and fixed env", async (action) => {
    const f = await fixture();
    let invoked = false;
    const r = runner({
      async run(command, options) {
        invoked = true;
        const binds = command.flatMap((value, index) =>
          value === "--bind" ? [command[index + 1]] : [],
        );
        expect(binds).toEqual([
          `${options.cwd}/input:/kq/input:ro`,
          "/sys/fs/cgroup:/sys/fs/cgroup:ro",
          `${f.path}:${f.path}:${action === "install" ? "rw" : "ro"}`,
        ]);
        expect(command).toContain("bind-paths,hostfs,cwd,home,sys");
        expect(command.filter((argument) => argument === "--underlay")).toHaveLength(1);
        expect(command.indexOf("--underlay")).toBeLessThan(command.indexOf(installRuntime.sifPath));
        expect(command).not.toContain("--writable-tmpfs");
        expect(command).not.toContain("--writable");
        expect(command).not.toContain("--overlay");
        expect(command).not.toContain("--workdir");
        expect(
          command.flatMap((value, index) => (value === "--scratch" ? [command[index + 1]] : [])),
        ).toEqual(["/kq/work"]);
        expect(command.slice(-4)).toEqual([
          installRuntime.sifPath,
          "/opt/spack/bin/spack",
          "python",
          "/kq/input/install_worker.py",
        ]);
        expect(command.join(" ")).not.toContain(f.input.ticket);
        expect(Object.keys(options.env).sort()).toEqual([
          "DBUS_SESSION_BUS_ADDRESS",
          "HOME",
          "LANG",
          "LC_ALL",
          "PATH",
          "XDG_RUNTIME_DIR",
        ]);
        const inputs = join(options.cwd, "input");
        expect(JSON.parse(await readFile(join(inputs, "request.json"), "utf8"))).toEqual({
          version: 1,
          action,
          manifestDigest: f.input.manifestDigest,
          siteProfileDigest: f.site.digest,
          storePath: f.path,
          siteProfile: f.site.profile,
        });
        expect(await readFile(join(inputs, "site-profile.json"))).toEqual(
          Buffer.from(f.site.bytes),
        );
        expect((await readdir(join(inputs, "blobs"))).sort()).toEqual(
          f.prepared.blobs.map((ref) => ref.digest.slice(7)).sort(),
        );
        const report = f.report(action, f.path);
        return {
          exitCode: 0,
          stdout: `${SPACK_INSTALL_RESULT_PREFIX}${JSON.stringify(report)}\n`,
          stderr: "",
        };
      },
    });
    expect(await r.run(action, f.prepared, f.input, f.site, f.path)).toEqual(
      f.report(action, f.path),
    );
    expect(invoked).toBe(true);
    expect(await readdir(join(f.cacheDir, "installs"))).toEqual([]);
  });

  test.each([
    { manifestDigest: `sha256:${"f".repeat(64)}` },
    { siteProfileDigest: `sha256:${"f".repeat(64)}` },
    { action: "install" },
    { storePath: "/srv/another/store" },
    { prefix: "/kq/work/hello" },
    { installedHashes: ["b".repeat(32)] },
    { installedHashes: ["a".repeat(32), "b".repeat(32)] },
    { unknown: true },
  ])("rejects forged report %j before publication", async (changed) => {
    const f = await fixture();
    const r = runner({
      async run() {
        return {
          exitCode: 0,
          stdout:
            SPACK_INSTALL_RESULT_PREFIX +
            JSON.stringify({ ...f.report("verify", f.path), ...changed }),
          stderr: "",
        };
      },
    });
    await expect(r.run("verify", f.prepared, f.input, f.site, f.path)).rejects.toThrow();
    expect(await readdir(join(f.cacheDir, "installs"))).toEqual([]);
  });

  test.each([
    "exit",
    "no-report",
    "throw",
    "cancel",
  ] as const)("cleans private staging on %s without exposing worker output", async (kind) => {
    const f = await fixture();
    const controller = new AbortController();
    const r = runner({
      async run() {
        if (kind === "throw") throw new Error("fixture transport");
        if (kind === "cancel") controller.abort();
        return {
          exitCode: kind === "exit" ? 1 : 0,
          stdout:
            kind === "no-report"
              ? "private upstream text"
              : SPACK_INSTALL_RESULT_PREFIX + JSON.stringify(f.report("verify", f.path)),
          stderr: "private upstream text",
        };
      },
    });
    await expect(
      r.run("verify", f.prepared, { ...f.input, signal: controller.signal }, f.site, f.path),
    ).rejects.toThrow();
    expect(await readdir(join(f.cacheDir, "installs"))).toEqual([]);
  });

  test("refuses replaced source bytes and a symlinked output prefix before starting a worker", async () => {
    const f = await fixture();
    let invoked = false;
    const r = runner({
      async run() {
        invoked = true;
        throw new Error("unexpected");
      },
    });
    const blob = f.prepared.blobs.find(
      (value) => value.digest === f.prepared.manifest.sources[0]?.blob.digest,
    );
    if (!blob) throw new Error("Missing source fixture");
    await chmod(blob.path, 0o600);
    await writeFile(blob.path, "tampered");
    await expect(r.run("install", f.prepared, f.input, f.site, f.path)).rejects.toThrow();
    expect(invoked).toBe(false);
    const g = await fixture();
    await rm(g.path, { recursive: true });
    const outside = join(g.root, "outside");
    await mkdir(outside);
    await symlink(outside, g.path);
    await expect(r.run("install", g.prepared, g.input, g.site, g.path)).rejects.toThrow();
    expect(invoked).toBe(false);
  });

  test("cannot bind store parents, siblings, traversal, arbitrary UUIDs or system paths", async () => {
    const f = await fixture();
    for (const path of [
      f.site.profile.storeRoot,
      "/etc",
      `${f.path}/..`,
      `${f.path}:rw`,
      `${f.site.profile.storeRoot}/releases/not-a-uuid`,
    ]) {
      expect(() =>
        buildSpackInstallCommand(
          installRuntime,
          "/srv/kq/input",
          f.input.manifestDigest,
          f.site.profile,
          path,
          "install",
        ),
      ).toThrow();
    }
  });
});
