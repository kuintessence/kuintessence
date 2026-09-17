import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spawner } from "./adapters/base";
import {
  LinuxBindReadonlyMountDriver,
  type TrustedReadonlyMountDriver,
} from "./data-market/data-delivery";
import { LicensedMaterialResolver } from "./licensed-material-resolver";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-licensed-material-"));
  const restrictedRoot = join(root, "restricted");
  const material = join(restrictedRoot, "vasp", "POTCAR");
  await mkdir(join(restrictedRoot, "vasp"), { recursive: true });
  await writeFile(material, "POTCAR bytes");
  await chmod(material, 0o440);
  return { root, restrictedRoot, material };
}

function fingerprint() {
  return createHash("sha256").update("POTCAR bytes").digest("hex");
}

function recordingDriver(options: { unmountError?: Error } = {}) {
  const calls: Array<{ operation: "mount" | "unmount"; source?: string; target: string }> = [];
  const driver: TrustedReadonlyMountDriver = {
    trusted: true,
    mountReadonly: async (source, target) => {
      calls.push({ operation: "mount", source, target });
    },
    unmount: async (target) => {
      calls.push({ operation: "unmount", target });
      if (options.unmountError) throw options.unmountError;
    },
  };
  return { driver, calls };
}

function resolver(
  restrictedRoot: string,
  readonlyMountDriver?: TrustedReadonlyMountDriver,
  localRelativePath = "vasp/POTCAR",
) {
  return new LicensedMaterialResolver({
    restrictedRoot,
    registry: { "potcar-pbe": { localRelativePath } },
    readonlyMountDriver,
  });
}

describe("LicensedMaterialResolver", () => {
  test("uses a readonly bind mount and never creates a symbolic link or copy", async () => {
    const { root, restrictedRoot, material } = await fixture();
    const commands: string[][] = [];
    const spawner: Spawner = {
      run: async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const mountDriver = new LinuxBindReadonlyMountDriver(spawner);
    const targetPath = join(root, "run", "POTCAR");
    let intentTarget = "";
    const mounts = await resolver(restrictedRoot, mountDriver).prepare(
      [
        {
          selectorId: "potcar-pbe",
          targetPath: "POTCAR",
          fingerprint: fingerprint(),
          requiredElements: ["Si", "O"],
        },
      ],
      join(root, "run"),
      {
        beforeMount: async (intent) => {
          intentTarget = intent.targetPath;
          await expect(lstat(intent.targetPath)).rejects.toThrow();
        },
      },
    );
    const canonicalTarget = mounts[0]?.targetPath;
    if (!canonicalTarget) throw new Error("licensed material mount was not prepared");

    expect(intentTarget).toBe(canonicalTarget);

    expect((await lstat(targetPath)).isSymbolicLink()).toBe(false);
    expect(commands).toEqual([
      ["mount", "--bind", await realpath(material), canonicalTarget],
      ["mount", "-o", "remount,bind,ro", canonicalTarget],
    ]);

    await resolver(restrictedRoot, mountDriver).release(mounts);
    expect(commands.at(-1)).toEqual(["umount", canonicalTarget]);
    await expect(lstat(targetPath)).rejects.toThrow();
  });

  test("fails closed when the trusted mount driver is unavailable", async () => {
    const { root, restrictedRoot } = await fixture();
    const targetPath = join(root, "run", "POTCAR");

    await expect(
      resolver(restrictedRoot).prepare(
        [{ selectorId: "potcar-pbe", targetPath: "POTCAR", fingerprint: fingerprint() }],
        join(root, "run"),
      ),
    ).rejects.toThrow("trusted readonly mount driver");
    await expect(lstat(targetPath)).rejects.toThrow();
  });

  test("retains the mount target when unmount fails so cleanup can be retried", async () => {
    const { root, restrictedRoot } = await fixture();
    const { driver, calls } = recordingDriver({ unmountError: new Error("busy") });
    const targetPath = join(root, "run", "POTCAR");
    const mounts = await resolver(restrictedRoot, driver).prepare(
      [{ selectorId: "potcar-pbe", targetPath: "POTCAR", fingerprint: fingerprint() }],
      join(root, "run"),
    );
    const canonicalTarget = mounts[0]?.targetPath;
    if (!canonicalTarget) throw new Error("licensed material mount was not prepared");

    await expect(resolver(restrictedRoot, driver).release(mounts)).rejects.toThrow(
      "mount cleanup failed",
    );
    expect(calls.at(-1)).toEqual({ operation: "unmount", target: canonicalTarget });
    expect(await lstat(targetPath)).toBeDefined();
  });

  test("rejects traversal, fingerprint mismatch, and invalid element selectors before mounting", async () => {
    const { root, restrictedRoot } = await fixture();
    const { driver, calls } = recordingDriver();
    await expect(
      resolver(restrictedRoot, driver, "../POTCAR").prepare(
        [{ selectorId: "potcar-pbe", targetPath: "POTCAR", fingerprint: fingerprint() }],
        join(root, "run-a"),
      ),
    ).rejects.toThrow("invalid");
    await expect(
      resolver(restrictedRoot, driver).prepare(
        [{ selectorId: "potcar-pbe", targetPath: "POTCAR", fingerprint: "sha256:deadbeef" }],
        join(root, "run-b"),
      ),
    ).rejects.toThrow("fingerprint mismatch");
    await expect(
      resolver(restrictedRoot, driver).prepare(
        [
          {
            selectorId: "potcar-pbe",
            targetPath: "POTCAR",
            fingerprint: fingerprint(),
            requiredElements: ["../Si"],
          },
        ],
        join(root, "run-c"),
      ),
    ).rejects.toThrow("required elements");
    expect(calls).toEqual([]);
  });

  test("rejects symbolic links in source and target ancestry", async () => {
    const { root, restrictedRoot } = await fixture();
    const { driver, calls } = recordingDriver();
    await symlink(join(restrictedRoot, "vasp"), join(restrictedRoot, "linked-material"));
    await expect(
      resolver(restrictedRoot, driver, "linked-material/POTCAR").prepare(
        [{ selectorId: "potcar-pbe", targetPath: "POTCAR", fingerprint: fingerprint() }],
        join(root, "run-a"),
      ),
    ).rejects.toThrow("symbolic link");

    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, "run-b"));
    await expect(
      resolver(restrictedRoot, driver).prepare(
        [{ selectorId: "potcar-pbe", targetPath: "POTCAR", fingerprint: fingerprint() }],
        join(root, "run-b"),
      ),
    ).rejects.toThrow("symbolic link");
    expect(calls).toEqual([]);
  });
});
