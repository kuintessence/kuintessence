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
      if (
        cmd[0] === "id" &&
        responses[i]?.exitCode === 0 &&
        !/^\d+$/.test(responses[i]?.stdout.trim() ?? "")
      )
        return { exitCode: 0, stdout: String(process.getuid?.() ?? 0), stderr: "" };
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
  test("user diagnostics read stderr without changing default stdout extraction", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: "JobId=101.srv StdOut=/logs/out StdErr=/logs/err" },
      { exitCode: 0, stdout: "value=2\n" },
      { exitCode: 0, stdout: "specific failure\n" },
    ]);
    const adapter = new SlurmAdapter("23", { spawner });
    expect(await adapter.getJobLogs("101.srv", 50, undefined, true)).toBe(
      "value=2\n\n[stderr]\nspecific failure\n",
    );
    expect(calls.at(-1)).toEqual(["tail", "-n", "50", "/logs/err"]);
  });
  test("diagnostics recover both retained streams after scheduler history expires", async () => {
    const jobId = "19a20bcd-9761-4659-be4a-5ba445befc0a";
    const { spawner, calls } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: "Invalid job id / Unknown Job Id" },
      { exitCode: 0, stdout: "output\n" },
      { exitCode: 0, stdout: "failure\n" },
    ]);
    const adapter = new SlurmAdapter("23", { spawner, logDir: "/logs" });
    expect(await adapter.getJobLogs("101.srv", 50, jobId, true)).toContain("[stderr]\nfailure");
    expect(calls.at(-1)).toEqual(["tail", "-n", "50", `/logs/kq-${jobId}.err`]);
  });
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
      { exitCode: 0, stdout: "1000\n" },
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

    expect(calls[0]).toEqual(["id", "-u"]);
    expect(calls[1]?.[0]).toBe("squeue");
    expect(calls[1]).toContain("--user");
    expect(calls[1]).toContain("1000");
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
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "1000\n" },
      { exitCode: 0, stdout: "\n" },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    expect(await adapter.listJobs()).toEqual([]);
  });
  test("throws when squeue exits non-zero", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "1000\n" },
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
  test.each([
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "not-a-job-id" },
    { exitCode: 137, stdout: "" },
    { exitCode: -1, stdout: "" },
  ])("keeps ambiguous sbatch response %j recoverable", async (response) => {
    const { spawner } = mockSpawner([response]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    await expect(
      adapter.submit({
        jobId: "uncertain",
        name: "test",
        command: "true",
        cpus: 1,
        memoryMb: 64,
        gpus: 0,
        wallTimeSec: 60,
        workingDir: "",
        envVars: {},
      }),
    ).rejects.toMatchObject({ name: "SchedulerSubmissionUnknownError" });
  });
  test.each([
    "sbatch: error: Batch job submission failed: Invalid partition name specified",
    "sbatch: error: invalid partition specified: kq_missing_partition\nsbatch: error: Batch job submission failed: Invalid partition name specified",
  ])("reports a confirmed controller rejection as a definite sbatch failure: %s", async (stderr) => {
    const { spawner } = mockSpawner([
      {
        exitCode: 1,
        stdout: "",
        stderr,
      },
    ]);
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
  test("retains an unknown outcome when the submission response is lost", async () => {
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
      name: "SchedulerSubmissionUnknownError",
      message: "sbatch result could not be confirmed",
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
  test("scontrol non-zero exit is unknown and retried", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" }, // squeue empty
      { exitCode: 1, stdout: "", stderr: "Invalid job id specified" }, // scontrol
    ]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner,
      terminalStatusBackend: "scontrol",
    });
    await expect(adapter.status("99")).rejects.toThrow("unavailable");
  });
  test("scontrol output missing JobState is unknown and retried", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" }, // squeue empty
      { exitCode: 0, stdout: "JobId=77 garbage output with no fields" }, // scontrol
    ]);
    const adapter = new SlurmAdapter("23.02.7", {
      spawner,
      terminalStatusBackend: "scontrol",
    });
    await expect(adapter.status("77")).rejects.toThrow("JobState");
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
      { exitCode: 0, stdout: "COMPLETED|0:0|12345||||\n" }, // sacct
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
      { exitCode: 0, stdout: "FAILED|1:0|12345||||\n" },
    ]);
    const adapter = new SlurmAdapter("23.02.7", { spawner });
    const r = await adapter.status("12345");
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(1);
  });
});

test("submission recovery finds a completed Slurm job by exact UUID in retained accounting", async () => {
  const { spawner, calls } = mockSpawner([
    { exitCode: 0, stdout: "" },
    {
      exitCode: 0,
      stdout: "42|kq-job|KQ_JOB_ID=original|account\n43|other|KQ_JOB_ID=other|account\n",
    },
  ]);
  const adapter = new SlurmAdapter("23.02.7", { spawner });
  expect(
    await adapter.findByKuintessenceJobId({
      jobId: "original",
      schedulerName: "kq-job",
      schedulerAccount: "account",
      submittedAfterUnixMs: Date.parse("2026-11-06T00:00:00Z"),
    }),
  ).toEqual({ status: "found", schedulerJobId: "42" });
  expect(calls[1]).toContain("--allocations");
  expect(calls[1]).toContain("2026-11-05");
});

test("unavailable Slurm accounting cannot prove an uncertain submission absent", async () => {
  const { spawner } = mockSpawner([
    { exitCode: 0, stdout: "1000\n" },
    { exitCode: 0, stdout: "" },
    { exitCode: 1, stdout: "", stderr: "accounting unavailable" },
    { exitCode: 1, stdout: "", stderr: "controller unavailable" },
  ]);
  const adapter = new SlurmAdapter("23.02.7", { spawner });
  expect(
    await adapter.findByKuintessenceJobId({ jobId: "original", submittedAfterUnixMs: Date.now() }),
  ).toMatchObject({ status: "indeterminate" });
});

test("an exact live Slurm job can be resumed without requiring accounting", async () => {
  const { spawner, calls } = mockSpawner([
    { exitCode: 0, stdout: "1000\n" },
    { exitCode: 0, stdout: "42|kq-original|KQ_JOB_ID=original|account\n" },
  ]);
  const adapter = new SlurmAdapter("23.02.7", { spawner });
  expect(
    await adapter.findByKuintessenceJobId({ jobId: "original", submittedAfterUnixMs: Date.now() }),
  ).toEqual({ status: "found", schedulerJobId: "42" });
  expect(calls).toHaveLength(2);
});

test("Slurm stop confirmation excludes resumable and unknown states", async () => {
  const { spawner, calls } = mockSpawner([
    { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_id: 42, job_state: "SPECIAL_EXIT" }] }) },
    { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_id: 42, job_state: "UNKNOWN" }] }) },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "OUT_OF_MEMORY|1:0|42||||\n" },
  ]);
  const adapter = new SlurmAdapter("23.02.7", { spawner });
  expect(await adapter.confirmStopped("42")).toBe(false);
  await expect(adapter.confirmStopped("42")).rejects.toThrow("Unknown Slurm");
  expect(await adapter.confirmStopped("42")).toBe(true);
  expect(calls.at(-1)).toContain(
    "--format=State%64,ExitCode,JobIDRaw,ElapsedRaw,AllocCPUS,TotalCPU",
  );
});

test("failed scheduler-side identity lookup cannot broaden Slurm recovery to other users", async () => {
  const { spawner, calls } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "unavailable" }]);
  expect(
    await new SlurmAdapter("19", { spawner }).findByKuintessenceJobId({ jobId: "original" }),
  ).toMatchObject({ status: "indeterminate" });
  expect(calls).toEqual([["id", "-u"]]);
});

test.each([
  "original",
  "other-user",
  "other-uuid",
  "other-epoch",
])("Slurm without accounting recovers retained stop identity: %s", async (variant) => {
  const { spawner, calls } = mockSpawner([
    { exitCode: 0, stdout: "1000\n" },
    { exitCode: 0, stdout: "" },
    { exitCode: 1, stdout: "", stderr: "accounting disabled" },
    {
      exitCode: 0,
      stdout: `JobId=42 JobName=${variant === "other-epoch" ? "kf6" : "kf5"} UserId=worker(${variant === "other-user" ? "1001" : "1000"}) Account=default JobState=CANCELLED Comment=KQ_JOB_ID=${variant === "other-uuid" ? "other" : "original"}\n`,
    },
  ]);
  const result = await new SlurmAdapter("19", { spawner }).findByKuintessenceJobId({
    jobId: "original",
    schedulerName: "kf5",
    submittedAfterUnixMs: Date.now(),
  });
  expect(result).toEqual(
    variant === "original"
      ? { status: "found", schedulerJobId: "42" }
      : { status: "indeterminate", reason: "Slurm controller history cannot confirm submission" },
  );
  expect(calls[3]).toEqual(["scontrol", "show", "job", "-o"]);
});

test("Slurm accounting selects exactly the job allocation row without summing steps or filtering their utilization", async () => {
  const { spawner, calls } = mockSpawner([
    { exitCode: 0, stdout: "" },
    {
      exitCode: 0,
      stdout:
        "COMPLETED|0:0|99|999|8|01:00:00\nCOMPLETED|0:0|42.batch|7|2|00:00:03\nCOMPLETED|0:0|42|7|2|00:00:03.125\n",
    },
  ]);
  const result = await new SlurmAdapter("23", { spawner }).status("42");
  expect(result.accounting).toMatchObject({
    source: "slurm-sacct",
    schedulerJobId: "42",
    elapsedMilliseconds: "7000",
    allocatedCpus: "2",
    cpuTimeMilliseconds: "3125",
  });
  expect(calls.at(-1)).not.toContain("--allocations");
});

test("ambiguous or missing Slurm accounting retains status fallback without inventing usage", async () => {
  const { spawner } = mockSpawner([
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "COMPLETED|0:0|42|1|1|00:00:01\nCOMPLETED|0:0|42|2|2|00:00:02\n" },
    { exitCode: 0, stdout: SCONTROL_COMPLETED },
  ]);
  const result = await new SlurmAdapter("23", { spawner }).status("42");
  expect(result.status).toBe("completed");
  expect(result.accounting).toBeUndefined();
});

test("Slurm terminal squeue observations also collect retained scheduler accounting", async () => {
  const { spawner } = mockSpawner([
    { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_id: 42, job_state: "COMPLETED" }] }) },
    { exitCode: 0, stdout: "COMPLETED|0:0|42|0|2|00:00:00\n" },
  ]);
  expect((await new SlurmAdapter("23", { spawner }).status("42")).accounting).toMatchObject({
    elapsedMilliseconds: "0",
    cpuTimeMilliseconds: "0",
  });
});

test.each([
  ["elapsed time", "COMPLETED|0:0|42|0|1|00:02.018", "COMPLETED|0:0|42.batch|2|1|00:02.018"],
  ["CPU time", "COMPLETED|0:0|42|2|1|00:00:00", "COMPLETED|0:0|42.batch|2|1|00:02.018"],
  ["running step", "COMPLETED|0:0|42|2|1|00:02.018", "RUNNING|0:0|42.batch|2|1|00:02.018"],
  ["unknown step", "COMPLETED|0:0|42|2|1|00:02.018", "FUTURE_STATE|0:0|42.batch|2|1|00:02.018"],
])("Slurm terminal allocation waits for consistent %s before exposing accounting", async (_label, allocation, step) => {
  const { spawner } = mockSpawner([
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: `${allocation}\n${step}\n` },
    { exitCode: 0, stdout: "" },
    {
      exitCode: 0,
      stdout: "COMPLETED|0:0|42|2|1|00:02.018\nCOMPLETED|0:0|42.batch|2|1|00:02.018\n",
    },
  ]);
  const adapter = new SlurmAdapter("19.05.5", { spawner });
  const pending = await adapter.status("42");
  expect(pending.status).toBe("completed");
  expect(pending.accounting).toBeUndefined();
  expect((await adapter.status("42")).accounting).toMatchObject({
    cpuTimeMilliseconds: "2018",
    elapsedMilliseconds: "2000",
    allocatedCpus: "1",
  });
});

test.each([
  false,
  true,
])("mapped Slurm recovery uses the execution UID with account=%s", async (account) => {
  const { spawner, calls } = mockSpawner([
    { exitCode: 0, stdout: "" },
    { exitCode: 1, stdout: "", stderr: "accounting disabled" },
    {
      exitCode: 0,
      stdout: [
        "JobId=41 JobName=kf5 UserId=root(0) Account=science Comment=KQ_JOB_ID=original",
        "JobId=42 JobName=kf5 UserId=scientist(24001) Account=science Comment=KQ_JOB_ID=original",
        "JobId=43 JobName=kf6 UserId=scientist(24001) Account=science Comment=KQ_JOB_ID=original",
      ].join("\n"),
    },
  ]);
  expect(
    await new SlurmAdapter("19", { spawner }).findByKuintessenceJobId({
      jobId: "original",
      schedulerName: "kf5",
      submittedAfterUnixMs: Date.now(),
      executionUser: { uid: 24001, username: "scientist" },
      ...(account ? { schedulerAccount: "science" } : {}),
    }),
  ).toEqual({ status: "found", schedulerJobId: "42" });
  expect(calls[0]).toContain("24001");
  expect(calls[1]).toContain("24001");
  expect(calls.some((argv) => argv[0] === "id")).toBe(false);
});

test("completed submission is recovered by exact UUID from bounded Slurm accounting", async () => {
  const { spawner, calls } = mockSpawner([
    { exitCode: 0, stdout: "" },
    {
      exitCode: 0,
      stdout: "42|stable|KQ_JOB_ID=job-123|account\n43|stable|KQ_JOB_ID=other|account\n",
    },
  ]);
  const adapter = new SlurmAdapter("23", { spawner });
  expect(
    await adapter.findByKuintessenceJobId({
      jobId: "job-123",
      schedulerName: "stable",
      includeCompleted: true,
      submittedAfter: "2026-11-10",
    }),
  ).toEqual({ status: "found", schedulerJobId: "42" });
  expect(calls[1]).toContain("sacct");
  expect(calls[1]).toContain("2026-11-10");
});

describe("SlurmAdapter status uncertainty and cancellation confirmation", () => {
  test("a sole squeue row with a different explicit ID is never adopted", async () => {
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [{ job_id: 999, job_state: "COMPLETED", exit_code: { return_code: 0 } }],
        }),
      },
      { exitCode: 0, stdout: "RUNNING|0:0|123||||\n" },
    ]);
    expect((await new SlurmAdapter("23", { spawner }).status("123")).status).toBe("running");
    expect(calls[1]?.[0]).toBe("sacct");
  });

  test("accounting selects only the exact allocation ID, ignoring unrelated and step rows", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" },
      {
        exitCode: 0,
        stdout: "COMPLETED|0:0|999||||\nFAILED|1:0|123.batch||||\nRUNNING|0:0|123||||\n",
      },
    ]);
    expect((await new SlurmAdapter("23", { spawner }).status("123")).status).toBe("running");
  });

  test.each([
    "",
    "UNKNOWN",
    "FUTURE_STATE",
  ])("unknown state %s is retried rather than terminal", async (state) => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_id: 123, job_state: state }] }) },
    ]);
    await expect(new SlurmAdapter("23", { spawner }).status("123")).rejects.toThrow("Unknown");
  });

  test.each([
    0, 7,
  ])("completed squeue without exit code uses controller exit code %i", async (code) => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_id: 42, job_state: "COMPLETED" }] }) },
      { exitCode: 0, stdout: SCONTROL_COMPLETED.replace("ExitCode=0:0", `ExitCode=${code}:0`) },
    ]);
    const result = await new SlurmAdapter("21.08.5", {
      spawner,
      terminalStatusBackend: "scontrol",
    }).status("42");
    expect(result.status).toBe(code === 0 ? "completed" : "failed");
    expect(result.exitCode).toBe(code);
    expect(calls.map((command) => command[0])).toEqual(["squeue", "scontrol"]);
  });

  test("completed squeue without exit code uses the exact accounting allocation", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_id: 123, job_state: "COMPLETED" }] }) },
      { exitCode: 0, stdout: "COMPLETED|0:0|999||||\nCOMPLETED|0:0|123||||\n" },
    ]);
    expect(await new SlurmAdapter("23", { spawner }).status("123")).toEqual({
      status: "completed",
      exitCode: 0,
    });
    expect(calls.map((command) => command[0])).toEqual(["squeue", "sacct"]);
  });

  test("completed without an exit code in either source is not assumed successful", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: JSON.stringify({ jobs: [{ job_id: 42, job_state: "COMPLETED" }] }) },
      { exitCode: 0, stdout: SCONTROL_COMPLETED.replace("ExitCode=0:0", "") },
    ]);
    await expect(
      new SlurmAdapter("21.08.5", {
        spawner,
        terminalStatusBackend: "scontrol",
      }).status("42"),
    ).rejects.toThrow("exit code");
  });

  test("COMPLETING array flag is nonterminal even alongside a terminal base state", async () => {
    const { spawner } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [
            { job_id: 123, job_state: ["COMPLETED", "COMPLETING"], exit_code: { return_code: 0 } },
          ],
        }),
      },
    ]);
    expect(await new SlurmAdapter("23", { spawner }).confirmStopped("123")).toBe(false);
  });

  test("missing controller/accounting records never confirm a cancelled job stopped", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 1, stdout: "", stderr: "Invalid job id specified" },
    ]);
    await expect(new SlurmAdapter("23", { spawner }).confirmStopped("123")).rejects.toThrow(
      "unavailable",
    );
  });

  test("a mismatching scontrol identity cannot confirm termination", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: SCONTROL_COMPLETED },
    ]);
    await expect(
      new SlurmAdapter("23", { spawner, terminalStatusBackend: "scontrol" }).confirmStopped("123"),
    ).rejects.toThrow("identity");
  });

  test("only an explicit matching terminal state confirms cancellation, including signal exits", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "CANCELLED by 1000|0:15|123||||\n" },
    ]);
    expect(await new SlurmAdapter("23", { spawner }).confirmStopped("123")).toBe(true);
    const json = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          jobs: [
            { job_id: 123, job_state: "COMPLETED", exit_code: { return_code: 0, signal: 15 } },
          ],
        }),
      },
    ]);
    expect(await new SlurmAdapter("23", { spawner: json.spawner }).status("123")).toMatchObject({
      status: "failed",
      exitCode: 143,
    });
  });
});

test("status control commands have deadlines and accounting states are not truncated", async () => {
  const commands: string[][] = [];
  const spawner: Spawner = {
    run: async (argv, options) => {
      commands.push(argv);
      expect(options?.timeoutMs).toBe(10_000);
      if (argv[0] === "squeue") return { exitCode: 0, stdout: "", stderr: "" };
      if (argv[0] === "sacct") {
        expect(argv).toContain("--format=State%64,ExitCode,JobIDRaw,ElapsedRaw,AllocCPUS,TotalCPU");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "JobId=123 JobState=OUT_OF_MEMORY ExitCode=0:9", stderr: "" };
    },
  };
  expect(await new SlurmAdapter("23", { spawner }).confirmStopped("123")).toBe(true);
  expect(commands.map((argv) => argv[0])).toEqual(["squeue", "sacct", "scontrol"]);
});

describe("Slurm submission reconciliation identity", () => {
  test("live and accounting rows with the same UUID but different IDs are ambiguous", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "123|stable|KQ_JOB_ID=job-123|account\n" },
      { exitCode: 0, stdout: "456|stable|KQ_JOB_ID=job-123|account\n" },
    ]);
    expect(
      await new SlurmAdapter("23", { spawner }).findByKuintessenceJobId({
        jobId: "job-123",
        schedulerName: "stable",
        includeCompleted: true,
        submittedAfter: "2026-11-10",
      }),
    ).toMatchObject({
      status: "indeterminate",
      reason: "multiple Slurm jobs share Kuintessence UUID",
    });
  });

  test("the same allocation seen by both backends is confirmed only once", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "123|stable|KQ_JOB_ID=job-123|account\n" },
      { exitCode: 0, stdout: "123|stable|KQ_JOB_ID=job-123|account\n" },
    ]);
    expect(
      await new SlurmAdapter("23", { spawner }).findByKuintessenceJobId({
        jobId: "job-123",
        schedulerName: "stable",
        includeCompleted: true,
        submittedAfter: "2026-11-10",
      }),
    ).toEqual({ status: "found", schedulerJobId: "123" });
  });

  test("invalid queue IDs and failed historical confirmation never prove absence or uniqueness", async () => {
    const invalid = mockSpawner([
      { exitCode: 0, stdout: "not-an-allocation|stable|KQ_JOB_ID=job-123|account\n" },
    ]);
    expect(
      await new SlurmAdapter("23", { spawner: invalid.spawner }).findByKuintessenceJobId({
        jobId: "job-123",
        schedulerName: "stable",
      }),
    ).toMatchObject({ status: "indeterminate" });
    const missing = mockSpawner([
      { exitCode: 0, stdout: "123|stable|KQ_JOB_ID=job-123|account\n" },
      { exitCode: 1, stdout: "", stderr: "accounting unavailable" },
    ]);
    expect(
      await new SlurmAdapter("23", { spawner: missing.spawner }).findByKuintessenceJobId({
        jobId: "job-123",
        schedulerName: "stable",
        includeCompleted: true,
        submittedAfter: "2026-11-10",
      }),
    ).toMatchObject({ status: "indeterminate" });
  });

  test("sbatch and scancel have deadlines, and timed-out submission stays uncertain", async () => {
    const adapter = new SlurmAdapter("23", {
      spawner: {
        run: async (argv, options) => {
          expect(options?.timeoutMs).toBe(argv[0] === "sbatch" ? 30_000 : 10_000);
          throw new Error("transport deadline exceeded");
        },
      },
    });
    await expect(
      adapter.submit({
        jobId: "bounded",
        name: "fixture",
        command: "true",
        cpus: 1,
        memoryMb: 64,
        gpus: 0,
        wallTimeSec: 60,
        workingDir: "/shared/fixture",
        envVars: {},
      }),
    ).rejects.toMatchObject({ name: "SchedulerSubmissionUnknownError" });
    await expect(adapter.cancel("123")).rejects.toThrow("deadline");
  });
});

test.each([
  {
    stderr: "sbatch: error: Batch job submission failed: Socket timed out on send/recv operation",
    stdout: "",
  },
  {
    stderr:
      "sbatch: error: invalid partition specified: missing\nsbatch: error: Batch job submission failed: Invalid partition name specified\nconnection lost",
    stdout: "",
  },
  {
    stderr:
      "sbatch: error: invalid partition specified: missing\nsbatch: error: Batch job submission failed: Socket timed out on send/recv operation",
    stdout: "",
  },
  {
    stderr:
      "sbatch: error: invalid partition specified: missing\nsbatch: error: Batch job submission failed: Invalid partition name specified",
    stdout: "123\n",
  },
  { stderr: "permission denied", stdout: "" },
  { stderr: "unrecognized scheduler error", stdout: "" },
  {
    stderr:
      "other command: sbatch: error: Batch job submission failed: Invalid partition name specified",
    stdout: "",
  },
  {
    stderr:
      "sbatch: error: Batch job submission failed: Invalid partition name specified\nconnection lost",
    stdout: "",
  },
  {
    stderr: "sbatch: error: Batch job submission failed: Invalid partition name specified",
    stdout: "123\n",
  },
])("nonzero submission is uncertain unless its sole controller rejection is unambiguous: %j", async (response) => {
  const { spawner } = mockSpawner([{ exitCode: 1, ...response }]);
  await expect(
    new SlurmAdapter("23", { spawner }).submit({
      jobId: "uncertain-exit",
      name: "fixture",
      command: "true",
      cpus: 1,
      memoryMb: 64,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "/shared/fixture",
      envVars: {},
    }),
  ).rejects.toMatchObject({ name: "SchedulerSubmissionUnknownError" });
});

test.each([
  false,
  true,
])("Slurm log control and tail reads are bounded (includeStderr=%s)", async (includeStderr) => {
  const commands: string[][] = [];
  const adapter = new SlurmAdapter("23", {
    spawner: {
      run: async (argv, options) => {
        commands.push(argv);
        expect(options?.timeoutMs).toBe(10_000);
        return {
          exitCode: 0,
          stdout:
            argv[0] === "scontrol"
              ? "JobId=123 StdOut=/shared/log.out StdErr=/shared/log.err"
              : "logs",
          stderr: "",
        };
      },
    },
  });
  expect(await adapter.getJobLogs("123", 10, "fixture", includeStderr)).toContain("logs");
  expect(commands[0]?.[0]).toBe("scontrol");
  expect(commands[1]?.[0]).toBe("tail");
});

describe("Slurm controller submission reconciliation without accounting", () => {
  const lookup = {
    jobId: "job-123",
    schedulerName: "stable",
    includeCompleted: true,
    submittedAfter: "2026-11-10",
  };
  const row = (id = "123", uid = process.getuid?.() ?? 0, account = "account") =>
    `JobId=${id} JobName=stable Comment=KQ_JOB_ID=job-123 Account=${account} UserId=fixture(${uid}) JobState=COMPLETED`;

  test.each([
    "",
    "123|stable|KQ_JOB_ID=job-123|account\n",
  ])("recovers retained completed allocations and merges the same live allocation: %s", async (queue) => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: queue },
      { exitCode: 0, stdout: row() },
    ]);
    expect(
      await new SlurmAdapter("23", {
        spawner,
        terminalStatusBackend: "scontrol",
      }).findByKuintessenceJobId(lookup),
    ).toEqual({ status: "found", schedulerJobId: "123" });
    expect(calls).toEqual([
      [
        "squeue",
        "--noheader",
        "--name",
        "stable",
        "--user",
        String(process.getuid?.() ?? 0),
        "--format=%i|%j|%k|%a",
      ],
      ["scontrol", "show", "job", "-o"],
    ]);
  });

  test("preserves mapped account scope rather than guessing its uid", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: `${row("123", 4321, "mapped")}\n${row("456", 4321, "other")}` },
    ]);
    expect(
      await new SlurmAdapter("23", {
        spawner,
        terminalStatusBackend: "scontrol",
      }).findByKuintessenceJobId({ ...lookup, schedulerAccount: "mapped" }),
    ).toEqual({ status: "found", schedulerJobId: "123" });
  });

  test.each([
    "",
    "No jobs in the system",
    row("123_2"),
    row("0"),
    row("9007199254740992"),
    `${row()} JobId=456`,
    `${row()} Comment=other`,
    `${row()} UserId=other(123)`,
    `${row()} Account=other`,
    `${row()} JobName=other`,
    row().replace(/UserId=\S+/, "UserId=invalid"),
    row("123", (process.getuid?.() ?? 0) + 1),
    row().replace("JobName=stable", "JobName=other"),
    row().replace("KQ_JOB_ID=job-123", "KQ_JOB_ID=job-123-extra"),
    `${row()}\n${row("456")}`,
    `${row()}\n${row()}`,
  ])("retained history cannot confirm ambiguous or unauthorized identities: %s", async (history) => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: history },
    ]);
    expect(
      await new SlurmAdapter("23", {
        spawner,
        terminalStatusBackend: "scontrol",
      }).findByKuintessenceJobId(lookup),
    ).toMatchObject({ status: "indeterminate" });
  });

  test.each([
    { exitCode: 1, stdout: "", stderr: "controller unavailable" },
    { exitCode: 0, stdout: row("456") },
    { exitCode: 0, stdout: row("123", (process.getuid?.() ?? 0) + 1) },
  ])("a queue hit does not bypass failed or conflicting controller confirmation: %j", async (history) => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: "123|stable|KQ_JOB_ID=job-123|account\n" },
      history,
    ]);
    expect(
      await new SlurmAdapter("23", {
        spawner,
        terminalStatusBackend: "scontrol",
      }).findByKuintessenceJobId(lookup),
    ).toMatchObject({ status: "indeterminate" });
  });
});

test.each([
  {
    history:
      "JobId=123 JobName=stable Comment=KQ_JOB_ID=job-123 Account=account UserId=fixture(UID)",
    expected: "found",
  },
  {
    history:
      "JobId=456 JobName=stable Comment=KQ_JOB_ID=job-123 Account=account UserId=fixture(UID)",
    expected: "indeterminate",
  },
  { history: "", expected: "indeterminate" },
  { history: null, expected: "indeterminate" },
])("default accounting lookup safely falls back to controller: %j", async ({
  history,
  expected,
}) => {
  const { spawner, calls } = mockSpawner([
    { exitCode: 0, stdout: "123|stable|KQ_JOB_ID=job-123|account\n" },
    { exitCode: 1, stdout: "", stderr: "accounting disabled" },
    {
      exitCode: history === null ? 1 : 0,
      stdout: (history ?? "").replace("UID", String(process.getuid?.() ?? 0)),
    },
  ]);
  const result = await new SlurmAdapter("23", { spawner }).findByKuintessenceJobId({
    jobId: "job-123",
    schedulerName: "stable",
    includeCompleted: true,
    submittedAfter: "2026-11-10",
  });
  expect(result.status).toBe(expected);
  if (expected === "found") expect(result).toEqual({ status: "found", schedulerJobId: "123" });
  expect(calls.map((argv) => argv[0])).toEqual(["squeue", "sacct", "scontrol"]);
});
