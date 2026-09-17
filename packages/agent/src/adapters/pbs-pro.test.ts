import { describe, expect, test } from "bun:test";
import type { Spawner } from "./base";
import { PbsProAdapter } from "./pbs-pro";

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
  cpus: 4,
  memoryMb: 8192,
  gpus: 0,
  wallTimeSec: 3600,
  workingDir: "/scratch/user",
  envVars: { FOO: "bar" },
};

describe("PbsProAdapter.getJobLogs", () => {
  test("resolves Output_Path (strips host) and tails it", async () => {
    const json = JSON.stringify({
      Jobs: { "101.srv": { Output_Path: "srv:/home/alice/job.o101" } },
    });
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: json },
      { exitCode: 0, stdout: "out line\n" },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const text = await adapter.getJobLogs("101.srv", 100);
    expect(calls[0]?.[0]).toBe("qstat");
    expect(calls[1]).toEqual(["tail", "-n", "100", "/home/alice/job.o101"]);
    expect(text).toBe("out line\n");
  });

  test("returns a clear message when the output file is not yet available", async () => {
    const json = JSON.stringify({
      Jobs: { "101.srv": { Output_Path: "srv:/home/alice/job.o101" } },
    });
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: json },
      { exitCode: 1, stdout: "", stderr: "No such file" },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    expect(await adapter.getJobLogs("101.srv", 100)).toMatch(/not available/i);
  });

  test("throws when qstat fails", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "down" },
      { exitCode: 1, stdout: "", stderr: "history down" },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    expect(adapter.getJobLogs("x", 10)).rejects.toThrow(/qstat/);
  });

  test("falls back to qstat -x when the job has left the active queue", async () => {
    const json = JSON.stringify({
      Jobs: { "101.srv": { Output_Path: "srv:/home/alice/job.o101" } },
    });
    const { spawner, calls } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "Unknown Job Id" },
      { exitCode: 0, stdout: json },
      { exitCode: 0, stdout: "finished\n" },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const text = await adapter.getJobLogs("101.srv", 20);
    expect(calls[1]).toEqual(["qstat", "-x", "-f", "-F", "json", "101.srv"]);
    expect(text).toBe("finished\n");
  });

  test("reads the retained shared log after PBS purges the job record", async () => {
    const jobId = "19a20bcd-9761-4659-be4a-5ba445befc0a";
    const { spawner, calls } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "Unknown Job Id" },
      { exitCode: 1, stdout: "", stderr: "Unknown Job Id" },
      { exitCode: 0, stdout: "value=44\n" },
    ]);
    const adapter = new PbsProAdapter("23.06.06", { spawner, logDir: "/shared/logs" });

    await expect(adapter.getJobLogs("19.pbs-1", 50, jobId)).resolves.toBe("value=44\n");
    expect(calls[2]).toEqual(["tail", "-n", "50", `/shared/logs/kq-pbs-${jobId}.out`]);
  });
});

describe("PbsProAdapter.listJobs", () => {
  test("parses qstat -f -F json into ListedJob[] and maps states", async () => {
    const json = JSON.stringify({
      Jobs: {
        "101.srv": { Job_Name: "wrf", job_state: "R", queue: "compute", qtime: "t1" },
        "102.srv": { Job_Name: "mesh", job_state: "Q", queue: "gpu", qtime: "t2" },
        "103.srv": { Job_Name: "post", job_state: "F", queue: "compute", Exit_status: 0 },
      },
    });
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: json }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const jobs = await adapter.listJobs();
    expect(calls[0]?.[0]).toBe("qstat");
    expect(jobs).toEqual([
      {
        schedulerJobId: "101.srv",
        name: "wrf",
        status: "running",
        queue: "compute",
        submittedAt: "t1",
      },
      {
        schedulerJobId: "102.srv",
        name: "mesh",
        status: "queued",
        queue: "gpu",
        submittedAt: "t2",
      },
      {
        schedulerJobId: "103.srv",
        name: "post",
        status: "completed",
        queue: "compute",
        submittedAt: undefined,
      },
    ]);
  });

  test("returns empty array when there are no jobs", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: JSON.stringify({ Jobs: {} }) }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    expect(await adapter.listJobs()).toEqual([]);
  });

  test("throws on qstat failure", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "pbs down" }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    expect(adapter.listJobs()).rejects.toThrow(/qstat/);
  });
});

describe("PbsProAdapter.findByKuintessenceJobId", () => {
  test("finds one exact UUID variable and rejects ambiguous scheduler state", async () => {
    const found = JSON.stringify({
      Jobs: { "101.server": { Variable_List: "A=1,KQ_JOB_ID=job-123,B=2" } },
    });
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: found }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    await expect(adapter.findByKuintessenceJobId({ jobId: "job-123" })).resolves.toEqual({
      status: "found",
      schedulerJobId: "101.server",
    });

    const ambiguous = JSON.stringify({
      Jobs: {
        "101.server": { Variable_List: { KQ_JOB_ID: "job-123" } },
        "102.server": { Variable_List: { KQ_JOB_ID: "job-123" } },
      },
    });
    const duplicateAdapter = new PbsProAdapter("19.0.0", {
      spawner: mockSpawner([{ exitCode: 0, stdout: ambiguous }]).spawner,
    });
    await expect(
      duplicateAdapter.findByKuintessenceJobId({ jobId: "job-123" }),
    ).resolves.toMatchObject({
      status: "indeterminate",
    });
  });
});

describe("PbsProAdapter queue inventory", () => {
  const server = JSON.stringify({
    Server: { "pbs.example": { default_queue: "workq" } },
  });
  const queues = JSON.stringify({
    Queue: {
      workq: { queue_type: "Execution", enabled: "True", started: "True", hasnodes: "True" },
      routeq: { queue_type: "Route", enabled: "True", started: "True", hasnodes: "False" },
      disabled: { queue_type: "Execution", enabled: "False", started: "True" },
    },
  });

  test("parses JSON server/default and execution/route queue facts", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: server },
      { exitCode: 0, stdout: queues },
    ]);
    const adapter = new PbsProAdapter("23.06.06", {
      spawner,
      queueInventoryRefreshMs: 60_000,
    });

    const first = await adapter.inspectQueues();
    const second = await adapter.inspectQueues();

    expect(calls).toEqual([
      ["qstat", "-Bf", "-F", "json"],
      ["qstat", "-Qf", "-F", "json"],
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status: "available",
      defaultQueueName: "workq",
      queues: [
        { queueName: "workq", queueType: "execution", isDefault: true, hasComputeTargets: true },
        {
          queueName: "routeq",
          queueType: "route",
          acceptsSubmissions: true,
          hasComputeTargets: false,
        },
        { queueName: "disabled", state: "down", acceptsSubmissions: false },
      ],
    });
  });

  test("maps a scheduler CLI failure to a canonical inventory failure", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "controller down" }]);
    const adapter = new PbsProAdapter("23.06.06", { spawner });

    await expect(adapter.inspectQueues()).resolves.toMatchObject({
      status: "unavailable",
      reason: "command_failed",
    });
  });
});

describe("PbsProAdapter.formatWallTime", () => {
  const adapter = new PbsProAdapter("19.0.0");

  test("formats hours:minutes:seconds correctly", () => {
    expect(adapter.formatWallTime(3600)).toBe("01:00:00");
    expect(adapter.formatWallTime(90)).toBe("00:01:30");
    expect(adapter.formatWallTime(86400)).toBe("24:00:00");
    expect(adapter.formatWallTime(0)).toBe("00:00:00");
  });
});

describe("PbsProAdapter.buildSubmitScript", () => {
  const adapter = new PbsProAdapter("19.0.0", {
    logDir: "/shared/jobs/.scheduler-logs",
  });

  test("includes core PBS directives", () => {
    const script = adapter.buildSubmitScript(baseSpec);
    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("#PBS -N test-job");
    expect(script).toContain("#PBS -o /scratch/user/kq-pbs-job-001.out");
    expect(script).toContain("#PBS -e /scratch/user/kq-pbs-job-001.err");
    expect(script).toContain("#PBS -l select=1:ncpus=4:mem=8192mb");
    expect(script).toContain("#PBS -l walltime=01:00:00");
    expect(script).not.toContain("#PBS -d");
    expect(script).toContain("cd -- '/scratch/user' || exit 1");
    expect(script).toContain("export FOO='bar'");
    expect(script).toContain("echo hello");
  });

  test("includes ngpus in select line when gpus > 0", () => {
    const script = adapter.buildSubmitScript({ ...baseSpec, gpus: 2 });
    expect(script).toContain("ncpus=4:mem=8192mb:ngpus=2");
  });

  test("omits ngpus when gpus = 0", () => {
    const script = adapter.buildSubmitScript({ ...baseSpec, gpus: 0 });
    expect(script).not.toContain("ngpus");
  });

  test("omits walltime directive when wallTimeSec = 0", () => {
    const script = adapter.buildSubmitScript({ ...baseSpec, wallTimeSec: 0 });
    expect(script).not.toContain("walltime");
  });

  test("uses the shared log directory as cwd when workingDir is empty", () => {
    const script = adapter.buildSubmitScript({ ...baseSpec, workingDir: "" });
    expect(script).not.toContain("#PBS -d");
    expect(script).toContain("cd -- '/shared/jobs/.scheduler-logs' || exit 1");
    expect(script).toContain("#PBS -o /shared/jobs/.scheduler-logs/kq-pbs-job-001.out");
    expect(script).toContain("#PBS -e /shared/jobs/.scheduler-logs/kq-pbs-job-001.err");
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
      envVars: { TRICKY: "it's a test" },
    });
    expect(script).toContain(`export TRICKY='it'\\''s a test'`);
  });

  test("feeds stdinText to the command through a quoted here-doc", () => {
    const script = adapter.buildSubmitScript({
      ...baseSpec,
      jobId: "pbs-stdin-1",
      command: "awk '{s+=$1} END {print s}'",
      stdinText: "1\n2 with spaces\n3's\n",
    });
    expect(script).toContain("cat > '.kq-stdin-pbs-stdin-1' <<'__KQ_STDIN_pbs_stdin_1__'");
    expect(script).toContain("2 with spaces");
    expect(script).toContain("3's");
    expect(script).toContain(
      "sh -c 'awk '\\''{s+=$1} END {print s}'\\''' < '.kq-stdin-pbs-stdin-1'",
    );
  });
});

describe("PbsProAdapter.submit (with mock spawner)", () => {
  test("returns scheduler job id on success", async () => {
    const { spawner, calls, stdin } = mockSpawner([{ exitCode: 0, stdout: "12345.server\n" }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const result = await adapter.submit(baseSpec);
    expect(result.schedulerJobId).toBe("12345.server");
    expect(calls[0]).toEqual(["qsub"]);
    expect(stdin[0]).toContain("#PBS -v KQ_JOB_ID=job-001");
    expect(stdin[0]).toContain("echo hello");
  });

  test("parses job id with server suffix correctly", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: "67890.pbs-server.example.com\n" }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const result = await adapter.submit({ ...baseSpec, jobId: "job-002" });
    expect(result.schedulerJobId).toBe("67890.pbs-server.example.com");
  });

  test("throws on qsub failure", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "permission denied" }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    await expect(adapter.submit(baseSpec)).rejects.toThrow(/qsub failed/);
  });

  test("throws when qsub returns no job id", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: "\n" }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    await expect(adapter.submit(baseSpec)).rejects.toThrow(/no job id/);
  });

  test("maps a throwing spawner to SCHEDULER_SUBMIT_FAILED", async () => {
    const spawner: Spawner = {
      async run() {
        throw new Error("spawn unavailable");
      },
    };
    const adapter = new PbsProAdapter("19.0.0", { spawner });

    await expect(adapter.submit(baseSpec)).rejects.toMatchObject({
      name: "SchedulerSubmissionError",
      failureCode: "SCHEDULER_SUBMIT_FAILED",
      message: "qsub failed",
    });
  });
});

describe("PbsProAdapter.cancel", () => {
  test("calls qdel with the scheduler job id", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "" }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    await adapter.cancel("12345.server");
    expect(calls[0]).toEqual(["qdel", "12345.server"]);
  });

  test("throws when qdel cannot confirm cancellation", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "Unknown job id" }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    await expect(adapter.cancel("12345.server")).rejects.toThrow(/qdel failed/);
  });
});

describe("PbsProAdapter.status", () => {
  function makeQstatOutput(jobId: string, state: string, exitStatus?: number): string {
    const job: Record<string, unknown> = { job_state: state };
    if (exitStatus !== undefined) job.Exit_status = exitStatus;
    return JSON.stringify({ Jobs: { [jobId]: job } });
  }

  test("Q state -> queued", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "Q") },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("queued");
  });

  test("H (held) state -> queued", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "H") },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("queued");
  });

  test("R state -> running", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "R") },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("running");
  });

  test("extracts the allocated node(s) from exec_host", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          Jobs: { "12345.server": { job_state: "R", exec_host: "node01/0*4+node02/0*4" } },
        }),
      },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("running");
    expect(r.node).toBe("node01,node02");
  });

  test("leaves node undefined when exec_host is absent (queued)", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "Q") },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    expect((await adapter.status("12345.server")).node).toBeUndefined();
  });

  test("surfaces the scheduler comment as the pending reason", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          Jobs: {
            "12345.server": {
              job_state: "Q",
              comment: "Not Running: Insufficient amount of resource: ncpus",
            },
          },
        }),
      },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("queued");
    expect(r.reason).toBe("Not Running: Insufficient amount of resource: ncpus");
  });

  test("leaves reason undefined when there is no comment", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "Q") },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    expect((await adapter.status("12345.server")).reason).toBeUndefined();
  });

  test("E (exiting) state -> running", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "E") },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("running");
  });

  test("W (waiting for start time) -> queued, not failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "W") },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    expect((await adapter.status("12345.server")).status).toBe("queued");
  });

  test("T (transiting) -> queued, not failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "T") },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    expect((await adapter.status("12345.server")).status).toBe("queued");
  });

  test("S (suspended) -> running, not failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "S") },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    expect((await adapter.status("12345.server")).status).toBe("running");
  });

  test("F state with exit 0 -> completed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "F", 0) },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
  });

  test("F state with non-zero exit -> failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "F", 1) },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(1);
  });

  test("qstat non-zero exit -> failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "Unknown job" },
      { exitCode: 1, stdout: "", stderr: "Unknown job" },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("failed");
  });

  test("falls back to qstat -x for finished jobs", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "Unknown job" },
      { exitCode: 0, stdout: makeQstatOutput("12345.server", "F", 0) },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(calls[1]).toEqual(["qstat", "-x", "-f", "-F", "json", "12345.server"]);
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
  });

  test("qstat returns non-JSON -> failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "not json at all" },
      { exitCode: 0, stdout: "not json either" },
    ]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345.server");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("non-JSON");
  });

  test("uses first job in Jobs map when key doesn't match exactly", async () => {
    // PBS Pro may include full server suffix in keys even if user queries with short id
    const stdout = JSON.stringify({
      Jobs: { "12345.pbs-server": { job_state: "R" } },
    });
    const { spawner } = mockSpawner([{ exitCode: 0, stdout }]);
    const adapter = new PbsProAdapter("19.0.0", { spawner });
    const r = await adapter.status("12345");
    expect(r.status).toBe("running");
  });
});

describe("PbsProAdapter.inspectComputeHealth", () => {
  test("uses pbsnodes JSON and counts busy nodes as ready", async () => {
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          nodes: {
            "pbs-1": { state: "free" },
            "pbs-2": { state: "job-exclusive" },
          },
        }),
      },
    ]);
    const adapter = new PbsProAdapter("23.06.0", { spawner });

    await expect(adapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "ready",
      nodeCount: 2,
      operationalNodeCount: 2,
    });
    expect(calls[0]).toEqual(["pbsnodes", "-a", "-F", "json"]);
  });

  test("reports unavailable for successfully observed offline nodes", async () => {
    const adapter = new PbsProAdapter("23.06.0", {
      spawner: mockSpawner([
        {
          exitCode: 0,
          stdout: JSON.stringify({
            nodes: {
              "pbs-1": { state: "offline" },
              "pbs-2": { state: "down,maintenance" },
            },
          }),
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

  test("maps command and JSON parse failures to unknown without scheduler output", async () => {
    const commandAdapter = new PbsProAdapter("23.06.0", {
      spawner: mockSpawner([{ exitCode: 1, stdout: "", stderr: "controller down" }]).spawner,
    });
    await expect(commandAdapter.inspectComputeHealth()).resolves.toEqual({
      state: "unknown",
      observedAtUnixMs: expect.any(Number),
      nodeCount: 0,
      operationalNodeCount: 0,
      reason: "scheduler_command_failed",
    });

    const invalidAdapter = new PbsProAdapter("23.06.0", {
      spawner: mockSpawner([{ exitCode: 0, stdout: "not json" }]).spawner,
    });
    await expect(invalidAdapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unknown",
      reason: "invalid_scheduler_state",
    });
  });
});
