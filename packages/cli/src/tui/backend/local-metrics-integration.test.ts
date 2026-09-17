import { describe, expect, test } from "bun:test";
import type { SchedulerAdapter, Spawner } from "@kuintessence/agent/adapters";
import { LocalBackend } from "./local";
import { makeLocalSampler } from "./select";

/**
 * Scenario 2 (all-in-one) Metrics end-to-end through the *real* monitor readers
 * (`readDiskUsedPercent`/`readGpuMetrics`/`readSchedulerQueueDepth`) and the
 * real production sampler `makeLocalSampler`, with only the spawner mocked.
 * Mirrors local-integration.test.ts (which does this for the scheduler
 * adapters), so the "download the binary to a login node and the Metrics pane
 * works" guarantee is CI-checked, not just hand-smoke-tested. CPU/mem come from
 * the host `/proc` (real; 0 on non-Linux), asserted only as finite numbers.
 */
function scriptedSpawner(byCommand: Record<string, string>): Spawner {
  return {
    async run(cmd) {
      const out = byCommand[cmd[0] ?? ""];
      if (out === undefined) throw new Error(`no scripted response for ${cmd[0]}`);
      return { exitCode: 0, stdout: out, stderr: "" };
    },
  };
}

const adapter: SchedulerAdapter = {
  type: "slurm",
  version: "23.02.7",
  async submit() {
    return { schedulerJobId: "1" };
  },
  async cancel() {},
  async status() {
    return { status: "running" };
  },
};

describe("LocalBackend Metrics × real monitor (scenario 2 full stack)", () => {
  test("samples disk via df, GPUs via nvidia-smi, queue depth via squeue", async () => {
    const spawner = scriptedSpawner({
      df: "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/disk1 100 71 29 71% /\n",
      "nvidia-smi": "0, NVIDIA A100, 12000, 40000, 88\n1, NVIDIA A100, 500, 40000, 12\n",
      squeue: "j1\nj2\nj3\n",
    });
    const backend = new LocalBackend(adapter, makeLocalSampler("slurm", spawner));

    expect(backend.capabilities.metrics).toBe(true);
    const [node] = await backend.listAgents();
    expect(node?.id).toBe("local");
    expect(node?.diskUsedPercent).toBe(71);
    expect(node?.queueDepth).toBe(3);
    expect(node?.gpus).toEqual([
      { index: 0, model: "NVIDIA A100", utilPercent: 88, memUsedMb: 12000, memTotalMb: 40000 },
      { index: 1, model: "NVIDIA A100", utilPercent: 12, memUsedMb: 500, memTotalMb: 40000 },
    ]);
    expect(typeof node?.cpuPercent).toBe("number");
    expect(typeof node?.memoryUsedMb).toBe("number");
  });

  test("GPU read failure degrades to an empty list, not a throw", async () => {
    const spawner: Spawner = {
      async run(cmd) {
        if (cmd[0] === "nvidia-smi") throw new Error("ENOENT");
        if (cmd[0] === "df") return { exitCode: 0, stdout: "h\n/d 1 1 1 40% /\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const backend = new LocalBackend(adapter, makeLocalSampler("slurm", spawner));
    const [node] = await backend.listAgents();
    expect(node?.gpus).toEqual([]);
    expect(node?.diskUsedPercent).toBe(40);
  });
});
