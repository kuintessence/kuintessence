import { describe, expect, test } from "bun:test";
import type { Spawner } from "./base";
import { detectScheduler } from "./detect";
import { K8sAdapter } from "./k8s";
import { PbsProAdapter } from "./pbs-pro";
import { SlurmAdapter } from "./slurm";
import { TorqueAdapter } from "./torque";

/** Build a spawner that returns fixed responses keyed by the first command token. */
function routedSpawner(
  routes: Record<string, { exitCode: number; stdout: string; stderr?: string }>,
): Spawner {
  return {
    async run(cmd) {
      const key = cmd[0] ?? "";
      const r = routes[key];
      if (r) return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? "" };
      // Any command not in routes is treated as "not found"
      return { exitCode: 127, stdout: "", stderr: `${key}: command not found` };
    },
  };
}

describe("detectScheduler – Slurm detection", () => {
  test("returns SlurmAdapter when sbatch is available", async () => {
    const spawner = routedSpawner({
      sbatch: { exitCode: 0, stdout: "slurm 23.02.7\n" },
    });
    const adapter = await detectScheduler({ spawner });
    expect(adapter.type).toBe("slurm");
    expect(adapter.version).toBe("23.02.7");
  });

  test("version string strips 'slurm ' prefix", async () => {
    const spawner = routedSpawner({
      sbatch: { exitCode: 0, stdout: "slurm 20.11.9\n" },
    });
    const adapter = await detectScheduler({ spawner });
    expect(adapter.version).toBe("20.11.9");
  });

  test("version string strips Ubuntu's 'slurm-wlm ' prefix", async () => {
    const spawner = routedSpawner({
      sbatch: { exitCode: 0, stdout: "slurm-wlm 23.11.4\n" },
    });
    const adapter = await detectScheduler({ spawner });
    expect(adapter.version).toBe("23.11.4");
  });
});

describe("detectScheduler – PBS Pro detection", () => {
  test("returns PbsProAdapter when qsub --version reports pbs_version", async () => {
    const spawner = routedSpawner({
      sbatch: { exitCode: 127, stdout: "" },
      qsub: { exitCode: 0, stdout: "pbs_version = 19.2.4\n" },
    });
    const adapter = await detectScheduler({ spawner });
    expect(adapter.type).toBe("pbs-pro");
    expect(adapter.version).toBe("19.2.4");
  });

  test("returns PbsProAdapter when qsub output contains 'pbspro'", async () => {
    const spawner = routedSpawner({
      sbatch: { exitCode: 127, stdout: "" },
      qsub: { exitCode: 0, stdout: "PBSPro 22.05.11\n" },
    });
    const adapter = await detectScheduler({ spawner });
    expect(adapter.type).toBe("pbs-pro");
  });
});

describe("detectScheduler – Torque detection", () => {
  test("returns TorqueAdapter when qsub --version reports Version (Torque style)", async () => {
    const spawner = routedSpawner({
      sbatch: { exitCode: 127, stdout: "" },
      qsub: { exitCode: 0, stdout: "Version: 6.1.1.1\n" },
    });
    const adapter = await detectScheduler({ spawner });
    expect(adapter.type).toBe("torque");
    expect(adapter.version).toBe("6.1.1");
  });
});

describe("detectScheduler – Kubernetes detection", () => {
  test("returns K8sAdapter when kubectl is available", async () => {
    const kubectlOutput = JSON.stringify({
      clientVersion: { gitVersion: "v1.28.3" },
    });
    const spawner = routedSpawner({
      sbatch: { exitCode: 127, stdout: "" },
      qsub: { exitCode: 127, stdout: "" },
      kubectl: { exitCode: 0, stdout: kubectlOutput },
    });
    const adapter = await detectScheduler({ spawner });
    expect(adapter.type).toBe("kubernetes");
    expect(adapter.version).toBe("v1.28.3");
  });

  test("falls back to K8sAdapter version 0.0 when kubectl JSON is malformed", async () => {
    const spawner = routedSpawner({
      sbatch: { exitCode: 127, stdout: "" },
      qsub: { exitCode: 127, stdout: "" },
      kubectl: { exitCode: 0, stdout: "Client Version: v1.28.3\n" },
    });
    const adapter = await detectScheduler({ spawner });
    expect(adapter.type).toBe("kubernetes");
    expect(adapter.version).toBe("0.0");
  });
});

describe("detectScheduler – force override", () => {
  test("forwards separate script and log directories to every HPC adapter", async () => {
    const spawner: Spawner = {
      async run() {
        throw new Error("should not run");
      },
    };
    const spec = {
      jobId: "job-logs",
      name: "logs",
      command: "true",
      cpus: 1,
      memoryMb: 64,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "",
      envVars: {},
    };
    const [slurm, pbsPro, torque] = await Promise.all([
      detectScheduler({
        spawner,
        forceType: "slurm",
        slurmDeps: { logDir: "/shared/logs" },
      }),
      detectScheduler({
        spawner,
        forceType: "pbs-pro",
        pbsProDeps: { logDir: "/shared/logs" },
      }),
      detectScheduler({
        spawner,
        forceType: "torque",
        torqueDeps: { logDir: "/shared/logs" },
      }),
    ]);

    expect(slurm).toBeInstanceOf(SlurmAdapter);
    expect(pbsPro).toBeInstanceOf(PbsProAdapter);
    expect(torque).toBeInstanceOf(TorqueAdapter);
    expect((slurm as SlurmAdapter).buildSubmitScript(spec)).toContain("/shared/logs/");
    expect((pbsPro as PbsProAdapter).buildSubmitScript(spec)).toContain("/shared/logs/");
    expect((torque as TorqueAdapter).buildSubmitScript(spec)).toContain("/shared/logs/");
  });

  test("forceType=slurm skips detection", async () => {
    // Spawner would never be called — but safe to provide a broken one
    const spawner: Spawner = {
      async run() {
        throw new Error("should not run");
      },
    };
    const adapter = await detectScheduler({ spawner, forceType: "slurm", forceVersion: "23.05" });
    expect(adapter.type).toBe("slurm");
    expect(adapter.version).toBe("23.05");
  });

  test("forceType=pbs-pro skips detection", async () => {
    const spawner: Spawner = {
      async run() {
        throw new Error("should not run");
      },
    };
    const adapter = await detectScheduler({ spawner, forceType: "pbs-pro", forceVersion: "19.0" });
    expect(adapter.type).toBe("pbs-pro");
  });

  test("forceType=torque skips detection", async () => {
    const spawner: Spawner = {
      async run() {
        throw new Error("should not run");
      },
    };
    const adapter = await detectScheduler({ spawner, forceType: "torque" });
    expect(adapter.type).toBe("torque");
    expect(adapter.version).toBe("0.0.0");
  });

  test("forceType=kubernetes skips detection", async () => {
    const spawner: Spawner = {
      async run() {
        throw new Error("should not run");
      },
    };
    const adapter = await detectScheduler({
      spawner,
      forceType: "kubernetes",
      forceVersion: "v1.29.0",
    });
    expect(adapter.type).toBe("kubernetes");
  });

  test("forwards the controlled default image to the Kubernetes adapter", async () => {
    const adapter = await detectScheduler({
      spawner: routedSpawner({
        kubectl: {
          exitCode: 0,
          stdout: '{"clientVersion":{"gitVersion":"v1.31.6+k3s1"}}',
        },
      }),
      k8sDeps: { defaultImage: "kq-governed-spack:zlib-1.3.1" },
    });
    expect(adapter.type).toBe("kubernetes");
    if (!(adapter instanceof K8sAdapter)) throw new Error("expected Kubernetes adapter");
    const manifest = adapter.buildJobManifest({
      jobId: "controlled-image",
      name: "controlled-image",
      command: "true",
      workingDir: "/tmp",
      envVars: {},
      cpus: 1,
      memoryMb: 64,
      gpus: 0,
      wallTimeSec: 60,
    }) as {
      spec: { template: { spec: { containers: Array<{ image: string }> } } };
    };
    expect(manifest.spec.template.spec.containers[0]?.image).toBe("kq-governed-spack:zlib-1.3.1");
  });
});

describe("detectScheduler – no scheduler found", () => {
  test("throws when no scheduler is on PATH", async () => {
    const spawner = routedSpawner({});
    await expect(detectScheduler({ spawner })).rejects.toThrow(/No supported scheduler/);
  });

  test("throws when spawner throws for all commands", async () => {
    const spawner: Spawner = {
      async run() {
        throw new Error("ENOENT");
      },
    };
    await expect(detectScheduler({ spawner })).rejects.toThrow();
  });
});
