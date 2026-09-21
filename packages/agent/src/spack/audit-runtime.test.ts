import { describe, expect, test } from "bun:test";
import {
  buildSpackAuditCommand,
  isSpackAuditPath,
  SPACK_MANAGED_MEMORY_BYTES,
  type SpackAuditFileIdentity,
  type SpackAuditRuntimeProfile,
  verifySpackAuditRuntime,
} from "./audit-runtime";

const profile: SpackAuditRuntimeProfile = {
  apptainerPath: "/usr/bin/apptainer",
  apptainerSha256: "a".repeat(64),
  sifPath: "/srv/kq/runtime.sif",
  sifSha256: "b".repeat(64),
};
const identity = (path: string): SpackAuditFileIdentity => ({
  canonicalPath: path,
  uid: 0,
  mode: path === profile.apptainerPath ? 0o100755 : 0o100444,
  regular: true,
  symlink: false,
  protectedParents: true,
  sha256: path === profile.apptainerPath ? profile.apptainerSha256 : profile.sifSha256,
});
const deps = { platform: "linux", uid: 1000, inspect: async (path: string) => identity(path) };

describe("Spack audit runtime identity and argv", () => {
  test("requires non-root Linux before inspecting or executing runtime files", async () => {
    for (const changed of [{ platform: "darwin" }, { platform: "win32" }, { uid: 0 }]) {
      let inspected = false;
      await expect(
        verifySpackAuditRuntime(profile, AbortSignal.timeout(1000), {
          ...deps,
          ...changed,
          inspect: async (path) => {
            inspected = true;
            return identity(path);
          },
        }),
      ).rejects.toThrow("non-root Linux");
      expect(inspected).toBe(false);
    }
  });

  test("accepts exact protected runtime identities without executing a probe", async () => {
    await verifySpackAuditRuntime(profile, AbortSignal.timeout(1000), deps);
  });

  test.each([
    { uid: 1000 },
    { mode: 0o100777 },
    { regular: false },
    { symlink: true },
    { canonicalPath: "/other/path" },
    { protectedParents: false },
    { sha256: "c".repeat(64) },
  ])("rejects untrusted runtime metadata %j", async (changed) => {
    for (const target of [profile.apptainerPath, profile.sifPath]) {
      await expect(
        verifySpackAuditRuntime(profile, AbortSignal.timeout(1000), {
          ...deps,
          inspect: async (path) => ({ ...identity(path), ...(path === target ? changed : {}) }),
        }),
      ).rejects.toThrow("identity");
    }
  });

  test("requires executable Apptainer and completely read-only SIF", async () => {
    for (const [target, mode] of [
      [profile.apptainerPath, 0o100644],
      [profile.sifPath, 0o100644],
    ] as const) {
      await expect(
        verifySpackAuditRuntime(profile, AbortSignal.timeout(1000), {
          ...deps,
          inspect: async (path) => ({ ...identity(path), ...(path === target ? { mode } : {}) }),
        }),
      ).rejects.toThrow("identity");
    }
  });

  test.each([
    "relative",
    "/",
    "/tmp/../a",
    "/tmp/./a",
    "/tmp/a/",
    "/tmp/a:b",
    "/tmp/a,b",
    "/tmp/a\nb",
    "/tmp/a\\b",
  ])("rejects unsafe profile/bind path %s", (path) => {
    expect(isSpackAuditPath(path)).toBe(false);
    expect(() => buildSpackAuditCommand(profile, path, `sha256:${"d".repeat(64)}`)).toThrow();
  });

  test("builds only network-none, contained, bounded execution with one read-only input bind", () => {
    const command = buildSpackAuditCommand(profile, "/srv/kq/input", `sha256:${"d".repeat(64)}`);
    for (const flag of [
      "--containall",
      "--userns",
      "--cleanenv",
      "--no-home",
      "--no-eval",
      "--writable-tmpfs",
      "--net",
      "--disable-cache",
    ]) {
      expect(command).toContain(flag);
    }
    const value = (flag: string) => command[command.indexOf(flag) + 1];
    expect(value("--network")).toBe("none");
    expect(value("--security")).toBe("no-new-privs");
    expect(value("--drop-caps")).toBe("all");
    expect(value("--memory")).toBe("2147483648");
    expect(value("--memory-swap")).toBe("2147483648");
    expect(value("--pids-limit")).toBe("128");
    expect(value("--cpus")).toBe("2");
    expect(value("--no-mount")).toBe("bind-paths,hostfs,cwd,home,sys");
    expect(command.filter((arg) => arg === "--bind")).toHaveLength(2);
    expect(value("--bind")).toBe("/srv/kq/input:/kq/input:ro");
    expect(command).toContain("/sys/fs/cgroup:/sys/fs/cgroup:ro");
    expect(command.slice(-5)).toEqual([
      profile.sifPath,
      "/opt/spack/bin/spack",
      "python",
      "/kq/input/source_audit.py",
      `sha256:${"d".repeat(64)}`,
    ]);
    expect(command).not.toContain("install");
    expect(command.some((arg) => arg.includes(":rw"))).toBe(false);
  });

  test("allows only the two fixed memory budgets without changing other isolation arguments", () => {
    const baseline = buildSpackAuditCommand(profile, "/srv/kq/input", `sha256:${"d".repeat(64)}`);
    const managed = buildSpackAuditCommand(
      profile,
      "/srv/kq/input",
      `sha256:${"d".repeat(64)}`,
      SPACK_MANAGED_MEMORY_BYTES,
    );
    expect(managed).toEqual(
      baseline.map((value, index) =>
        ["--memory", "--memory-swap"].includes(baseline[index - 1] ?? "") ? "4294967296" : value,
      ),
    );
    for (const memory of [0, -1, 1.5, NaN, Infinity, 2_147_483_647, 4_294_967_297]) {
      expect(() =>
        buildSpackAuditCommand(profile, "/srv/kq/input", `sha256:${"d".repeat(64)}`, memory),
      ).toThrow("memory budget");
    }
  });
});
