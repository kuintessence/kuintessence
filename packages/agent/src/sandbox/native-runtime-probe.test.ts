import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { JobSpec, SchedulerAdapter } from "../adapters/base";
import { runNativeRuntimeProbe } from "./native-runtime-probe";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const scheduler of ["slurm", "pbs-pro", "torque"]) {
  test(`${scheduler} probe binds the explicit queue/resources and removes only terminal job files`, async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-native-probe-"));
    roots.push(root);
    let submitted: JobSpec | undefined;
    const result = await runNativeRuntimeProbe({
      root,
      queue: "sandbox",
      script: "#!/bin/bash\ntrue\n",
      adapter: (logDir) => ({
        type: scheduler,
        version: "test",
        submit: async (spec) => {
          submitted = spec;
          const prefix =
            scheduler === "slurm" ? "kq-" : scheduler === "pbs-pro" ? "kq-pbs-" : "kq-torque-";
          await writeFile(
            join(logDir, `${prefix}${spec.jobId}.out`),
            "KQ_ATTESTED_NODE=node-2\nKQ_ATTESTED_NODE=node-1\n",
          );
          return { schedulerJobId: "123" };
        },
        status: async () => ({ status: "completed", exitCode: 0 }),
        cancel: async () => {
          throw new Error("Terminal probe must not be cancelled");
        },
      }),
    });
    expect(result).toEqual(["node-1", "node-2"]);
    expect(submitted).toMatchObject({
      queueName: "sandbox",
      cpus: 1,
      memoryMb: 128,
      wallTimeSec: 120,
    });
    expect((await readdir(root)).filter((name) => name !== ".attestation.lock")).toEqual([]);
  });
}

for (const scenario of [
  "failed",
  "missing-marker",
  "timeout-stopped",
  "timeout-unknown",
  "query-failed",
  "submission-unknown",
  "submission-invalid-id",
]) {
  test(`probe ${scenario} never reports readiness or prematurely deletes live/unknown job files`, async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-native-probe-"));
    roots.push(root);
    const actions: string[] = [];
    let clock = 0;
    let originalJobId = "";
    await expect(
      runNativeRuntimeProbe({
        root,
        queue: "sandbox",
        script: "#!/bin/bash\ntrue\n",
        timeoutMs: 1,
        now: () => clock,
        sleep: async () => {
          clock = 2;
        },
        adapter: () => ({
          type: "slurm",
          version: "test",
          submit: async (spec) => {
            originalJobId = spec.jobId;
            actions.push("submit");
            if (scenario === "submission-unknown") throw new Error("submission response lost");
            if (scenario === "submission-invalid-id") return { schedulerJobId: "--all" };
            return { schedulerJobId: "123" };
          },
          status: async () => {
            if (scenario === "query-failed") throw new Error("query unavailable");
            if (scenario === "failed") return { status: "failed", exitCode: 1 };
            if (scenario === "missing-marker") return { status: "completed", exitCode: 0 };
            return { status: "running" };
          },
          cancel: async (id) => {
            actions.push("cancel");
            expect(id).toBe("123");
          },
          confirmStopped: async (id, lookup) => {
            actions.push("confirm");
            expect(id).toBe("123");
            expect(lookup?.jobId).toBe(originalJobId);
            return scenario !== "timeout-unknown";
          },
        }),
      }),
    ).rejects.toThrow();
    expect(actions.filter((action) => action === "submit")).toHaveLength(1);
    if (scenario.startsWith("submission-")) expect(actions).toEqual(["submit"]);
    const retained = ["timeout-unknown", "submission-unknown", "submission-invalid-id"].includes(
      scenario,
    );
    const directories = (await readdir(root)).filter((name) => name !== ".attestation.lock");
    expect(directories.length).toBe(retained ? 1 : 0);
    if (retained) {
      const receipt = JSON.parse(
        await readFile(join(root, directories[0] ?? "", "job.json"), "utf8"),
      );
      expect(receipt).toMatchObject({ jobId: originalJobId, scheduler: "slurm", queue: "sandbox" });
      expect(receipt.schedulerJobId).toBe(scenario === "timeout-unknown" ? "123" : undefined);
      await expect(
        runNativeRuntimeProbe({
          root,
          queue: "sandbox",
          script: "true",
          adapter: () => ({
            type: "slurm",
            version: "test",
            status: async () => ({ status: "running" }),
            cancel: async () => {
              throw new Error("Unknown original identity");
            },
            submit: async () => {
              throw new Error("Must not resubmit while the original job is unresolved");
            },
            findByKuintessenceJobId: async () => ({
              status: "indeterminate",
              reason: "unavailable",
            }),
          }),
        }),
      ).rejects.toThrow("active or unresolved");
    }
    if (
      scenario === "timeout-stopped" ||
      scenario === "timeout-unknown" ||
      scenario === "query-failed"
    ) {
      expect(actions).toEqual(["submit", "cancel", "confirm"]);
    }
  });
}

test.skipIf(process.getuid?.() !== 0)(
  "root probe account can write logs but cannot replace the protected script",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-root-probe-"));
    roots.push(root);
    await chmod(root, 0o711);
    await runNativeRuntimeProbe({
      root,
      queue: "sandbox",
      script: "#!/bin/bash\ntrue\n",
      account: { username: "nobody", uid: 65534, gid: 65534 },
      adapter: (logDir): SchedulerAdapter => ({
        type: "slurm",
        version: "test",
        submit: async (spec) => {
          const child = Bun.spawn(
            [
              "setpriv",
              "--reuid=65534",
              "--regid=65534",
              "--clear-groups",
              "/bin/bash",
              "-c",
              'test -r "$1/probe.sh" && test ! -w "$1/probe.sh" && test ! -w "$1" && test -w "$2"',
              "probe",
              dirname(logDir),
              logDir,
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          expect(await child.exited).toBe(0);
          await writeFile(join(logDir, `kq-${spec.jobId}.out`), "KQ_ATTESTED_NODE=node-1\n");
          return { schedulerJobId: "123" };
        },
        status: async () => ({ status: "completed", exitCode: 0 }),
        cancel: async () => {},
      }),
    });
    expect((await readdir(root)).filter((name) => name !== ".attestation.lock")).toEqual([]);
  },
);

test("concurrent probes submit once and do not remove the other caller's files", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-probe-concurrency-"));
  roots.push(root);
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const submitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submissions = 0;
  const run = () =>
    runNativeRuntimeProbe({
      root,
      queue: "sandbox",
      script: "true",
      adapter: (logDir) => ({
        type: "slurm",
        version: "test",
        submit: async (spec) => {
          submissions++;
          await writeFile(join(logDir, `kq-${spec.jobId}.out`), "KQ_ATTESTED_NODE=node-1\n");
          entered?.();
          await finish;
          return { schedulerJobId: "123" };
        },
        status: async () => ({ status: "completed", exitCode: 0 }),
        cancel: async () => {
          throw new Error("Successful probe must not be cancelled");
        },
      }),
    });
  const calls = [run(), run()];
  const results = Promise.allSettled(calls);
  await submitted;
  await Promise.race(calls.map((call) => call.catch(() => undefined)));
  expect(submissions).toBe(1);
  expect((await readdir(root)).filter((name) => name !== ".attestation.lock")).toEqual([
    ".attest-active",
  ]);
  release?.();
  const completed = await results;
  expect(completed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(completed.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect((await readdir(root)).filter((name) => name !== ".attestation.lock")).toEqual([]);
});

for (const mode of ["response-lost", "submitted"] as const) {
  test(`SIGKILL releases the lock and ${mode} recovery stops the original job before a fresh probe`, async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-probe-crash-"));
    roots.push(root);
    const worker = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "native-runtime-probe-crash.fixture.ts"),
        root,
        mode,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = worker.stdout.getReader();
    const deadline = setTimeout(() => worker.kill("SIGKILL"), 5_000);
    try {
      const ready = await reader.read();
      expect(ready.done).toBe(false);
      const receipt = JSON.parse(await readFile(join(root, ".attest-active/job.json"), "utf8"));
      expect(receipt.phase).toBe(mode === "response-lost" ? "submitting" : "submitted");
      expect(receipt.schedulerJobId).toBe(mode === "submitted" ? "123" : undefined);
      const actions: string[] = [];
      let stopped = false;
      const run = () =>
        runNativeRuntimeProbe({
          root,
          queue: "sandbox",
          script: "true",
          adapter: (logDir) => ({
            type: "slurm",
            version: "test",
            findByKuintessenceJobId: async (lookup) => {
              expect(lookup).toMatchObject({
                jobId: receipt.jobId,
                schedulerName: "kq-sandbox-attest",
                submittedAfterUnixMs: receipt.submittedAtUnixMs,
                executionUser: receipt.executionUser,
              });
              actions.push("find-original");
              return { status: "found", schedulerJobId: "123" };
            },
            confirmStopped: async (id) => {
              expect(id).toBe("123");
              actions.push("confirm-original");
              return stopped;
            },
            cancel: async (id) => {
              expect(id).toBe("123");
              actions.push("cancel-original");
              stopped = true;
            },
            submit: async (spec) => {
              expect(stopped).toBe(true);
              expect(spec.jobId).not.toBe(receipt.jobId);
              actions.push("submit-fresh");
              await writeFile(
                join(logDir, `kq-${spec.jobId}.out`),
                "KQ_ATTESTED_NODE=fresh-node\n",
              );
              return { schedulerJobId: "124" };
            },
            status: async (id) => {
              expect(id).toBe("124");
              return { status: "completed", exitCode: 0 };
            },
          }),
        });
      await expect(run()).rejects.toThrow("another process holds its lock");
      expect(actions).toEqual([]);
      worker.kill("SIGKILL");
      await worker.exited;
      clearTimeout(deadline);
      expect(await run()).toEqual(["fresh-node"]);
      expect(actions).toEqual([
        "find-original",
        "confirm-original",
        "cancel-original",
        "confirm-original",
        "submit-fresh",
      ]);
      expect(await readdir(root)).toEqual([".attestation.lock"]);
    } finally {
      clearTimeout(deadline);
      worker.kill("SIGKILL");
      await worker.exited;
      reader.releaseLock();
    }
  }, 10_000);
}

async function retainedFixture() {
  const root = await mkdtemp(join(tmpdir(), "kq-probe-recovery-"));
  roots.push(root);
  const active = join(root, ".attest-active");
  await mkdir(active, { mode: 0o700 });
  const account = userInfo();
  const receipt = {
    version: 1,
    jobId: crypto.randomUUID(),
    scheduler: "slurm",
    queue: "sandbox",
    executionUser: { username: account.username, uid: account.uid, gid: account.gid },
    submittedAtUnixMs: Date.now(),
    phase: "submitted",
    schedulerJobId: "123" as string | undefined,
  };
  const save = () => writeFile(join(active, "job.json"), JSON.stringify(receipt), { mode: 0o600 });
  await save();
  return { root, active, receipt, save };
}

for (const change of [
  "queue",
  "account",
  "scheduler",
  "missing",
  "invalid",
  "legacy",
  "oversize",
  "writable",
  "not-found",
  "indeterminate",
  "reused-id",
  "unsafe-id",
  "stop-unknown",
  "prepared-with-id",
  "submitting-with-id",
  "submitted-without-id",
  "receipt-symlink",
  "receipt-hardlink",
  "active-symlink",
  "lock-symlink",
  "lock-hardlink",
  "lock-writable",
] as const) {
  test(`recovery retains ${change} evidence and never submits a replacement`, async () => {
    const f = await retainedFixture();
    if (change === "queue") f.receipt.queue = "other";
    if (change === "account") f.receipt.executionUser.uid++;
    if (change === "scheduler") f.receipt.scheduler = "pbs-pro";
    if (change === "legacy") f.receipt.version = 0;
    if (change === "prepared-with-id") f.receipt.phase = "prepared";
    if (change === "submitting-with-id") f.receipt.phase = "submitting";
    if (change === "submitted-without-id") f.receipt.schedulerJobId = undefined;
    if (change === "unsafe-id") {
      f.receipt.phase = "submitting";
      f.receipt.schedulerJobId = undefined;
    }
    await f.save();
    if (change === "receipt-symlink") {
      await rename(join(f.active, "job.json"), join(f.root, "original.json"));
      await symlink(join(f.root, "original.json"), join(f.active, "job.json"));
    }
    if (change === "receipt-hardlink")
      await link(join(f.active, "job.json"), join(f.root, "original.json"));
    if (change === "active-symlink") {
      await rename(f.active, join(f.root, "original"));
      await symlink(join(f.root, "original"), f.active);
    }
    if (change.startsWith("lock-")) {
      const lock = join(f.root, ".attestation.lock");
      if (change === "lock-symlink") await symlink(join(f.active, "job.json"), lock);
      if (change === "lock-hardlink") await link(join(f.active, "job.json"), lock);
      if (change === "lock-writable") await writeFile(lock, "", { mode: 0o666 });
    }
    if (change === "missing") await rm(join(f.active, "job.json"));
    if (change === "invalid") await writeFile(join(f.active, "job.json"), "{");
    if (change === "oversize") await writeFile(join(f.active, "job.json"), " ".repeat(16_385));
    if (change === "writable") await chmod(join(f.active, "job.json"), 0o666);
    let submits = 0,
      cancels = 0;
    await expect(
      runNativeRuntimeProbe({
        root: f.root,
        queue: "sandbox",
        script: "true",
        adapter: () => ({
          type: "slurm",
          version: "test",
          findByKuintessenceJobId: async () =>
            change === "not-found"
              ? { status: "not_found" }
              : change === "indeterminate"
                ? { status: "indeterminate", reason: "unavailable" }
                : {
                    status: "found",
                    schedulerJobId:
                      change === "reused-id" ? "456" : change === "unsafe-id" ? "--all" : "123",
                  },
          status: async () => ({ status: "running" }),
          cancel: async () => {
            cancels++;
          },
          confirmStopped: async () => false,
          submit: async () => {
            submits++;
            return { schedulerJobId: "456" };
          },
        }),
      }),
    ).rejects.toThrow();
    expect(submits).toBe(0);
    expect(cancels).toBe(change === "stop-unknown" ? 1 : 0);
    expect(await readdir(f.root)).toContain(".attest-active");
  });
}

for (const phase of ["prepared", "stopped", "preparing", "retired"] as const) {
  test(`recovery removes only safely inactive ${phase} files before running a fresh probe`, async () => {
    const f = await retainedFixture();
    if (phase === "preparing" || phase === "retired") {
      await rename(f.active, join(f.root, `.attest-${phase}`));
      await rm(join(f.root, `.attest-${phase}/job.json`));
    } else {
      f.receipt.phase = phase;
      if (phase === "prepared") f.receipt.schedulerJobId = undefined;
      await f.save();
    }
    await runNativeRuntimeProbe({
      root: f.root,
      queue: "sandbox",
      script: "true",
      adapter: (logDir) => ({
        type: "slurm",
        version: "test",
        submit: async (spec) => {
          await writeFile(join(logDir, `kq-${spec.jobId}.out`), "KQ_ATTESTED_NODE=fresh\n");
          return { schedulerJobId: "124" };
        },
        status: async () => ({ status: "completed", exitCode: 0 }),
        cancel: async () => {
          throw new Error("Must not cancel a never-submitted or confirmed-stopped job");
        },
      }),
    });
    expect(await readdir(f.root)).toEqual([".attestation.lock"]);
  });
}
