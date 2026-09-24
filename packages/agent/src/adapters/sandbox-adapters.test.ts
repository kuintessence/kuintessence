import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { JobSpec, SandboxJobSpec, Spawner } from "./base";
import {
  buildApptainerSandboxArgv,
  buildApptainerSandboxCommand,
  buildTrustedSandboxArgv,
} from "./base";
import { K8sAdapter } from "./k8s";
import { PbsProAdapter } from "./pbs-pro";
import { SlurmAdapter } from "./slurm";
import { TorqueAdapter } from "./torque";

function unixSandbox(): SandboxJobSpec {
  return {
    language: "python",
    entrypoint: "main.py",
    scriptContent: "print('ok')\n",
    scriptHostPath: "/managed/job/script/main.py",
    contextHostPath: "/managed/job/context.json",
    runtimeKind: "SIF",
    runtimePath: "/managed/runtimes/python.sif",
    executionMode: "RootImpersonation",
    identity: {
      mode: "MappedAccount",
      backend: "Unix",
      accountId: "00000000-0000-0000-0000-000000000001",
      username: "scientist",
      uid: 1001,
      gid: 1001,
      schedulerAccount: "science",
      allowedQueues: ["compute"],
    },
    mounts: [
      {
        descriptor: "input",
        ioType: "File",
        mode: "ReadOnly",
        hostPath: "/managed/job/inputs/data.csv",
        relativePath: "inputs/data.csv",
        containerPath: "/kq/inputs/input",
        expectedSha256: "a".repeat(64),
        sizeLimitBytes: 1_000,
        required: true,
      },
      {
        descriptor: "output",
        ioType: "JSON",
        mode: "WriteOnly",
        hostPath: "/managed/job/outputs/result.json",
        relativePath: "outputs/result.json",
        containerPath: "/kq/outputs/output",
        sizeLimitBytes: 1_000,
        required: true,
      },
    ],
    limits: { pids: 32, outputBytes: 2_000, logBytes: 1_000 },
  };
}

function kubernetesSandbox(): SandboxJobSpec {
  return {
    ...unixSandbox(),
    runtimeKind: "OCI",
    runtimePath: `registry.example/kq/python@sha256:${"1".repeat(64)}`,
    identity: {
      mode: "MappedAccount",
      backend: "Kubernetes",
      accountId: "00000000-0000-0000-0000-000000000001",
      namespace: "kq-user-a",
      serviceAccount: "user-a",
    },
    kubernetesArtifactPvc: "kq-artifacts",
  };
}

function job(sandbox: SandboxJobSpec = unixSandbox()): JobSpec {
  return {
    jobId: "00000000-0000-0000-0000-000000000111",
    name: "sandbox-job",
    command: "curl https://attacker.invalid",
    cpus: 2,
    memoryMb: 512,
    gpus: 0,
    wallTimeSec: 60,
    workingDir: "/managed/job",
    envVars: { HOST_SECRET: "must-not-leak" },
    queueName: "compute",
    sandbox,
  };
}

describe("HPC Sandbox adapters", () => {
  test("builds a minimal Apptainer command without the user command or host environment", () => {
    const argv = buildApptainerSandboxArgv(unixSandbox());
    expect(argv).toContain("--containall");
    expect(argv).toContain("--cleanenv");
    expect(argv).toContain("--no-home");
    expect(argv).not.toContain("--writable-tmpfs");
    expect(argv).toContain("none");
    expect(argv).toContain("all");
    expect(argv.join(" ")).not.toContain("attacker.invalid");
    expect(argv.join(" ")).toContain("/kq/script/main.py");
    expect(buildApptainerSandboxCommand(unixSandbox())).toContain("head -c 1000");
  });

  test("uses the verified absolute binary instead of a malicious PATH entry", () => {
    const previousPath = process.env.PATH;
    process.env.PATH = "/tmp/attacker/apptainer";
    try {
      const argv = buildApptainerSandboxArgv({
        ...unixSandbox(),
        apptainerPath: "/opt/kq/bin/apptainer",
      });
      expect(argv[0]).toBe("/opt/kq/bin/apptainer");
      expect(argv).not.toContain("/tmp/attacker/apptainer");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("Slurm submits scheduler CLI under the resolved uid/gid", async () => {
    const commands: string[][] = [];
    let script = "";
    const spawner: Spawner = {
      run: async (command, options) => {
        commands.push(command);
        script = options?.stdin ?? "";
        return { exitCode: 0, stdout: "123\n", stderr: "" };
      },
    };
    const adapter = new SlurmAdapter("23", {
      spawner,
      logDir: "/private/agent/.scheduler-logs",
    });
    await adapter.submit(job());
    expect(commands[0]?.slice(0, 5)).toEqual([
      "setpriv",
      "--reuid=1001",
      "--regid=1001",
      "--init-groups",
      "--",
    ]);
    expect(script).toContain("#SBATCH --account=science");
    expect(script).toContain(
      "#SBATCH --output=/managed/job/kq-00000000-0000-0000-0000-000000000111.out",
    );
    expect(script).toContain(
      "#SBATCH --error=/managed/job/kq-00000000-0000-0000-0000-000000000111.out",
    );
    expect(script).toContain("#SBATCH --chdir=/managed/job");
    expect(script).not.toContain("/private/agent/.scheduler-logs");
    expect(script).not.toContain("attacker.invalid");
    expect(script).not.toContain("HOST_SECRET");
  });

  test("SelfAccount submits without setpriv and binds the locally attested seccomp profile", async () => {
    const commands: string[][] = [];
    let script = "";
    const sandbox = unixSandbox();
    sandbox.executionMode = "SelfAccount";
    sandbox.runtimeAttestationId = "a".repeat(64);
    sandbox.identity = {
      mode: "MappedAccount",
      backend: "Unix",
      accountId: "00000000-0000-0000-0000-000000000001",
      username: "kqagent",
      uid: 2001,
      gid: 2001,
      schedulerAccount: "science",
      allowedQueues: ["compute"],
    };
    sandbox.selfAccount = { username: "kqagent", uid: 2001, gid: 2001 };
    sandbox.apptainerPath = "/usr/bin/apptainer";
    sandbox.seccompProfilePath = "/etc/kuintessence/seccomp.json";
    sandbox.attestedNodes = ["slurm-2"];
    const adapter = new SlurmAdapter("23", {
      logDir: "/private/agent/.scheduler-logs",
      spawner: {
        run: async (command, options) => {
          commands.push(command);
          script = options?.stdin ?? "";
          return { exitCode: 0, stdout: "124\n", stderr: "" };
        },
      },
    });

    await adapter.submit(job(sandbox));

    expect(commands[0]?.slice(0, 2)).toEqual(["sbatch", "--parsable"]);
    expect(script).toContain(
      "#SBATCH --output=/managed/job/kq-00000000-0000-0000-0000-000000000111.out",
    );
    expect(script).toContain(
      "#SBATCH --error=/managed/job/kq-00000000-0000-0000-0000-000000000111.out",
    );
    expect(script).toContain("#SBATCH --chdir=/managed/job");
    expect(script).not.toContain("/private/agent/.scheduler-logs");
    expect(script).toContain("#SBATCH --nodelist=slurm-2");
    expect(script).toContain("seccomp:/etc/kuintessence/seccomp.json");
    expect(script).toContain("/usr/bin/apptainer");
    expect(() =>
      new SlurmAdapter("23").buildSubmitScript(
        job({
          ...sandbox,
          selfAccount: { username: "kqagent", uid: 2002, gid: 2001 },
        }),
      ),
    ).toThrow("does not match local execution facts");
  });

  test("PBS Pro and Torque pin the scheduler account and reject an unauthorized queue", async () => {
    expect(new PbsProAdapter("23").buildSubmitScript(job())).toContain("#PBS -A science");
    expect(new TorqueAdapter("6").buildSubmitScript(job())).toContain("#PBS -A science");
    const value = job();
    value.queueName = "admin";
    await expect(
      new SlurmAdapter("23", {
        spawner: { run: async () => ({ exitCode: 0, stdout: "1", stderr: "" }) },
      }).submit(value),
    ).rejects.toThrow("not entitled");
  });

  test("rejects scheduler directive and bind-path injection", () => {
    const injectedName = job();
    injectedName.name = "safe\n#SBATCH --uid=0";
    expect(() => new SlurmAdapter("23").buildSubmitScript(injectedName)).toThrow("scheduler-safe");
    const displayName = job();
    displayName.name = "Human readable Sandbox";
    displayName.schedulerName = "kq-job1234567";
    const script = new SlurmAdapter("23").buildSubmitScript(displayName);
    expect(script).toContain("#SBATCH --job-name=kq-job1234567");
    expect(script).not.toContain(displayName.name);
    const injectedPath = unixSandbox();
    injectedPath.scriptHostPath = "/managed/job:rw,/etc/passwd";
    expect(() => buildApptainerSandboxArgv(injectedPath)).toThrow("bind paths");
  });

  test("rejects raw scheduler commands for restricted jobs in every HPC adapter", () => {
    const restrictedRaw = {
      ...job(),
      sandbox: undefined,
      restrictedNoEgress: true,
    };
    expect(() => new SlurmAdapter("23").buildSubmitScript(restrictedRaw)).toThrow(
      "trusted execution profile",
    );
    expect(() => new PbsProAdapter("23").buildSubmitScript(restrictedRaw)).toThrow(
      "trusted execution profile",
    );
    expect(() => new TorqueAdapter("6").buildSubmitScript(restrictedRaw)).toThrow(
      "trusted execution profile",
    );
  });

  test("uses the signed root-owned wrapper argv for every restricted HPC adapter", () => {
    const sandbox = {
      ...unixSandbox(),
      mounts: unixSandbox().mounts.filter((mount) => mount.mode === "ReadOnly"),
      apptainerPath: "/opt/kq/bin/apptainer",
      executionProfile: {
        profileId: "00000000-0000-4000-8000-000000000444",
        apptainerCanonicalPath: "/opt/kq/bin/apptainer",
        apptainerSha256: "b".repeat(64),
        sifCanonicalPath: "/managed/runtimes/python.sif",
        sifSha256: "c".repeat(64),
        trustedWrapperCanonicalPath: "/usr/libexec/kuintessence/kq-sandbox-wrapper",
        trustedWrapperSha256: "d".repeat(64),
      },
    };
    const restricted = { ...job(sandbox), restrictedNoEgress: true };
    const argv = buildTrustedSandboxArgv(sandbox, buildApptainerSandboxArgv(sandbox));
    expect(argv.slice(0, 12)).toEqual([
      "/usr/libexec/kuintessence/kq-sandbox-wrapper",
      "--profile-id",
      "00000000-0000-4000-8000-000000000444",
      "--apptainer-path",
      "/opt/kq/bin/apptainer",
      "--apptainer-sha256",
      "b".repeat(64),
      "--sif-path",
      "/managed/runtimes/python.sif",
      "--sif-sha256",
      "c".repeat(64),
      "--wrapper-sha256",
    ]);
    for (const adapter of [
      new SlurmAdapter("23"),
      new PbsProAdapter("23"),
      new TorqueAdapter("6"),
    ]) {
      expect(adapter.buildSubmitScript(restricted)).toContain(
        "/usr/libexec/kuintessence/kq-sandbox-wrapper",
      );
    }
    const altered = { ...sandbox, runtimePath: "/tmp/attacker.sif" };
    expect(() =>
      new SlurmAdapter("23").buildSubmitScript({ ...job(altered), restrictedNoEgress: true }),
    ).toThrow("execution profile was altered");
  });
});

describe("Kubernetes Sandbox adapter", () => {
  test("refuses to build a Sandbox Job without an attested Localhost seccomp profile", () => {
    const value = job(kubernetesSandbox());
    value.queueName = "kq-user-a";
    expect(() => new K8sAdapter("1.30").buildJobManifest(value)).toThrow(
      "verified Localhost seccomp profile",
    );
  });

  test("emits default-deny networking and a hardened non-root Job", () => {
    const sandbox = kubernetesSandbox();
    const value = job(sandbox);
    value.queueName = "kq-user-a";
    const list = new K8sAdapter("1.30", {
      sandboxSeccompProfile: {
        localhostProfile: "kuintessence/kq-no-network.json",
        nodeName: "k3s-1",
        assertCurrent: async () => {},
      },
    }).buildJobManifest(value) as {
      kind: string;
      items: Array<Record<string, unknown>>;
    };
    expect(list.kind).toBe("List");
    expect(list.items.some((item) => item.kind === "NetworkPolicy")).toBe(true);
    const configMap = list.items.find((item) => item.kind === "ConfigMap") as {
      data: { "context.json": string };
    };
    expect(JSON.parse(configMap.data["context.json"])).toEqual({
      jobId: value.jobId,
      inputs: { input: { type: "File", path: "/kq/inputs/input" } },
      outputs: { output: { type: "JSON", path: "/kq/outputs/output" } },
    });
    const resource = list.items.find((item) => item.kind === "Job") as {
      spec: {
        template: {
          spec: {
            serviceAccountName: string;
            automountServiceAccountToken: boolean;
            nodeName: string;
            securityContext: {
              runAsNonRoot: boolean;
              seccompProfile: { type: string; localhostProfile: string };
            };
            volumes: Array<{
              name: string;
              configMap?: { name: string; defaultMode: number };
            }>;
            containers: Array<{
              command: string[];
              securityContext: {
                allowPrivilegeEscalation: boolean;
                readOnlyRootFilesystem: boolean;
                capabilities: { drop: string[] };
              };
            }>;
          };
        };
      };
    };
    const pod = resource.spec.template.spec;
    expect(pod.serviceAccountName).toBe("user-a");
    expect(pod.nodeName).toBe("k3s-1");
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toEqual({
      runAsNonRoot: true,
      seccompProfile: {
        type: "Localhost",
        localhostProfile: "kuintessence/kq-no-network.json",
      },
    });
    expect(pod.volumes.find((volume) => volume.name === "script")?.configMap?.defaultMode).toBe(
      0o444,
    );
    expect(pod.containers[0]?.command).toEqual([
      "/bin/bash",
      "-o",
      "pipefail",
      "-c",
      "ulimit -u 32; '/usr/bin/python3' '/kq/script/main.py' 2>&1 | head -c 1000",
    ]);
    expect(pod.containers[0]?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
  });

  test("copies verified File inputs into the managed PVC before submit", async () => {
    const calls: string[][] = [];
    let stagerManifest: Record<string, unknown> | undefined;
    const responses = [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const adapter = new K8sAdapter("1.30", {
      tmpDir: "/tmp",
      sandboxSeccompProfile: {
        localhostProfile: "kuintessence/kq-no-network.json",
        nodeName: "k3s-1",
        assertCurrent: async () => {},
      },
      spawner: {
        run: async (command) => {
          calls.push(command);
          if (command[1] === "apply" && command[3]) {
            stagerManifest = JSON.parse(await readFile(command[3], "utf8"));
          }
          const result = responses.shift();
          if (!result) throw new Error("unexpected kubectl call");
          return result;
        },
      },
    });
    await adapter.stageSandboxInputs(kubernetesSandbox(), "00000000-0000-0000-0000-000000000111");
    expect(calls[0]).toContain("apply");
    expect(calls[1]).toContain("pod/kq-00000000-0000-0000-0000-000000000111-stage");
    expect(calls[2]).toContain("mkdir");
    expect(calls[3]).toContain("/managed/job/inputs/data.csv");
    expect(calls[3]).toContain(
      "kq-user-a/kq-00000000-0000-0000-0000-000000000111-stage:/artifacts/inputs/data.csv",
    );
    expect(calls[4]).toContain("--ignore-not-found");
    const stager = (stagerManifest?.items as Array<Record<string, unknown>>).find(
      (item) => item.kind === "Pod",
    ) as { spec: Record<string, unknown> };
    expect(stager.spec).toMatchObject({
      nodeName: "k3s-1",
      securityContext: {
        seccompProfile: {
          type: "Localhost",
          localhostProfile: "kuintessence/kq-no-network.json",
        },
      },
    });
  });

  test("rechecks and binds the collector before creating its Pod", async () => {
    let collectorManifest: Record<string, unknown> | undefined;
    let assertions = 0;
    const adapter = new K8sAdapter("1.30", {
      tmpDir: "/tmp",
      sandboxSeccompProfile: {
        localhostProfile: "kuintessence/kq-no-network.json",
        nodeName: "k3s-1",
        assertCurrent: async () => {
          assertions += 1;
        },
      },
      spawner: {
        run: async (command) => {
          if (command[1] === "apply" && command[3]) {
            collectorManifest = JSON.parse(await readFile(command[3], "utf8"));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command[1] === "wait") return { exitCode: 1, stdout: "", stderr: "not ready" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });

    await expect(adapter.stageSandboxOutputs(kubernetesSandbox(), "kq-job-1")).rejects.toThrow(
      "did not become ready",
    );
    expect(assertions).toBe(1);
    expect(collectorManifest?.spec).toMatchObject({
      nodeName: "k3s-1",
      securityContext: {
        seccompProfile: {
          type: "Localhost",
          localhostProfile: "kuintessence/kq-no-network.json",
        },
      },
    });
  });

  test("skips the managed PVC collector when a Sandbox has no output mounts", async () => {
    let calls = 0;
    const adapter = new K8sAdapter("1.30", {
      spawner: {
        run: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });
    const sandbox = { ...kubernetesSandbox(), mounts: [], kubernetesArtifactPvc: undefined };

    await expect(adapter.stageSandboxOutputs(sandbox, "kq-job-1")).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  test("does not apply stager or collector resources after profile drift", async () => {
    let calls = 0;
    const adapter = new K8sAdapter("1.30", {
      tmpDir: "/tmp",
      sandboxSeccompProfile: {
        localhostProfile: "kuintessence/kq-no-network.json",
        nodeName: "k3s-1",
        assertCurrent: async () => {
          throw new Error("profile drift");
        },
      },
      spawner: {
        run: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });

    await expect(
      adapter.stageSandboxInputs(kubernetesSandbox(), "00000000-0000-0000-0000-000000000111"),
    ).rejects.toThrow("profile drift");
    await expect(adapter.stageSandboxOutputs(kubernetesSandbox(), "kq-job-1")).rejects.toThrow(
      "profile drift",
    );
    expect(calls).toBe(0);
  });

  test("does not apply an ordinary Kubernetes Job to the attested Sandbox node", () => {
    const adapter = new K8sAdapter("1.30", {
      sandboxSeccompProfile: {
        localhostProfile: "kuintessence/kq-no-network.json",
        nodeName: "k3s-1",
        assertCurrent: async () => {},
      },
    });
    const manifest = adapter.buildJobManifest({ ...job(), sandbox: undefined }) as {
      spec: { template: { spec: Record<string, unknown> } };
    };
    expect(manifest.spec.template.spec.nodeName).toBeUndefined();
    expect(manifest.spec.template.spec.securityContext).toBeUndefined();
  });
});
