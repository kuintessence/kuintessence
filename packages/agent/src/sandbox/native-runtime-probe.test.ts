import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    expect(await readdir(root)).toEqual([]);
  });
}

for (const scenario of [
  "failed",
  "missing-marker",
  "timeout-stopped",
  "timeout-unknown",
  "query-failed",
  "submission-unknown",
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
            return { schedulerJobId: "123" };
          },
          status: async () => {
            if (scenario === "query-failed") throw new Error("query unavailable");
            if (scenario === "failed") return { status: "failed", exitCode: 1 };
            if (scenario === "missing-marker") return { status: "completed", exitCode: 0 };
            return { status: "running" };
          },
          cancel: async (id) => {
            expect(id).toBe("123");
            actions.push("cancel");
          },
          confirmStopped: async (id, lookup) => {
            expect(id).toBe("123");
            expect(lookup?.jobId).toBe(originalJobId);
            actions.push("confirm");
            return scenario !== "timeout-unknown";
          },
        }),
      }),
    ).rejects.toThrow();
    expect(actions.filter((action) => action === "submit")).toHaveLength(1);
    const retained = scenario === "timeout-unknown" || scenario === "submission-unknown";
    const directories = await readdir(root);
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
          adapter: () => {
            throw new Error("Must not resubmit while the original job is unresolved");
          },
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
      account: { uid: 65534, gid: 65534 },
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
    expect(await readdir(root)).toEqual([]);
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
  expect(await readdir(root)).toEqual([".attest-active"]);
  release?.();
  const completed = await results;
  expect(completed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(completed.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(await readdir(root)).toEqual([]);
});
