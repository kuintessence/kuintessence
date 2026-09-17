import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SlurmAdapter } from "../../src/adapters/slurm";
import { ContainerSpawner } from "../../src/adapters/spawner-container";
import { type SlurmCluster, startSlurmCluster } from "../fixtures/slurm-cluster";

let cluster: SlurmCluster;
let adapter: SlurmAdapter;

beforeAll(async () => {
  cluster = await startSlurmCluster();
  adapter = new SlurmAdapter("21.08.5", {
    spawner: new ContainerSpawner(cluster.containerId),
    logDir: "/var/tmp/kq-slurm-shared",
    terminalStatusBackend: "scontrol",
  });
}, 180_000);

afterAll(async () => {
  await cluster?.stop();
});

describe("SlurmAdapter — real cluster", () => {
  test("submits from stdin and uses the container-visible default log directory", async () => {
    const submit = await adapter.submit({
      jobId: "19a20bcd-9761-4659-be4a-5ba445befc0a",
      name: "echo-test",
      command: 'echo "kuintessence ok"',
      cpus: 1,
      memoryMb: 64,
      gpus: 0,
      wallTimeSec: 300,
      workingDir: "",
      envVars: {},
    });
    expect(submit.schedulerJobId).toMatch(/^\d+$/);

    const final = await pollUntilTerminal(adapter, submit.schedulerJobId, 30_000);
    expect(final.status).toBe("completed");
    expect(final.exitCode).toBe(0);
    await expect(adapter.getJobLogs(submit.schedulerJobId, 50)).resolves.toContain(
      "kuintessence ok",
    );
  }, 60_000);

  // tbd #11 live sign-off: a user cancel must actually kill the cluster job.
  // We submit `sleep 120`, scancel it, then assert it reaches a terminal,
  // non-completed state quickly — if scancel were a no-op the job would still
  // be RUNNING at the deadline and pollUntilTerminal would throw.
  test("scancel kills a running job (cancel propagation)", async () => {
    const submit = await adapter.submit({
      jobId: "test-cancel-1",
      name: "sleep-cancel",
      command: "sleep 120",
      cpus: 1,
      memoryMb: 64,
      gpus: 0,
      wallTimeSec: 300,
      workingDir: "/tmp",
      envVars: {},
    });
    expect(submit.schedulerJobId).toMatch(/^\d+$/);

    // Wait until Slurm has registered the job (queued or running) so scancel
    // has something concrete to act on.
    await pollUntilStatus(adapter, submit.schedulerJobId, ["queued", "running"], 30_000);

    await adapter.cancel(submit.schedulerJobId);

    const final = await pollUntilTerminal(adapter, submit.schedulerJobId, 30_000);
    expect(final.status).not.toBe("completed");
  }, 90_000);
});

async function pollUntilStatus(
  a: SlurmAdapter,
  schedJobId: string,
  want: ReadonlyArray<Awaited<ReturnType<SlurmAdapter["status"]>>["status"]>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<SlurmAdapter["status"]>> | null = null;
  while (Date.now() < deadline) {
    last = await a.status(schedJobId);
    if (want.includes(last.status)) return;
    await Bun.sleep(1000);
  }
  throw new Error(
    `Job ${schedJobId} never reached ${want.join("/")} in ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

async function pollUntilTerminal(
  a: SlurmAdapter,
  schedJobId: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<SlurmAdapter["status"]>>> {
  const deadline = Date.now() + timeoutMs;
  let last: Awaited<ReturnType<SlurmAdapter["status"]>> | null = null;
  while (Date.now() < deadline) {
    last = await a.status(schedJobId);
    if (last.status === "completed" || last.status === "failed") return last;
    await Bun.sleep(1000);
  }
  throw new Error(
    `Job ${schedJobId} did not terminate in ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}
