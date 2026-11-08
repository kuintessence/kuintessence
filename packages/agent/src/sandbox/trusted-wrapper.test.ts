import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realSpawner } from "../adapters/base";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  // /tmp and /var/tmp are deliberately rejected by the production ancestor checks.
  const root = await mkdtemp("/var/lib/kq-wrapper-test-");
  roots.push(root);
  const wrapper = join(root, "wrapper");
  const config = join(root, "profile.conf");
  const executable = join(root, "apptainer");
  const sif = join(root, "runtime.sif");
  const seccomp = join(root, "seccomp.json");
  const original = await readFile(
    new URL("../../scripts/kq-sandbox-wrapper", import.meta.url),
    "utf8",
  );
  const script = original.replace("/etc/kuintessence/restricted-execution-profile.conf", config);
  const capture = "#!/bin/sh\nprintf '%s\\n' \"$@\"\n";
  const policy = '{"defaultAction":"SCMP_ACT_ERRNO"}';
  await writeFile(wrapper, script, { mode: 0o755 });
  await writeFile(executable, capture, { mode: 0o755 });
  await writeFile(sif, "signed-runtime", { mode: 0o444 });
  await writeFile(seccomp, policy, { mode: 0o644 });
  const values = {
    KQ_PROFILE_ID: "test-profile",
    KQ_APPTAINER_PATH: executable,
    KQ_APPTAINER_SHA256: hash(capture),
    KQ_SIF_PATH: sif,
    KQ_SIF_SHA256: hash("signed-runtime"),
    KQ_WRAPPER_PATH: wrapper,
    KQ_WRAPPER_SHA256: hash(script),
    KQ_SECCOMP_PATH: seccomp,
    KQ_SECCOMP_SHA256: hash(policy),
  };
  const writeConfig = () =>
    writeFile(
      config,
      Object.entries(values)
        .map(([key, value]) => `${key}='${value}'`)
        .join("\n"),
      {
        mode: 0o644,
      },
    );
  await writeConfig();
  const prefix = [
    "--profile-id",
    values.KQ_PROFILE_ID,
    "--apptainer-path",
    executable,
    "--apptainer-sha256",
    values.KQ_APPTAINER_SHA256,
    "--sif-path",
    sif,
    "--sif-sha256",
    values.KQ_SIF_SHA256,
    "--wrapper-sha256",
    values.KQ_WRAPPER_SHA256,
    "--",
    executable,
    "exec",
    "--containall",
    "--cleanenv",
    "--no-home",
    "--no-eval",
    "--no-mount",
    "hostfs,cwd,home",
    "--net",
    "--network",
    "none",
    "--drop-caps",
    "all",
    "--security",
    "no-new-privs",
    "--pwd",
    "/kq",
  ];
  const tail = [
    "--bind",
    "/managed/script:/kq/script/main.sh:ro",
    sif,
    "/bin/bash",
    "/kq/script/main.sh",
  ];
  const run = (args: string[] = [...prefix, ...tail]) => realSpawner.run([wrapper, ...args]);
  return { root, wrapper, config, seccomp, sif, values, prefix, tail, writeConfig, run };
}

describe.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
  "compute-node trusted wrapper",
  () => {
    test("checks local policy at startup and injects exactly one pinned seccomp option", async () => {
      const f = await fixture();
      expect((await f.run(["--check-profile"])).exitCode).toBe(0);
      const result = await f.run();
      expect(result.exitCode).toBe(0);
      const argv = result.stdout.trim().split("\n");
      expect(argv.filter((arg) => arg === "--security")).toHaveLength(1);
      expect(argv[argv.indexOf("--security") + 1]).toBe(`no-new-privs,seccomp:${f.seccomp}`);
      expect(argv.slice(-3)).toEqual([f.sif, "/bin/bash", "/kq/script/main.sh"]);
    });

    test("refuses missing, modified, writable or linked policy before invoking Apptainer", async () => {
      const f = await fixture();
      for (const args of [["--check-profile"], [...f.prefix, ...f.tail]]) {
        await chmod(f.seccomp, 0o666);
        expect((await f.run(args)).exitCode).toBe(126);
        await chmod(f.seccomp, 0o644);
        await writeFile(f.seccomp, "changed");
        expect((await f.run(args)).exitCode).toBe(126);
        await rm(f.seccomp);
        expect((await f.run(args)).exitCode).toBe(126);
        await symlink(f.sif, f.seccomp);
        expect((await f.run(args)).exitCode).toBe(126);
        await rm(f.seccomp);
        await writeFile(f.seccomp, '{"defaultAction":"SCMP_ACT_ERRNO"}', { mode: 0o644 });
      }
    });

    test("rejects policy under a writable ancestor even when the file is protected", async () => {
      const f = await fixture();
      const parent = join(f.root, "unsafe");
      await mkdir(parent);
      const policy = join(parent, "seccomp.json");
      await writeFile(policy, await readFile(f.seccomp), { mode: 0o644 });
      await chmod(parent, 0o777);
      f.values.KQ_SECCOMP_PATH = policy;
      await f.writeConfig();
      expect((await f.run()).exitCode).toBe(126);
    });

    test("rejects missing policy configuration and security option separator injection", async () => {
      const f = await fixture();
      for (const path of ["", "relative.json", `${f.seccomp},no-new-privs`, `${f.seccomp}:extra`]) {
        f.values.KQ_SECCOMP_PATH = path;
        await f.writeConfig();
        expect((await f.run()).exitCode).toBe(126);
      }
    });

    test("refuses isolation overrides, writable mounts and extra commands", async () => {
      const f = await fixture();
      const candidates = [
        [...f.prefix, "--security", "no-new-privs", ...f.tail],
        [...f.prefix, "--bind", "/managed/output:/kq/outputs/result:rw", ...f.tail],
        [...f.prefix, "--bind", "/managed/input:/kq/inputs/a:ro,/etc:/etc:ro", ...f.tail],
        [...f.prefix, ...f.tail, "extra"],
        [...f.prefix.map((arg) => (arg === "none" ? "bridge" : arg)), ...f.tail],
      ];
      for (const args of candidates) {
        const result = await f.run(args);
        expect(result.exitCode).toBe(126);
        expect(result.stdout).toBe("");
      }
    });

    test("rejects writable SIF or changed wrapper before execution", async () => {
      const f = await fixture();
      await chmod(f.sif, 0o644);
      expect((await f.run()).exitCode).toBe(126);
      await chmod(f.sif, 0o444);
      await writeFile(f.wrapper, `${await readFile(f.wrapper, "utf8")}\n# changed\n`);
      expect((await f.run()).exitCode).toBe(126);
    });
  },
);
