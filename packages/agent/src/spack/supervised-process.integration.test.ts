import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSqliteMigrations } from "@kuintessence/db";
import { SoftwareOperationAction, SoftwareOperationStatus } from "@kuintessence/proto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SoftwareOperations } from "../queue/software-operations";
import { SpackInstallStore } from "./install-store";
import {
  prepareSpackProcessSupervision,
  recoverSpackSupervisedProcesses,
  renewSpackProcessAuthorization,
  runSpackSupervisedProcess,
  SpackProcessStoppedError,
  type SpackProcessSupervision,
  stopSpackSupervisedProcess,
} from "./supervised-process";

const integration = process.env.KQ_TEST_SYSTEMD_USER === "1" ? test : test.skip;
const fixtures: { cwd: string; ref: SpackProcessSupervision }[] = [];
async function fixture(authorizedUntil?: number) {
  const cwd = await mkdtemp(join(tmpdir(), "run-"));
  const ref = await prepareSpackProcessSupervision(cwd, 1024 ** 3, authorizedUntil);
  fixtures.push({ cwd, ref });
  return { cwd, ref, options: { cwd, env: {}, timeoutMs: 10000, maxOutputBytes: 16384 } };
}
afterEach(async () => {
  for (const { cwd, ref } of fixtures.splice(0)) {
    await stopSpackSupervisedProcess(ref);
    await rm(cwd, { recursive: true, force: true });
    await rm(ref.directory, { recursive: true, force: true });
  }
});

integration("expired installation authority cannot be renewed or launched", async () => {
  const f = await fixture(Date.now() + 500);
  await Bun.sleep(550);
  await expect(renewSpackProcessAuthorization(f.ref, Date.now() + 1000)).rejects.toThrow("expired");
  await expect(
    runSpackSupervisedProcess(
      ["/usr/bin/python3", "-c", "open('unexpected', 'w').write('ran')"],
      f.options,
      f.ref,
    ),
  ).rejects.toThrow("Expired");
  expect(await Bun.file(join(f.cwd, "unexpected")).exists()).toBe(false);
});

integration(
  "expiry while preparing supervision closes the launch gate without leaving a live owner",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "kq-expired-lease-"));
    const cwd = join(base, "run-worker");
    await mkdir(cwd, { mode: 0o700 });
    try {
      await expect(prepareSpackProcessSupervision(cwd, 1024 ** 3, Date.now() - 1)).rejects.toThrow(
        "SPACK_AUTHORIZATION_PENDING",
      );
      const units = await readdir(join(base, ".supervisors"));
      expect(units).toHaveLength(1);
      const unit = units[0];
      if (!unit) throw new Error("Missing failed preparation record");
      expect(
        JSON.parse(await readFile(join(base, ".supervisors", unit, "stopped.json"), "utf8")),
      ).toBe(unit);
      await recoverSpackSupervisedProcesses(base);
      expect(await Bun.file(join(cwd, "unexpected")).exists()).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);

integration.each(["agent-exit", "guard-frozen", "operation-deadline"] as const)(
  "renewed installation stops independently after %s without a recovery Agent",
  async (kind) => {
    const base = await mkdtemp(join(tmpdir(), "kq-lease-guard-"));
    const cwd = join(base, "run-worker");
    await mkdir(cwd, { mode: 0o700 });
    const program = `
      import { writeFile } from 'node:fs/promises';
      import { prepareSpackProcessSupervision, renewSpackProcessAuthorization, runSpackSupervisedProcess } from ${JSON.stringify(join(import.meta.dir, "supervised-process.ts"))};
      const ref = await prepareSpackProcessSupervision(${JSON.stringify(cwd)}, 1024 ** 3, Date.now() + ${kind === "operation-deadline" ? 10_000 : 1500});
      await writeFile(${JSON.stringify(join(base, "ref.json"))}, JSON.stringify(ref));
      let stopped = false;
      const renew = (async () => {
        while (!stopped) {
          await Bun.sleep(400);
          if (!stopped) await renewSpackProcessAuthorization(ref, Date.now() + ${kind === "operation-deadline" ? 10_000 : 1500});
        }
      })();
      try {
        await runSpackSupervisedProcess(['/usr/bin/python3', '-c',
          "import os,pathlib,time; pid=os.fork(); os.setsid() if pid==0 else None; pathlib.Path('pid.tmp').write_text(str(os.getpid())) if pid==0 else None; os.rename('pid.tmp','pid') if pid==0 else None; time.sleep(60)"],
          {cwd: ${JSON.stringify(cwd)}, env: {}, timeoutMs: ${kind === "operation-deadline" ? 3500 : 60000}, maxOutputBytes: 4096}, ref);
      } finally { stopped = true; await renew; }
    `;
    const child = Bun.spawn([process.execPath, "--eval", program], {
      env: { PATH: "/usr/bin:/bin" },
      stdout: "ignore",
      stderr: "pipe",
    });
    let ref: SpackProcessSupervision | undefined;
    const alive = async (pid: number) => {
      try {
        return (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.split(" ")[0] !== "Z";
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    };
    try {
      for (let i = 0; i < 300 && !(await Bun.file(join(cwd, "pid")).exists()); i++) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        await Bun.sleep(10);
      }
      const pid = Number(await readFile(join(cwd, "pid"), "utf8"));
      ref = JSON.parse(await readFile(join(base, "ref.json"), "utf8"));
      if (!ref) throw new Error("Missing authorization supervision");
      await Bun.sleep(2100);
      expect(await alive(pid)).toBe(true);
      if (kind === "guard-frozen") {
        const freeze = Bun.spawn(
          [
            "/usr/bin/systemctl",
            "--user",
            "kill",
            "--kill-whom=main",
            "--signal=SIGSTOP",
            ref.unit,
          ],
          {
            env: {
              PATH: "/usr/bin:/bin",
              XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
              DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus`,
            },
            stdout: "ignore",
            stderr: "pipe",
          },
        );
        expect(await freeze.exited).toBe(0);
      }
      child.kill("SIGKILL");
      await child.exited;
      for (let i = 0; i < (kind === "operation-deadline" ? 250 : 800) && (await alive(pid)); i++)
        await Bun.sleep(10);
      expect(await alive(pid)).toBe(false);
      // No Agent recovered the unit or fabricated a stop receipt during expiry.
      expect(await Bun.file(join(ref.directory, "stopped.json")).exists()).toBe(false);
      await stopSpackSupervisedProcess(ref);
      expect(await Bun.file(join(ref.directory, "stopped.json")).exists()).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      if (!ref && (await Bun.file(join(base, "ref.json")).exists()))
        ref = JSON.parse(await readFile(join(base, "ref.json"), "utf8"));
      if (ref) await stopSpackSupervisedProcess(ref);
      await rm(base, { recursive: true, force: true });
    }
  },
  15000,
);

integration(
  "real systemd unit preserves literal arguments and clean env, enforces limits, and records stop",
  async () => {
    const f = await fixture();
    const literal = `$HOME \${SECRET} %n ; $(id)`;
    const result = await runSpackSupervisedProcess(
      [
        "/usr/bin/python3",
        "-c",
        `
import json, os, pathlib, sys
group = pathlib.Path('/sys/fs/cgroup') / pathlib.Path('/proc/self/cgroup').read_text().strip().split('::')[1].lstrip('/')
print(json.dumps({'arg': sys.argv[1], 'secret': os.getenv('SECRET'), 'memory': (group / 'memory.max').read_text().strip(), 'swap': (group / 'memory.swap.max').read_text().strip(), 'tasks': (group / 'pids.max').read_text().strip()}))
`,
        literal,
      ],
      f.options,
      f.ref,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      arg: literal,
      secret: null,
      memory: String(1024 ** 3),
      swap: "0",
      tasks: "128",
    });
    expect(JSON.parse(await readFile(join(f.ref.directory, "stopped.json"), "utf8"))).toBe(
      f.ref.unit,
    );
  },
);

integration(
  "cancellation stops a setsid descendant which has closed the transport pipes",
  async () => {
    const f = await fixture();
    const controller = new AbortController();
    const task = runSpackSupervisedProcess(
      [
        "/usr/bin/python3",
        "-c",
        `
import os, pathlib, time
pid = os.fork()
if pid == 0:
    os.setsid()
    os.close(1)
    os.close(2)
    pathlib.Path('descendant.tmp').write_text(str(os.getpid()))
    os.rename('descendant.tmp', 'descendant')
    time.sleep(60)
else:
    time.sleep(60)
`,
      ],
      { ...f.options, signal: controller.signal },
      f.ref,
    ).catch((error: unknown) => error);
    let pid: number | undefined;
    for (let i = 0; i < 200; i++) {
      try {
        pid = Number(await readFile(join(f.cwd, "descendant"), "utf8"));
        if (pid > 0) break;
        await Bun.sleep(10);
      } catch {
        await Bun.sleep(10);
      }
    }
    controller.abort();
    expect(await task).toBeInstanceOf(SpackProcessStoppedError);
    expect(pid).toBeGreaterThan(0);
    try {
      const state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.split(" ")[0];
      expect(state).toBe("Z");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  },
  15000,
);

integration("a launch delayed until after cancellation cannot pass its durable gate", async () => {
  const f = await fixture();
  await stopSpackSupervisedProcess(f.ref);
  await runSpackSupervisedProcess(
    ["/usr/bin/python3", "-c", "open('unexpected', 'w').write('ran')"],
    f.options,
    f.ref,
  );
  expect(await Bun.file(join(f.cwd, "unexpected")).exists()).toBe(false);
});

test.each([
  0,
  -1,
  NaN,
  Infinity,
  1024 ** 3 - 1,
  1024 ** 3 + 1,
  4097 * 1024 ** 2,
])("rejects invalid memory budget %s before contacting systemd", async (memoryBytes) => {
  await expect(prepareSpackProcessSupervision("/does-not-exist", memoryBytes)).rejects.toThrow();
});

integration(
  "source-audit cancellation without a store binding uses its persisted supervision after SQLite reopen",
  async () => {
    const f = await fixture();
    const base = await mkdtemp(join(tmpdir(), "kq-audit-ledger-"));
    const path = join(base, "agent.db");
    let sqlite = new Database(path);
    runSqliteMigrations(sqlite);
    let ledger = new SoftwareOperations(drizzle(sqlite));
    const request = {
      operationId: crypto.randomUUID(),
      action: SoftwareOperationAction.INSTALL,
      spec: "fixture@1",
      durableReplay: true,
      requestedBy: "fixture",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      federationJobId: crypto.randomUUID(),
    };
    try {
      await ledger.receive(request);
      await expect(ledger.bindSupervisor(request.operationId, f.ref)).rejects.toThrow();
      await ledger.start(request.operationId);
      await ledger.bindSupervisor(request.operationId, f.ref);
      await runSpackSupervisedProcess(
        ["/usr/bin/python3", "-c", "raise SystemExit(7)"],
        f.options,
        f.ref,
      );
      await expect(ledger.assertJobStopped(request.federationJobId)).rejects.toThrow();
      await ledger.finish({ ...request, status: SoftwareOperationStatus.FAILED, exitCode: 7 });
      await expect(ledger.bindSupervisor(request.operationId, f.ref)).rejects.toThrow();
      sqlite.close();
      sqlite = new Database(path);
      ledger = new SoftwareOperations(drizzle(sqlite));
      await ledger.assertJobStopped(request.federationJobId);
      const row = sqlite.query("SELECT store_root, stopped_at FROM software_executions").get();
      expect(row).toMatchObject({ store_root: null, stopped_at: expect.any(Number) });
    } finally {
      sqlite.close();
      await rm(base, { recursive: true, force: true });
    }
  },
);

integration.each(["store", "audit"] as const)(
  "new Agent process stops an orphaned unit before %s recovery and input cleanup",
  async (kind) => {
    const base = await mkdtemp(join(tmpdir(), "kq-supervised-recovery-"));
    const cwd = join(base, "run-worker");
    const root = join(base, "store");
    await mkdir(cwd, { mode: 0o700 });
    const program = `
    import { writeFile } from "node:fs/promises";
    import { SpackInstallStore } from ${JSON.stringify(join(import.meta.dir, "install-store.ts"))};
    import { installWorkerExecution } from ${JSON.stringify(join(import.meta.dir, "execution-identity.ts"))};
    import { prepareSpackProcessSupervision, runSpackSupervisedProcess } from ${JSON.stringify(join(import.meta.dir, "supervised-process.ts"))};
    const store = new SpackInstallStore(${JSON.stringify(root)});
    await store.initialize();
    await store.withLock(async () => {
      const record = await store.create({manifestDigest: 'sha256:' + 'a'.repeat(64), manifestSize: 1,
        siteProfileDigest: 'sha256:' + 'b'.repeat(64), spec: 'fixture@1', rootHash: 'a'.repeat(32)});
      const ref = await prepareSpackProcessSupervision(${JSON.stringify(cwd)}, 1024 ** 3);
      await installWorkerExecution.getStore().start(record.id, ref);
      await writeFile(${JSON.stringify(join(base, "ref.json"))}, JSON.stringify(ref));
      await runSpackSupervisedProcess(['/usr/bin/python3', '-c',
        "import os,pathlib,time; pid=os.fork(); os.setsid() if pid==0 else None; pathlib.Path('pid.tmp').write_text(str(os.getpid())) if pid==0 else None; os.rename('pid.tmp','pid') if pid==0 else None; time.sleep(60)"],
        {cwd: ${JSON.stringify(cwd)}, env: {}, timeoutMs: 60000, maxOutputBytes: 4096}, ref);
    });`;
    const child = Bun.spawn([process.execPath, "--eval", program], {
      env: { PATH: "/usr/bin:/bin" },
      stdout: "ignore",
      stderr: "pipe",
    });
    let ref: SpackProcessSupervision | undefined;
    try {
      for (let i = 0; i < 300 && !(await Bun.file(join(cwd, "pid")).exists()); i++) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        await Bun.sleep(10);
      }
      const pid = Number(await readFile(join(cwd, "pid"), "utf8"));
      ref = JSON.parse(await readFile(join(base, "ref.json"), "utf8"));
      if (!ref) throw new Error("Missing child supervision receipt");
      process.kill(pid, 0);
      await expect(recoverSpackSupervisedProcesses(base)).rejects.toThrow("SPACK_LOCK_HELD");
      child.kill("SIGKILL");
      await child.exited;
      process.kill(pid, 0);
      expect((await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.split(" ")[0]).not.toBe(
        "Z",
      );
      expect(await Bun.file(join(ref.directory, "stopped.json")).exists()).toBe(false);
      if (kind === "audit") await recoverSpackSupervisedProcesses(base);
      const store = new SpackInstallStore(root);
      await store.withLock(async () => {});
      expect((await store.list())[0]?.state).toBe("failed");
      expect(await Bun.file(join(cwd, "pid")).exists()).toBe(false);
      expect(JSON.parse(await readFile(join(ref.directory, "stopped.json"), "utf8"))).toBe(
        ref.unit,
      );
      try {
        const state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.split(" ")[0];
        expect(state).toBe("Z");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      if (ref) await stopSpackSupervisedProcess(ref);
      await rm(base, { recursive: true, force: true });
    }
  },
  15000,
);
