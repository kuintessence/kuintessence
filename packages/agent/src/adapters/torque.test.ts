import { describe, expect, test } from "bun:test";
import type { Spawner } from "./base";
import { TorqueAdapter } from "./torque";

function mockSpawner(responses: Array<{ exitCode: number; stdout: string; stderr?: string }>): {
  spawner: Spawner;
  calls: string[][];
  stdin: Array<string | undefined>;
} {
  const calls: string[][] = [];
  const stdin: Array<string | undefined> = [];
  let i = 0;
  const spawner: Spawner = {
    async run(cmd, options) {
      calls.push(cmd);
      stdin.push(options?.stdin);
      const r = responses[i++];
      if (!r) throw new Error("No more mock responses");
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? "" };
    },
  };
  return { spawner, calls, stdin };
}

const baseSpec = {
  jobId: "job-001",
  name: "test-job",
  command: "echo hello",
  cpus: 8,
  memoryMb: 4096,
  gpus: 0,
  wallTimeSec: 7200,
  workingDir: "/scratch/user",
  envVars: { BAR: "baz" },
};

describe("TorqueAdapter.getJobLogs", () => {
  test("resolves Output_Path from qstat -f and tails it", async () => {
    const qstatF = [
      "Job Id: 101.srv",
      "    Job_Name = wrf",
      "    Output_Path = srv:/home/alice/wrf.o101",
      "    job_state = C",
    ].join("\n");
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: qstatF },
      { exitCode: 0, stdout: "torque out\n" },
    ]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const text = await adapter.getJobLogs("101.srv", 100);
    expect(calls[1]).toEqual(["tail", "-n", "100", "/home/alice/wrf.o101"]);
    expect(text).toBe("torque out\n");
  });

  test("unfolds a long Output_Path before tailing it", async () => {
    const qstatF = [
      "Job Id: 1.torque-1",
      "    Output_Path = torque-1:/shared/torque6/work/kq-jobs/f2c0c3aa-5498-4d64-863",
      "\t6-54ddf523ddfe/kq-torque-f2c0c3aa-5498-4d64-8636-54ddf523ddfe.out",
      "    job_state = C",
    ].join("\n");
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: qstatF },
      { exitCode: 0, stdout: "torque out\n" },
    ]);
    const adapter = new TorqueAdapter("6.1.3", { spawner });

    await expect(adapter.getJobLogs("1.torque-1", 50)).resolves.toBe("torque out\n");
    expect(calls[1]).toEqual([
      "tail",
      "-n",
      "50",
      "/shared/torque6/work/kq-jobs/f2c0c3aa-5498-4d64-8636-54ddf523ddfe/kq-torque-f2c0c3aa-5498-4d64-8636-54ddf523ddfe.out",
    ]);
  });

  test("returns a clear message when output is not yet available", async () => {
    const qstatF = "Job Id: 101.srv\n    Output_Path = srv:/home/alice/wrf.o101\n";
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: qstatF },
      { exitCode: 1, stdout: "", stderr: "No such file" },
    ]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    expect(await adapter.getJobLogs("101.srv", 100)).toMatch(/not available/i);
  });

  test("reads the retained shared log after Torque purges the job record", async () => {
    const jobId = "19a20bcd-9761-4659-be4a-5ba445befc0a";
    const { spawner, calls } = mockSpawner([
      { exitCode: 153, stdout: "", stderr: "Unknown Job Id" },
      { exitCode: 0, stdout: "value=45\n" },
    ]);
    const adapter = new TorqueAdapter("6.1.3", { spawner, logDir: "/shared/logs" });

    await expect(adapter.getJobLogs("16.torque-1", 50, jobId)).resolves.toBe("value=45\n");
    expect(calls[1]).toEqual(["tail", "-n", "50", `/shared/logs/kq-torque-${jobId}.out`]);
  });
});

describe("TorqueAdapter.listJobs", () => {
  test("parses tabular qstat output into ListedJob[]", async () => {
    const stdout = [
      "Job id                    Name             User            Time Use S Queue",
      "------------------------- ---------------- --------------- -------- - -----",
      "101.srv                   wrf              alice           00:01:23 R compute",
      "102.srv                   mesh             alice           0        Q gpu",
      "103.srv                   post             alice           00:00:05 C compute",
      "",
    ].join("\n");
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const jobs = await adapter.listJobs();
    expect(calls[0]?.[0]).toBe("qstat");
    expect(jobs).toEqual([
      { schedulerJobId: "101.srv", name: "wrf", status: "running", queue: "compute" },
      { schedulerJobId: "102.srv", name: "mesh", status: "queued", queue: "gpu" },
      { schedulerJobId: "103.srv", name: "post", status: "completed", queue: "compute" },
    ]);
  });

  test("returns empty array when the queue is empty (header only)", async () => {
    const stdout = "Job id  Name  User  Time Use S Queue\n----  ----  ----  ----  -  ----\n";
    const { spawner } = mockSpawner([{ exitCode: 0, stdout }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    expect(await adapter.listJobs()).toEqual([]);
  });

  test("throws on qstat failure", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "down" }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    expect(adapter.listJobs()).rejects.toThrow(/qstat/);
  });
});

describe("TorqueAdapter.findByKuintessenceJobId", () => {
  test("uses an exact variable value and treats duplicate UUIDs as indeterminate", async () => {
    const found = [
      "Job Id: 101.server",
      "    Variable_List = PATH=/bin,KQ_JOB_ID=job-123,HOME=/home/kq",
    ].join("\n");
    const adapter = new TorqueAdapter("6.1.0", {
      spawner: mockSpawner([{ exitCode: 0, stdout: found }]).spawner,
    });
    await expect(adapter.findByKuintessenceJobId({ jobId: "job-123" })).resolves.toEqual({
      status: "found",
      schedulerJobId: "101.server",
    });

    const ambiguous = `${found}\nJob Id: 102.server\n    Variable_List = KQ_JOB_ID=job-123`;
    const duplicateAdapter = new TorqueAdapter("6.1.0", {
      spawner: mockSpawner([{ exitCode: 0, stdout: ambiguous }]).spawner,
    });
    await expect(
      duplicateAdapter.findByKuintessenceJobId({ jobId: "job-123" }),
    ).resolves.toMatchObject({
      status: "indeterminate",
    });
  });
});

describe("TorqueAdapter queue inventory", () => {
  const server = "set server default_queue = batch\n";
  const queues = [
    "create queue batch",
    "set queue batch queue_type = Execution",
    "set queue batch enabled = True",
    "set queue batch started = True",
    "set queue batch hasnodes = True",
    "Queue routeq",
    "    queue_type = Route",
    "    enabled = True",
    "    started = True",
    "    hasnodes = False",
    "create queue offline",
    "set queue offline queue_type = Execution",
    "set queue offline enabled = False",
    "set queue offline started = True",
  ].join("\n");

  test("parses Torque 6 qmgr server and queue forms", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: server },
      { exitCode: 0, stdout: queues },
    ]);
    const adapter = new TorqueAdapter("6.1.3", { spawner, queueInventoryRefreshMs: 60_000 });

    const inventory = await adapter.inspectQueues();
    await adapter.inspectQueues();

    expect(calls).toEqual([
      ["qmgr", "-c", "list server"],
      ["qmgr", "-c", "list queue"],
    ]);
    expect(inventory).toMatchObject({
      status: "available",
      defaultQueueName: "batch",
      queues: [
        { queueName: "batch", queueType: "execution", isDefault: true, hasComputeTargets: true },
        { queueName: "routeq", queueType: "route", acceptsSubmissions: true },
        { queueName: "offline", state: "down", acceptsSubmissions: false },
      ],
    });
  });

  test("validates the scheduler default with a fresh qmgr observation", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: server },
      { exitCode: 0, stdout: queues },
    ]);
    const adapter = new TorqueAdapter("6.1.3", { spawner });

    await expect(adapter.validateQueueTarget({ targetMode: "default" })).resolves.toEqual({
      accepted: true,
      resolvedQueueName: "batch",
    });
    expect(calls).toEqual([
      ["qmgr", "-c", "list server"],
      ["qmgr", "-c", "list queue"],
    ]);
  });
});

describe("TorqueAdapter.formatWallTime", () => {
  const adapter = new TorqueAdapter("6.1.0");

  test("formats hours:minutes:seconds correctly", () => {
    expect(adapter.formatWallTime(3600)).toBe("01:00:00");
    expect(adapter.formatWallTime(90)).toBe("00:01:30");
    expect(adapter.formatWallTime(86400)).toBe("24:00:00");
    expect(adapter.formatWallTime(0)).toBe("00:00:00");
  });
});

describe("TorqueAdapter.buildSubmitScript", () => {
  const adapter = new TorqueAdapter("6.1.0", {
    logDir: "/shared/jobs/.scheduler-logs",
  });

  test("includes core PBS directives (Torque style)", () => {
    const script = adapter.buildSubmitScript(baseSpec);
    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("#PBS -N test-job");
    expect(script).toContain("#PBS -o /scratch/user/kq-torque-job-001.out");
    expect(script).toContain("#PBS -e /scratch/user/kq-torque-job-001.err");
    expect(script).toContain("#PBS -l nodes=1:ppn=8");
    expect(script).toContain("#PBS -l mem=4096mb");
    expect(script).toContain("#PBS -l walltime=02:00:00");
    expect(script).not.toContain("#PBS -d");
    expect(script).toContain("cd -- '/scratch/user' || exit 1");
    expect(script).toContain("export BAR='baz'");
    expect(script).toContain("echo hello");
  });

  test("uses nodes/ppn format (not select)", () => {
    const script = adapter.buildSubmitScript(baseSpec);
    expect(script).toContain("nodes=1:ppn=");
    expect(script).not.toContain("select=");
  });

  test("includes gpus line when gpus > 0", () => {
    const script = adapter.buildSubmitScript({ ...baseSpec, gpus: 2 });
    expect(script).toContain("#PBS -l gpus=2");
  });

  test("omits gpus line when gpus = 0", () => {
    const script = adapter.buildSubmitScript({ ...baseSpec, gpus: 0 });
    expect(script).not.toContain("gpus");
  });

  test("omits walltime when wallTimeSec = 0", () => {
    const script = adapter.buildSubmitScript({ ...baseSpec, wallTimeSec: 0 });
    expect(script).not.toContain("walltime");
  });

  test("uses a shell cwd change instead of a PBS -d directive", () => {
    const script = adapter.buildSubmitScript(baseSpec);
    expect(script).not.toContain("#PBS -d");
    expect(script).toContain("cd -- '/scratch/user' || exit 1");
  });

  test("uses the shared log directory as cwd when workingDir is empty", () => {
    const script = adapter.buildSubmitScript({ ...baseSpec, workingDir: "" });
    expect(script).not.toContain("#PBS -d");
    expect(script).toContain("cd -- '/shared/jobs/.scheduler-logs' || exit 1");
    expect(script).toContain("#PBS -o /shared/jobs/.scheduler-logs/kq-torque-job-001.out");
    expect(script).toContain("#PBS -e /shared/jobs/.scheduler-logs/kq-torque-job-001.err");
    expect(script).not.toContain("#PBS -o /tmp/");
  });

  test("includes queue and QoS directives when queue metadata is present", () => {
    const script = adapter.buildSubmitScript({ ...baseSpec, queueName: "gpu", qos: "normal" });
    expect(script).toContain("#PBS -q gpu");
    expect(script).toContain("#PBS -l qos=normal");
  });

  test("escapes single quotes in env var values", () => {
    const script = adapter.buildSubmitScript({
      ...baseSpec,
      envVars: { TRICKY: "it's tricky" },
    });
    expect(script).toContain(`export TRICKY='it'\\''s tricky'`);
  });

  test("feeds stdinText to the command through a quoted here-doc", () => {
    const script = adapter.buildSubmitScript({
      ...baseSpec,
      jobId: "torque-stdin-1",
      command: "awk '{s+=$1} END {print s}'",
      stdinText: "1\n2 with spaces\n3's\n",
    });
    expect(script).toContain("cat > '.kq-stdin-torque-stdin-1' <<'__KQ_STDIN_torque_stdin_1__'");
    expect(script).toContain("2 with spaces");
    expect(script).toContain("3's");
    expect(script).toContain(
      "sh -c 'awk '\\''{s+=$1} END {print s}'\\''' < '.kq-stdin-torque-stdin-1'",
    );
  });
});

describe("TorqueAdapter.submit (with mock spawner)", () => {
  test("returns scheduler job id on success", async () => {
    const { spawner, calls, stdin } = mockSpawner([{ exitCode: 0, stdout: "99999.torque-head\n" }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const result = await adapter.submit(baseSpec);
    expect(result.schedulerJobId).toBe("99999.torque-head");
    expect(calls[0]).toEqual(["qsub"]);
    expect(stdin[0]).toContain("#PBS -v KQ_JOB_ID=job-001");
    expect(stdin[0]).toContain("echo hello");
  });

  test("throws on qsub failure", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "access denied" }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    await expect(adapter.submit(baseSpec)).rejects.toThrow(/qsub failed/);
  });

  test("throws when qsub returns no job id", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: "   \n" }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    await expect(adapter.submit(baseSpec)).rejects.toThrow(/no job id/);
  });

  test("maps a throwing spawner to SCHEDULER_SUBMIT_FAILED", async () => {
    const spawner: Spawner = {
      async run() {
        throw new Error("spawn unavailable");
      },
    };
    const adapter = new TorqueAdapter("6.1.0", { spawner });

    await expect(adapter.submit(baseSpec)).rejects.toMatchObject({
      name: "SchedulerSubmissionError",
      failureCode: "SCHEDULER_SUBMIT_FAILED",
      message: "qsub failed",
    });
  });
});

describe("TorqueAdapter.cancel", () => {
  test("calls qdel with the scheduler job id", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "" }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    await adapter.cancel("99999.torque-head");
    expect(calls[0]).toEqual(["qdel", "99999.torque-head"]);
  });

  test("throws when qdel cannot confirm cancellation", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "Unknown job" }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    await expect(adapter.cancel("99999.torque-head")).rejects.toThrow(/qdel failed/);
  });
});

describe("TorqueAdapter.status (plain-text qstat -f parser)", () => {
  function makeQstatOutput(state: string, exitStatus?: number): string {
    const lines = [
      "Job Id: 99999.torque-head",
      "    Job_Name = test-job",
      `    job_state = ${state}`,
    ];
    if (exitStatus !== undefined) {
      lines.push(`    exit_status = ${exitStatus}`);
    }
    return lines.join("\n");
  }

  test("Q state -> queued", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("Q") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.status).toBe("queued");
  });

  test("H (held) state -> queued", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("H") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.status).toBe("queued");
  });

  test("R state -> running", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("R") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.status).toBe("running");
  });

  test("E (exiting) state -> running", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("E") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.status).toBe("running");
  });

  test("W (waiting for start time) -> queued, not failed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("W") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    expect((await adapter.status("99999.torque-head")).status).toBe("queued");
  });

  test("T (transiting) -> queued, not failed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("T") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    expect((await adapter.status("99999.torque-head")).status).toBe("queued");
  });

  test("S (suspended) -> running, not failed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("S") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    expect((await adapter.status("99999.torque-head")).status).toBe("running");
  });

  test("extracts distinct nodes from exec_host", async () => {
    const stdout = [
      "Job Id: 99999.torque-head",
      "    job_state = R",
      "    exec_host = node01/0+node01/1+node02/0",
    ].join("\n");
    const { spawner } = mockSpawner([{ exitCode: 0, stdout }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.status).toBe("running");
    expect(r.node).toBe("node01,node02");
  });

  test("leaves node undefined when exec_host is absent (queued)", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("Q") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    expect((await adapter.status("99999.torque-head")).node).toBeUndefined();
  });

  test("surfaces the comment line as the pending reason", async () => {
    const stdout = [
      "Job Id: 99999.torque-head",
      "    job_state = Q",
      "    comment = Not Running: Queue compute is not enabled",
    ].join("\n");
    const { spawner } = mockSpawner([{ exitCode: 0, stdout }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.reason).toBe("Not Running: Queue compute is not enabled");
  });

  test("leaves reason undefined without a comment", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("Q") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    expect((await adapter.status("99999.torque-head")).reason).toBeUndefined();
  });

  test("C state with exit 0 -> completed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("C", 0) }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
  });

  test("C state with non-zero exit -> failed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("C", 2) }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(2);
  });

  test("qstat non-zero exit -> failed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "Unknown job id" }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("no data");
  });

  test("unknown state -> failed with state in message", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeQstatOutput("X") }]);
    const adapter = new TorqueAdapter("6.1.0", { spawner });
    const r = await adapter.status("99999.torque-head");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("X");
  });
});

describe("TorqueAdapter.inspectComputeHealth", () => {
  test("parses fixed pbsnodes blocks and treats fully busy nodes as ready", async () => {
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout: [
          "torque-1",
          "     state = free",
          "     np = 2",
          "",
          "torque-2",
          "     state = busy",
          "     np = 2",
        ].join("\n"),
      },
    ]);
    const adapter = new TorqueAdapter("6.1.3", { spawner });

    await expect(adapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "ready",
      nodeCount: 2,
      operationalNodeCount: 2,
    });
    expect(calls[0]).toEqual(["pbsnodes", "-a"]);
  });

  test("reports unavailable after a successful all-offline node observation", async () => {
    const adapter = new TorqueAdapter("6.1.3", {
      spawner: mockSpawner([
        {
          exitCode: 0,
          stdout: ["torque-1", "     state = offline", "", "torque-2", "     state = down"].join(
            "\n",
          ),
        },
      ]).spawner,
    });

    await expect(adapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unavailable",
      nodeCount: 2,
      operationalNodeCount: 0,
      reason: "no_operational_nodes",
    });
  });

  test("maps command and malformed block output to unknown", async () => {
    const commandAdapter = new TorqueAdapter("6.1.3", {
      spawner: mockSpawner([{ exitCode: 1, stdout: "", stderr: "pbs_server unavailable" }]).spawner,
    });
    await expect(commandAdapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unknown",
      reason: "scheduler_command_failed",
    });

    const invalidAdapter = new TorqueAdapter("6.1.3", {
      spawner: mockSpawner([{ exitCode: 0, stdout: "torque-1\n     np = 2" }]).spawner,
    });
    await expect(invalidAdapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unknown",
      reason: "invalid_scheduler_state",
    });
  });
});
