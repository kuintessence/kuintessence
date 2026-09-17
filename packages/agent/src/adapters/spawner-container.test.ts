import { describe, expect, test } from "bun:test";
import { realSpawner } from "./base";
import { ContainerSpawner, type RawRun } from "./spawner-container";

describe("ContainerSpawner", () => {
  test("prefixes commands with docker exec <containerId>", async () => {
    const calls: string[][] = [];
    const fakeRun: RawRun = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const sp = new ContainerSpawner("ctr-abc", fakeRun);
    const r = await sp.run(["sbatch", "/tmp/x.sh"]);
    expect(r).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(calls).toEqual([["docker", "exec", "ctr-abc", "sbatch", "/tmp/x.sh"]]);
  });

  test("forwards exit code, stdout, stderr verbatim", async () => {
    const fakeRun: RawRun = async () => ({ exitCode: 7, stdout: "", stderr: "boom" });
    const sp = new ContainerSpawner("xyz", fakeRun);
    const r = await sp.run(["sinfo"]);
    expect(r).toEqual({ exitCode: 7, stdout: "", stderr: "boom" });
  });

  test("sets in-container cwd via docker exec -w when cwd is provided", async () => {
    const calls: string[][] = [];
    const fakeRun: RawRun = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const sp = new ContainerSpawner("ctr-xyz", fakeRun);
    await sp.run(["squeue"], { cwd: "/scratch" });
    // Must use -w to set the in-container working directory, NOT host-side cwd
    expect(calls[0]).toEqual(["docker", "exec", "-w", "/scratch", "ctr-xyz", "squeue"]);
  });

  test("omits -w flag when cwd is not provided", async () => {
    const calls: string[][] = [];
    const fakeRun: RawRun = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const sp = new ContainerSpawner("ctr-xyz", fakeRun);
    await sp.run(["squeue"]);
    // No -w in the argv when cwd is absent
    expect(calls[0]).toEqual(["docker", "exec", "ctr-xyz", "squeue"]);
    expect(calls[0]).not.toContain("-w");
  });

  test("propagates rawRun rejection unchanged", async () => {
    const boom = new Error("docker daemon not reachable");
    const fakeRun: RawRun = async () => {
      throw boom;
    };
    const sp = new ContainerSpawner("ctr-err", fakeRun);
    await expect(sp.run(["sbatch", "job.sh"])).rejects.toBe(boom);
  });

  test("forwards timeout to the host-side docker command", async () => {
    let receivedTimeout: number | undefined;
    const fakeRun: RawRun = async (_cmd, options) => {
      receivedTimeout = options?.timeoutMs;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const sp = new ContainerSpawner("ctr-timeout", fakeRun);
    await sp.run(["qstat"], { timeoutMs: 4_000 });
    expect(receivedTimeout).toBe(4_000);
  });

  test("keeps scheduler scripts off disk by forwarding stdin through docker exec -i", async () => {
    const calls: Array<{ cmd: string[]; stdin?: string }> = [];
    const fakeRun: RawRun = async (cmd, options) => {
      calls.push({ cmd, stdin: options?.stdin });
      return { exitCode: 0, stdout: "42\n", stderr: "" };
    };
    const sp = new ContainerSpawner("ctr-stdin", fakeRun);

    await sp.run(["sbatch", "--parsable"], { stdin: "#!/bin/bash\ntrue\n" });

    expect(calls).toEqual([
      {
        cmd: ["docker", "exec", "-i", "ctr-stdin", "sbatch", "--parsable"],
        stdin: "#!/bin/bash\ntrue\n",
      },
    ]);
  });

  test("realSpawner writes stdin and closes the pipe", async () => {
    const result = await realSpawner.run(["sh", "-c", "cat"], { stdin: "submit-script\n" });

    expect(result).toEqual({ exitCode: 0, stdout: "submit-script\n", stderr: "" });
  });
});
