import { describe, expect, test } from "bun:test";
import { JobLogUnavailableError, type Spawner } from "./base";
import { SlurmAdapter } from "./slurm";

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

const SCONTROL_COMPLETED = `
JobId=42 JobName=test
   UserId=root(0) GroupId=root(0) MCS_label=N/A
   JobState=COMPLETED Reason=None Dependency=(null)
   TimeLimit=00:01:00 SubmitTime=2025-01-01T00:00:00
   ExitCode=0:0
`.trim();

const SCONTROL_FAILED = `
JobId=43 JobName=test
   UserId=root(0) GroupId=root(0) MCS_label=N/A
   JobState=FAILED Reason=NonZeroExitCode Dependency=(null)
   TimeLimit=00:01:00 SubmitTime=2025-01-01T00:00:00
   ExitCode=1:0
`.trim();

describe("SlurmAdapter.formatWallTime", () => {
  const adapter = new SlurmAdapter("23.02.7");

  test("formats hours:minutes:seconds", () => {
    expect(adapter.formatWallTime(3600)).toBe("01:00:00");
    expect(adapter.formatWallTime(90)).toBe("00:01:30");
    expect(adapter.formatWallTime(86400)).toBe("24:00:00");
    expect(adapter.formatWallTime(0)).toBe("00:00:00");
  });
});

describe("SlurmAdapter.buildSubmitScript", () => {
  const adapter = new SlurmAdapter("23.02.7", {
    logDir: "/shared/jobs/.scheduler-logs",
  });

  test("includes core SBATCH directives", () => {
    const script = adapter.buildSubmitScript({
      jobId: "job-001",
      name: "test-job",
      command: "echo hello",
      cpus: 4,
      memoryMb: 8192,
      gpus: 0,
      wallTimeSec: 3600,
      workingDir: "/tmp",
      envVars: { FOO: "bar" },
    });
    expect(script).toContain("#SBATCH --job-name=test-job");
    expect(script).toContain("#SBATCH --comment=KQ_JOB_ID=job-001");
    expect(script).toContain("#SBATCH --cpus-per-task=4");
    expect(script).toContain("#SBATCH --mem=8192M");
    expect(script).toContain("#SBATCH --output=/shared/jobs/.scheduler-logs/kq-job-001.out");
    expect(script).toContain("#SBATCH --error=/shared/jobs/.scheduler-logs/kq-job-001.out");
    expect(script).toContain("#SBATCH --time=01:00:00");
    expect(script).toContain("#SBATCH --chdir=/tmp");
    expect(script).toContain("export FOO='bar'");
    expect(script).toContain("echo hello");
  });

  test("retains logs outside an explicit job working directory without changing cwd", () => {
    const script = adapter.buildSubmitScript({
      jobId: "shared-log",
      name: "x",
      command: "true",
      cpus: 1,
      memoryMb: 128,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "/shared/jobs/shared-log",
      envVars: {},
    });

    expect(script).toContain("#SBATCH --output=/shared/jobs/.scheduler-logs/kq-shared-log.out");
    expect(script).toContain("#SBATCH --error=/shared/jobs/.scheduler-logs/kq-shared-log.out");
    expect(script).toContain("#SBATCH --chdir=/shared/jobs/shared-log");
  });

  test("uses the shared log directory when no job working directory is set", () => {
    const script = adapter.buildSubmitScript({
      jobId: "default-log",
      name: "x",
      command: "true",
      cpus: 1,
      memoryMb: 128,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "",
      envVars: {},
    });

    expect(script).toContain("#SBATCH --output=/shared/jobs/.scheduler-logs/kq-default-log.out");
    expect(script).toContain("#SBATCH --error=/shared/jobs/.scheduler-logs/kq-default-log.out");
    expect(script).toContain("#SBATCH --chdir=/shared/jobs/.scheduler-logs");
    expect(script).not.toContain("#SBATCH --output=/tmp/");
    expect(script).not.toContain("#SBATCH --chdir=/tmp");
  });

  test("omits gpu directive when gpus=0", () => {
    const script = adapter.buildSubmitScript({
      jobId: "j",
      name: "x",
      command: "true",
      cpus: 1,
      memoryMb: 1024,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "",
      envVars: {},
    });
    expect(script).not.toContain("--gpus");
  });

  test("includes gpu directive when gpus>0", () => {
    const script = adapter.buildSubmitScript({
      jobId: "j",
      name: "x",
      command: "true",
      cpus: 1,
      memoryMb: 1024,
      gpus: 2,
      wallTimeSec: 60,
      workingDir: "",
      envVars: {},
    });
    expect(script).toContain("#SBATCH --gpus=2");
  });

  test("includes partition and QoS directives when queue metadata is present", () => {
    const script = adapter.buildSubmitScript({
      jobId: "j",
      name: "x",
      command: "true",
      cpus: 1,
      memoryMb: 1024,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "",
      envVars: {},
      queueName: "gpu",
      qos: "normal",
    });
    expect(script).toContain("#SBATCH --partition=gpu");
    expect(script).toContain("#SBATCH --qos=normal");
  });

  test("rejects queue tokens before they can enter an SBATCH directive", () => {
    expect(() =>
      adapter.buildSubmitScript({
        jobId: "j",
        name: "x",
        command: "true",
        cpus: 1,
        memoryMb: 1024,
        gpus: 0,
        wallTimeSec: 60,
        workingDir: "",
        envVars: {},
        queueName: "batch\n#SBATCH --comment=unexpected",
      }),
    ).toThrow("Scheduler queue validation failed");
  });

  test("escapes single quotes in env vars", () => {
    const script = adapter.buildSubmitScript({
      jobId: "j",
      name: "x",
      command: "true",
      cpus: 1,
      memoryMb: 1024,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "",
      envVars: { TRICKY: "it's a test" },
    });
    expect(script).toContain(`export TRICKY='it'\\''s a test'`);
  });

  test("feeds stdinText to the command through a quoted here-doc", () => {
    const script = adapter.buildSubmitScript({
      jobId: "job-stdin-1",
      name: "x",
      command: "awk '{s+=$1} END {print s}'",
      cpus: 1,
      memoryMb: 1024,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "",
      envVars: {},
      stdinText: "1\n2 with spaces\n3's\n",
    });
    expect(script).toContain("cat > '.kq-stdin-job-stdin-1' <<'__KQ_STDIN_job_stdin_1__'");
    expect(script).toContain("2 with spaces");
    expect(script).toContain("3's");
    expect(script).toContain(
      "sh -c 'awk '\\''{s+=$1} END {print s}'\\''' < '.kq-stdin-job-stdin-1'",
    );
  });
});

describe("SlurmAdapter queue inventory", () => {
  const partitions = [
    "PartitionName=batch Default=YES MaxTime=INFINITE State=UP TotalCPUs=64 TotalNodes=4",
    "PartitionName=gpu Default=NO MaxTime=INFINITE State=UP TotalCPUs=32 TotalNodes=2",
    "PartitionName=drained Default=NO MaxTime=INFINITE State=INACTIVE TotalCPUs=16 TotalNodes=0",
  ].join("\n");

  test("parses Slurm 20/23-compatible partition facts and caches heartbeat inspection", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: partitions }]);
    const adapter = new SlurmAdapter("20.11.9", { spawner, queueInventoryRefreshMs: 60_000 });

    const first = await adapter.inspectQueues();
    const second = await adapter.inspectQueues();

    expect(calls).toEqual([["scontrol", "show", "partition", "-o"]]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status: "available",
      defaultQueueName: "batch",
      queues: [
        { queueName: "batch", queueType: "partition", isDefault: true, state: "up" },
        { queueName: "gpu", hasComputeTargets: true },
        { queueName: "drained", state: "down", acceptsSubmissions: false },
      ],
    });
  });

  test("uses a fresh inspection before named target validation", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: partitions }]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });

    await expect(
      adapter.validateQueueTarget({ targetMode: "named", queueName: "drained" }),
    ).resolves.toEqual({ accepted: false, failureCode: "QUEUE_NOT_ACCEPTING" });
    expect(calls).toEqual([["scontrol", "show", "partition", "-o"]]);
  });

  test("marks malformed and ambiguous partition output unavailable", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: "PartitionName=a Default=YES State=UP\nPartitionName=b Default=YES State=UP\n",
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });

    await expect(adapter.inspectQueues()).resolves.toMatchObject({
      status: "unavailable",
      reason: "multiple_default_queues",
    });
  });
});

describe("SlurmAdapter.findByKuintessenceJobId", () => {
  test("requires the exact UUID comment under the mapped scheduler account", async () => {
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout: "42|kq-job1234567|KQ_JOB_ID=job-123|mapped-account\n",
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });

    await expect(
      adapter.findByKuintessenceJobId({
        jobId: "job-123",
        schedulerName: "kq-job1234567",
        schedulerAccount: "mapped-account",
      }),
    ).resolves.toEqual({ status: "found", schedulerJobId: "42" });
    expect(calls[0]).toEqual([
      "squeue",
      "--noheader",
      "--name",
      "kq-job1234567",
      "--account",
      "mapped-account",
      "--format=%i|%j|%k|%a",
    ]);
  });
});

describe("SlurmAdapter.getJobLogs (with mock spawner)", () => {
  test("resolves StdOut via scontrol then tails the file", async () => {
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout: "JobId=123 JobName=wrf StdOut=/scratch/wrf-123.out StdErr=/scratch/e",
      },
      { exitCode: 0, stdout: "line 1\nline 2\n" },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const text = await adapter.getJobLogs("123", 200);
    expect(calls[0]).toEqual(["scontrol", "show", "job", "123", "-o"]);
    expect(calls[1]).toEqual(["tail", "-n", "200", "/scratch/wrf-123.out"]);
    expect(text).toBe("line 1\nline 2\n");
  });

  test("returns empty string when scontrol has no StdOut", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: "JobId=123 JobName=wrf" }]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect(await adapter.getJobLogs("123", 50)).toBe("");
  });

  test("throws when scontrol fails", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "Invalid job id" }]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect(adapter.getJobLogs("999", 50)).rejects.toThrow(/scontrol/);
  });

  test("reads the deterministic persisted log after Slurm purges the job record", async () => {
    const jobId = "19a20bcd-9761-4659-be4a-5ba445befc0a";
    const { spawner, calls } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "Invalid job id" },
      { exitCode: 0, stdout: "value=43\n" },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner, logDir: "/tmp/kq" });

    await expect(adapter.getJobLogs("76", 50, jobId)).resolves.toBe("value=43\n");
    expect(calls).toEqual([
      ["scontrol", "show", "job", "76", "-o"],
      ["tail", "-n", "50", `/tmp/kq/kq-${jobId}.out`],
    ]);
  });

  test.each([
    "/scratch/kuintessence-workflows/job",
    "",
  ])("reads the submitted log path after adapter restart and record purge with cwd %j", async (workingDir) => {
    const jobId = "19a20bcd-9761-4659-be4a-5ba445befc0a";
    const logDir = "/shared/jobs/.scheduler-logs";
    const submission = mockSpawner([{ exitCode: 0, stdout: "76\n" }]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner: submission.spawner,
      logDir,
    });
    const { schedulerJobId } = await adapter.submit({
      jobId,
      name: "retained-log",
      command: "printf 'value=43\\n'",
      cpus: 1,
      memoryMb: 128,
      gpus: 0,
      wallTimeSec: 60,
      workingDir,
      envVars: {},
    });
    const script = submission.stdin[0] ?? "";
    const outputPath = /^#SBATCH --output=(.+)$/m.exec(script)?.[1];
    if (!outputPath) throw new Error("Submitted Slurm log path is missing");
    expect(outputPath).toBe(`${logDir}/kq-${jobId}.out`);
    expect(script).toContain(`#SBATCH --error=${outputPath}`);
    expect(script).toContain(`#SBATCH --chdir=${workingDir || logDir}`);

    const readback = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "Invalid job id" },
      { exitCode: 0, stdout: "value=43\n" },
    ]);
    const restartedAdapter = new SlurmAdapter("23.02.7", {
      spawner: readback.spawner,
      logDir,
    });
    await expect(restartedAdapter.getJobLogs(schedulerJobId, 50, jobId)).resolves.toBe(
      "value=43\n",
    );
    expect(readback.calls).toEqual([
      ["scontrol", "show", "job", schedulerJobId, "-o"],
      ["tail", "-n", "50", outputPath],
    ]);
  });

  test("falls back to the retained log when completed-job StdOut has vanished", async () => {
    const jobId = "19a20bcd-9761-4659-be4a-5ba445befc0a";
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout: "JobId=76 JobName=done StdOut=/tmp/vanished.out StdErr=/tmp/vanished.err",
      },
      {
        exitCode: 1,
        stdout: "",
        stderr: "tail: cannot open '/tmp/vanished.out' for reading: No such file or directory",
      },
      { exitCode: 0, stdout: "value=43\n" },
    ]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner,
      logDir: "/shared/jobs/.scheduler-logs",
    });

    await expect(adapter.getJobLogs("76", 50, jobId)).resolves.toBe("value=43\n");
    expect(calls).toEqual([
      ["scontrol", "show", "job", "76", "-o"],
      ["tail", "-n", "50", "/tmp/vanished.out"],
      ["tail", "-n", "50", `/shared/jobs/.scheduler-logs/kq-${jobId}.out`],
    ]);
  });

  test("reports a missing retained log as unavailable after job completion", async () => {
    const jobId = "19a20bcd-9761-4659-be4a-5ba445befc0a";
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: "JobId=76 JobName=done StdOut=/tmp/vanished.out StdErr=/tmp/vanished.err",
      },
      {
        exitCode: 1,
        stdout: "",
        stderr: "tail: cannot open '/tmp/vanished.out' for reading: No such file or directory",
      },
      {
        exitCode: 1,
        stdout: "",
        stderr:
          "tail: cannot open '/shared/jobs/.scheduler-logs/kq-19a20bcd-9761-4659-be4a-5ba445befc0a.out' for reading: No such file or directory",
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner,
      logDir: "/shared/jobs/.scheduler-logs",
    });

    await expect(adapter.getJobLogs("76", 50, jobId)).rejects.toBeInstanceOf(
      JobLogUnavailableError,
    );
  });

  test("keeps a scheduler controller failure as an adapter error when no retained log exists", async () => {
    const jobId = "19a20bcd-9761-4659-be4a-5ba445befc0a";
    const { spawner } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "Unable to contact slurm controller" },
      {
        exitCode: 1,
        stdout: "",
        stderr:
          "tail: cannot open '/shared/jobs/.scheduler-logs/kq-19a20bcd-9761-4659-be4a-5ba445befc0a.out' for reading: No such file or directory",
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner,
      logDir: "/shared/jobs/.scheduler-logs",
    });

    await expect(adapter.getJobLogs("76", 50, jobId)).rejects.toThrow("scontrol show job failed");
  });

  test("throws when the stdout file cannot be tailed", async () => {
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout: "JobId=123 JobName=wrf StdOut=/scratch/missing.out StdErr=/scratch/e",
      },
      { exitCode: 1, stdout: "", stderr: "cannot open '/scratch/missing.out'" },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect(adapter.getJobLogs("123", 200)).rejects.toThrow(/tail job stdout/);
    expect(calls[1]).toEqual(["tail", "-n", "200", "/scratch/missing.out"]);
  });
});

describe("SlurmAdapter.listJobs (with mock spawner)", () => {
  test("parses squeue rows into ListedJob[] and maps states", async () => {
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout:
          "12345|wrf-ens-01|RUNNING|compute|2026-05-30T10:00:00\n" +
          "12346|mesh-prep|PENDING|gpu|2026-05-30T10:05:00\n" +
          "12347|post|COMPLETING|compute|2026-05-30T09:00:00\n",
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const jobs = await adapter.listJobs();

    expect(calls[0]?.[0]).toBe("squeue");
    expect(calls[0]).toContain("--me");
    expect(jobs).toEqual([
      {
        schedulerJobId: "12345",
        name: "wrf-ens-01",
        status: "running",
        queue: "compute",
        submittedAt: "2026-05-30T10:00:00",
      },
      {
        schedulerJobId: "12346",
        name: "mesh-prep",
        status: "queued",
        queue: "gpu",
        submittedAt: "2026-05-30T10:05:00",
      },
      {
        schedulerJobId: "12347",
        name: "post",
        status: "running",
        queue: "compute",
        submittedAt: "2026-05-30T09:00:00",
      },
    ]);
  });

  test("returns empty array when the queue is empty", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: "\n" }]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect(await adapter.listJobs()).toEqual([]);
  });

  test("throws when squeue exits non-zero", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 1,
        stdout: "",
        stderr: "slurm_load_jobs error: Unable to contact slurm controller",
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect(adapter.listJobs()).rejects.toThrow(/squeue/);
  });
});

describe("SlurmAdapter.submit (with mock spawner)", () => {
  test("returns scheduler job id on success", async () => {
    const { spawner, calls, stdin } = mockSpawner([{ exitCode: 0, stdout: "12345\n" }]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const result = await adapter.submit({
      jobId: "job-001",
      name: "t",
      command: "echo hi",
      cpus: 1,
      memoryMb: 1024,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "",
      envVars: {},
    });
    expect(result.schedulerJobId).toBe("12345");
    expect(calls[0]).toEqual(["sbatch", "--parsable"]);
    expect(stdin[0]).toContain("#SBATCH --comment=KQ_JOB_ID=job-001");
    expect(stdin[0]).toContain("echo hi");
  });

  test("strips cluster suffix from sbatch --parsable output", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: "12345;cluster1\n" }]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const result = await adapter.submit({
      jobId: "job-002",
      name: "t",
      command: "echo",
      cpus: 1,
      memoryMb: 1024,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "",
      envVars: {},
    });
    expect(result.schedulerJobId).toBe("12345");
  });

  test("throws on sbatch failure", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "permission denied" }]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    await expect(
      adapter.submit({
        jobId: "job-003",
        name: "t",
        command: "echo",
        cpus: 1,
        memoryMb: 1024,
        gpus: 0,
        wallTimeSec: 60,
        workingDir: "",
        envVars: {},
      }),
    ).rejects.toThrow(/sbatch failed/);
  });

  test("maps a throwing spawner to SCHEDULER_SUBMIT_FAILED", async () => {
    const spawner: Spawner = {
      async run() {
        throw new Error("spawn unavailable");
      },
    };
    const adapter = new SlurmAdapter("23.02.7", { spawner });

    await expect(
      adapter.submit({
        jobId: "job-throwing-spawner",
        name: "t",
        command: "echo",
        cpus: 1,
        memoryMb: 1024,
        gpus: 0,
        wallTimeSec: 60,
        workingDir: "",
        envVars: {},
      }),
    ).rejects.toMatchObject({
      name: "SchedulerSubmissionError",
      failureCode: "SCHEDULER_SUBMIT_FAILED",
      message: "sbatch failed",
    });
  });
});

describe("SlurmAdapter.cancel", () => {
  test("calls scancel with the job id", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "" }]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    await adapter.cancel("12345");
    expect(calls[0]).toEqual(["scancel", "12345"]);
  });
});

describe("SlurmAdapter — terminalStatusBackend: scontrol", () => {
  test("COMPLETED + ExitCode=0:0 -> completed exitCode 0", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" }, // squeue returns empty
      { exitCode: 0, stdout: SCONTROL_COMPLETED }, // scontrol
    ]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner,
      terminalStatusBackend: "scontrol",
    });
    const r = await adapter.status("42");
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
  });

  test("FAILED + ExitCode=1:0 -> failed exitCode 1", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" }, // squeue empty
      { exitCode: 0, stdout: SCONTROL_FAILED }, // scontrol
    ]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner,
      terminalStatusBackend: "scontrol",
    });
    const r = await adapter.status("43");
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/FAILED/);
  });

  test("scontrol JobState=RUNNING -> running, not failed (squeue transiently empty)", async () => {
    const SCONTROL_RUNNING = SCONTROL_COMPLETED.replace("JobState=COMPLETED", "JobState=RUNNING");
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" }, // squeue transiently empty/unparseable
      { exitCode: 0, stdout: SCONTROL_RUNNING }, // scontrol shows still RUNNING
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner, terminalStatusBackend: "scontrol" });
    expect((await adapter.status("42")).status).toBe("running");
  });

  test("scontrol non-zero exit -> failed with message", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" }, // squeue empty
      { exitCode: 1, stdout: "", stderr: "Invalid job id specified" }, // scontrol
    ]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner,
      terminalStatusBackend: "scontrol",
    });
    const r = await adapter.status("99");
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/scontrol show job failed/);
  });

  test("scontrol output missing JobState -> failed with message", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" }, // squeue empty
      { exitCode: 0, stdout: "garbage output with no fields" }, // scontrol
    ]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner,
      terminalStatusBackend: "scontrol",
    });
    const r = await adapter.status("77");
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/JobState/);
  });
});

describe("SlurmAdapter.inspectComputeHealth", () => {
  test("counts healthy idle and fully allocated nodes as ready", async () => {
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout: [
          "NodeName=slurm-1 CPUs=2 State=IDLE ThreadsPerCore=1",
          "NodeName=slurm-2 CPUs=2 State=ALLOCATED ThreadsPerCore=1",
        ].join("\n"),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });

    await expect(adapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "ready",
      nodeCount: 2,
      operationalNodeCount: 2,
    });
    expect(calls[0]).toEqual(["scontrol", "show", "nodes", "-o"]);
  });

  test("reports unavailable only after a successful observation has zero operational nodes", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: [
          "NodeName=slurm[01-02] CPUs=2 State=DRAIN",
          "NodeName=slurm-3 CPUs=2 State=DOWN",
        ].join("\n"),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });

    await expect(adapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unavailable",
      nodeCount: 3,
      operationalNodeCount: 0,
      reason: "no_operational_nodes",
    });
  });

  test("maps scheduler failures, timeouts, and invalid output to unknown", async () => {
    let timeoutMs: number | undefined;
    const timeoutSpawner: Spawner = {
      async run(_command, options) {
        timeoutMs = options?.timeoutMs;
        throw new Error("scheduler command timed out");
      },
    };
    const timeoutAdapter = new SlurmAdapter("23.02.7", { spawner: timeoutSpawner });
    await expect(timeoutAdapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unknown",
      reason: "scheduler_command_failed",
    });
    expect(timeoutMs).toBe(10_000);

    const invalidAdapter = new SlurmAdapter("23.02.7", {
      spawner: mockSpawner([{ exitCode: 0, stdout: "NodeName=slurm-1 CPUs=2 State=FLAKY" }])
        .spawner,
    });
    await expect(invalidAdapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unknown",
      reason: "invalid_scheduler_state",
    });
  });
});

describe("SlurmAdapter.status", () => {
  test("RUNNING state -> running", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({ jobs: [{ job_state: "RUNNING" }] }),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("12345");
    expect(r.status).toBe("running");
  });

  test("surfaces the allocated node list when squeue reports it", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [{ job_id: 12345, job_state: "RUNNING", nodes: "node[001-004]" }],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("12345");
    expect(r.status).toBe("running");
    expect(r.node).toBe("node[001-004]");
  });

  test("leaves node undefined when squeue omits it (e.g. queued job)", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_id: 7, job_state: "PENDING" }] }) },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("7");
    expect(r.status).toBe("queued");
    expect(r.node).toBeUndefined();
  });

  test("surfaces the pending reason from state_reason", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [{ job_id: 7, job_state: "PENDING", state_reason: "Resources" }],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("7");
    expect(r.status).toBe("queued");
    expect(r.reason).toBe("Resources");
  });

  test("treats state_reason 'None' as no reason", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [{ job_id: 1, job_state: "RUNNING", state_reason: "None" }],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect((await adapter.status("1")).reason).toBeUndefined();
  });

  test("parses start_time (object form) into an ISO startedAt", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [
            {
              job_id: 12345,
              job_state: "RUNNING",
              start_time: { set: true, infinite: false, number: 1700000000 },
            },
          ],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("12345");
    expect(r.startedAt).toBe("2023-11-14T22:13:20.000Z");
  });

  test("parses start_time (legacy numeric form) too", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [{ job_id: 1, job_state: "RUNNING", start_time: 1700000000 }],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect((await adapter.status("1")).startedAt).toBe("2023-11-14T22:13:20.000Z");
  });

  test("leaves startedAt undefined for an unset/zero start_time (queued)", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [{ job_id: 7, job_state: "PENDING", start_time: { set: false, number: 0 } }],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect((await adapter.status("7")).startedAt).toBeUndefined();
  });

  // Regression: some Slurm builds' `squeue --json -j <id>` ignore the -j filter
  // and dump ALL jobs. Taking jobs[0] then reads the wrong job's state (e.g. a
  // previously-completed job), mis-reporting a RUNNING job as completed.
  // Found via the real-Slurm cancel integration test.
  test("selects the requested job by job_id when squeue returns multiple jobs", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [
            { job_id: 1, job_state: "COMPLETED", exit_code: { return_code: 0 } },
            { job_id: 2, job_state: "RUNNING" },
          ],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("21.08.5", { spawner });
    expect((await adapter.status("2")).status).toBe("running");
  });

  // Some Slurm builds emit job_id as a string in --json; selection must be
  // schema-agnostic (string vs number) so the multi-job match still works.
  test("selects by job_id even when --json emits string ids", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [
            { job_id: "1", job_state: "COMPLETED", exit_code: { return_code: 0 } },
            { job_id: "2", job_state: "RUNNING" },
          ],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("21.08.5", { spawner });
    expect((await adapter.status("2")).status).toBe("running");
  });

  test("PENDING state -> queued", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({ jobs: [{ job_state: "PENDING" }] }),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect((await adapter.status("12345")).status).toBe("queued");
  });

  test("COMPLETED state -> completed with exit code", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [{ job_state: "COMPLETED", exit_code: { return_code: 0 } }],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("12345");
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
  });

  test("parses Slurm 23.11 array state and wrapped return code", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [
            {
              job_id: 12345,
              job_state: ["COMPLETED"],
              exit_code: {
                status: ["SUCCESS"],
                return_code: { set: true, infinite: false, number: 0 },
              },
              nodes: "slurm-2",
            },
          ],
        }),
      },
    ]);
    const adapter = new SlurmAdapter("23.11.4", { spawner });
    const result = await adapter.status("12345");

    expect(result).toEqual({ status: "completed", exitCode: 0, node: "slurm-2" });
  });

  // Non-terminal states beyond PENDING/RUNNING must NOT be reported failed —
  // COMPLETING in particular is on every job's normal path to completion.
  test("COMPLETING state -> running, not failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_state: "COMPLETING" }] }) },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect((await adapter.status("12345")).status).toBe("running");
  });

  test("SUSPENDED state -> running, not failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_state: "SUSPENDED" }] }) },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect((await adapter.status("12345")).status).toBe("running");
  });

  test("CONFIGURING state -> queued, not failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_state: "CONFIGURING" }] }) },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect((await adapter.status("12345")).status).toBe("queued");
  });

  test("falls back to sacct when squeue returns empty", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" }, // squeue empty
      { exitCode: 0, stdout: "COMPLETED|0:0\n" }, // sacct
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("12345");
    expect(r.status).toBe("completed");
  });

  test("falls back to scontrol when sacct is unavailable", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" },
      { exitCode: 1, stdout: "", stderr: "accounting_storage/slurmdbd is required" },
      { exitCode: 0, stdout: SCONTROL_COMPLETED },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("42");
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
  });

  test("falls back to scontrol when sacct has no terminal row", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: SCONTROL_COMPLETED },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("42");
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
  });

  test("non-COMPLETED sacct state -> failed", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "FAILED|1:0\n" },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("12345");
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(1);
  });
});
