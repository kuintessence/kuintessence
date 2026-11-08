import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realSpawner } from "../adapters/base";
import { buildHpcCgroupCommand, buildSelfAccountCgroupCommand } from "./cgroup-command";

const roots: string[] = [];
const digest = (source: string) => createHash("sha256").update(source).digest("hex");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp("/var/lib/kq-cgroup-command-test-");
  roots.push(root);
  const path = join(root, "checker.py");
  const source =
    "import sys\nassert sys.flags.isolated == 1\nprint(repr(sys.argv[1:]), file=sys.stderr)\n";
  await writeFile(path, source, { mode: 0o644 });
  const checker = { path, sha256: digest(source) };
  const run = (nativeId = "42") =>
    realSpawner.run([
      "env",
      `SLURM_JOB_ID=${nativeId}`,
      "/bin/bash",
      "-c",
      `${buildSelfAccountCgroupCommand(checker, { cpus: 2, memoryMb: 512 })} >/dev/null || exit 126; printf USER_CODE`,
    ]);
  return { root, checker, source, run };
}

test("requires pinned checker identity and valid signed resources before rendering a job", () => {
  expect(() => buildSelfAccountCgroupCommand(undefined, { cpus: 1, memoryMb: 128 })).toThrow();
  expect(() =>
    buildSelfAccountCgroupCommand({ path: "/safe/checker", sha256: "a".repeat(64) }, undefined),
  ).toThrow();
  expect(() =>
    buildSelfAccountCgroupCommand(
      { path: "/safe/../checker", sha256: "a".repeat(64) },
      { cpus: 1, memoryMb: 128 },
    ),
  ).toThrow();
});

describe.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
  "pinned SelfAccount checker execution",
  () => {
    test("PBS and Torque checks bind PBS_JOBID rather than an unrelated Slurm environment value", async () => {
      const f = await fixture();
      for (const scheduler of ["pbs-pro", "torque"] as const) {
        const script = `${buildHpcCgroupCommand(f.checker, { cpus: 1, memoryMb: 128 }, scheduler)} || exit 126; printf USER_CODE`;
        const result = await realSpawner.run([
          "env",
          "PBS_JOBID=43.pbs",
          "SLURM_JOB_ID=forged",
          "/bin/bash",
          "-c",
          script,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain(`'--scheduler', '${scheduler}'`);
        expect(result.stderr).toContain("'--job-id', '43.pbs'");
        expect(result.stderr).not.toContain("forged");
        expect(
          (
            await realSpawner.run([
              "env",
              "PBS_JOBID=",
              "SLURM_JOB_ID=43",
              "/bin/bash",
              "-c",
              script,
            ])
          ).exitCode,
        ).not.toBe(0);
      }
    });

    test("passes signed resources and native job ID in isolated Python before user code", async () => {
      const f = await fixture();
      const result = await f.run();
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(
        "['--scheduler', 'slurm', '--cpus', '2', '--memory-mb', '512', '--job-id', '42']",
      );
      expect(result.stdout).toBe("USER_CODE");
      expect((await f.run("")).exitCode).not.toBe(0);
    });

    test("rejects changed bytes, writable files, symlinks and writable ancestors", async () => {
      const f = await fixture();
      await writeFile(f.checker.path, "raise SystemExit(0)");
      expect(await f.run()).toMatchObject({ exitCode: 126, stdout: "" });
      await writeFile(f.checker.path, f.source);
      await chmod(f.checker.path, 0o666);
      expect(await f.run()).toMatchObject({ exitCode: 126, stdout: "" });
      await chmod(f.checker.path, 0o644);
      const unsafe = join(f.root, "unsafe");
      await mkdir(unsafe, { mode: 0o777 });
      await chmod(unsafe, 0o777);
      await writeFile(join(unsafe, "checker.py"), f.source);
      f.checker.path = join(unsafe, "checker.py");
      expect(await f.run()).toMatchObject({ exitCode: 126, stdout: "" });
      f.checker.path = join(f.root, "link.py");
      await symlink(join(f.root, "checker.py"), f.checker.path);
      expect(await f.run()).toMatchObject({ exitCode: 126, stdout: "" });
    });

    test("real kernel checker rejects a forged Slurm job ID before user code", async () => {
      const f = await fixture();
      const source = await readFile(
        new URL("../../scripts/kq-sandbox-cgroup-check", import.meta.url),
        "utf8",
      );
      await writeFile(f.checker.path, source);
      f.checker.sha256 = digest(source);
      expect(await f.run()).toMatchObject({ exitCode: 126, stdout: "" });
    });
  },
);
