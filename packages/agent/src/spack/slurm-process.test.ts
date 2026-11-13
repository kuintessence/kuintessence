import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slurmSpackProcess } from "./slurm-process";

const purged = {
  exitCode: 1,
  stdout: "",
  stderr: "slurm_load_jobs error: Invalid job id specified",
};

test("held Slurm job identity is recorded before release, then terminal output is collected", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kq-build-"));
  try {
    const calls: string[][] = [];
    const process = slurmSpackProcess("cn", {
      run: async (argv) => {
        calls.push(argv);
        if (argv[0]?.endsWith("sbatch")) {
          expect(argv).toContain("--hold");
          expect(argv).toContain("--no-requeue");
          return { exitCode: 0, stdout: "12345\n", stderr: "" };
        }
        if (argv[0]?.endsWith("scontrol") && argv.includes("show")) {
          const journal = JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8"));
          return {
            exitCode: 0,
            stdout: `JobId=12345 JobName=${journal.name} JobState=COMPLETED ExitCode=0:0 Requeue=0`,
            stderr: "",
          };
        }
        if (argv[0]?.endsWith("sacct")) throw new Error("accounting disabled");
        if (argv[0]?.endsWith("scontrol")) {
          expect(JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8")).jobId).toBe("12345");
          await writeFile(join(cwd, "slurm.stdout"), "report");
        }
        return {
          exitCode: 0,
          stdout: argv[0]?.endsWith("sacct") ? "12345|COMPLETED|0:0\n" : "",
          stderr: "",
        };
      },
    });
    const result = await process.run(["/usr/bin/apptainer", "exec", "/shared/runtime.sif"], {
      cwd,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 60000,
      maxOutputBytes: 4096,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "report", stderr: "" });
    const journal = JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8"));
    expect(result.slurmTerminal).toEqual({
      jobId: "12345",
      name: journal.name,
      binding: journal.binding,
      state: "COMPLETED",
      noRequeue: true,
    });
    expect(await readFile(join(cwd, "slurm.sh"), "utf8")).not.toContain("ulimit -f");
    expect(calls.filter((argv) => argv[0]?.endsWith("sbatch"))).toHaveLength(1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ambiguous submission is never retried or mistaken for a stopped worker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kq-build-unknown-"));
  try {
    let submissions = 0;
    const process = slurmSpackProcess("cn", {
      run: async () => {
        submissions++;
        throw new Error("lost reply");
      },
    });
    await expect(
      process.run(["/usr/bin/apptainer"], { cwd, env: {}, timeoutMs: 1000, maxOutputBytes: 4096 }),
    ).rejects.toThrow("reconciliation");
    expect(submissions).toBe(1);
    expect(JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8")).phase).toBe(
      "recovery-required",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("excessive worker logs stop the job and retain its reconciliation journal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kq-build-output-"));
  try {
    let cancelled = false;
    const process = slurmSpackProcess("cn", {
      run: async (argv) => {
        if (argv[0]?.endsWith("sbatch")) return { exitCode: 0, stdout: "123", stderr: "" };
        if (argv[0]?.endsWith("scontrol"))
          await writeFile(join(cwd, "slurm.stdout"), "too much output");
        if (argv[0]?.endsWith("scancel")) cancelled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await expect(
      process.run(["/usr/bin/apptainer"], { cwd, env: {}, timeoutMs: 1000, maxOutputBytes: 4 }),
    ).rejects.toThrow("reconciliation");
    expect(cancelled).toBe(true);
    expect(JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8")).jobId).toBe("123");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retrying a lost submission adopts the uniquely named held job without another sbatch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kq-recover-"));
  const options = { cwd, env: {}, timeoutMs: 60000, maxOutputBytes: 4096 };
  try {
    await expect(
      slurmSpackProcess("cn", {
        run: async () => {
          throw new Error("lost");
        },
      }).run(["/usr/bin/apptainer"], options),
    ).rejects.toThrow();
    const journal = JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8"));
    const calls: string[][] = [];
    let released = false;
    const result = await slurmSpackProcess("cn", {
      run: async (argv) => {
        calls.push(argv);
        if (argv[0]?.endsWith("squeue"))
          return {
            exitCode: 0,
            stdout: released ? "" : `123|${journal.name}|JobHeldUser\n`,
            stderr: "",
          };
        if (argv[0]?.endsWith("sacct")) throw new Error("accounting disabled");
        if (argv[0]?.endsWith("scontrol") && argv.includes("show"))
          return {
            exitCode: 0,
            stdout: `JobId=123 JobName=${journal.name} JobState=COMPLETED ExitCode=0:0 Requeue=0`,
            stderr: "",
          };
        released = true;
        await writeFile(join(cwd, "slurm.stdout"), "report");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }).run(["/usr/bin/apptainer"], options);
    expect(result.exitCode).toBe(0);
    expect(calls.some((argv) => argv[0]?.endsWith("sbatch"))).toBe(false);
    await expect(slurmSpackProcess("cn").run(["/different/command"], options)).rejects.toThrow(
      "binding",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit recovery uses controller proof without accounting and rejects missing or ambiguous records", async () => {
  const { confirmSlurmSpackWorkerStopped } = await import("./slurm-process");
  const { mkdir } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "kq-terminal-"));
  const expected = {
    manifestDigest: `sha256:${"a".repeat(64)}`,
    siteProfileDigest: `sha256:${"b".repeat(64)}`,
    storePath: "/shared/store/releases/test",
  };
  const name = "kq-build-12345678-1234-4123-8123-123456789012";
  try {
    await mkdir(join(cwd, "input"), { mode: 0o700 });
    await writeFile(
      join(cwd, "input/request.json"),
      JSON.stringify({ ...expected, action: "install" }),
      { mode: 0o400 },
    );
    await writeFile(
      join(cwd, "slurm.json"),
      JSON.stringify({ name, jobId: "123", binding: "a".repeat(64), noRequeue: true }),
      { mode: 0o600 },
    );
    await writeFile(join(cwd, "slurm.stdout"), "forged success");
    for (const output of [
      "",
      `123|${name}|RUNNING|0:0\n`,
      `124|${name}|COMPLETED|0:0\n`,
      `123|${name}|COMPLETED|0:0\n123|${name}|COMPLETED|0:0\n`,
    ]) {
      await expect(
        confirmSlurmSpackWorkerStopped(cwd, expected, {
          run: async (argv) =>
            argv[0]?.endsWith("scontrol")
              ? purged
              : {
                  exitCode: 0,
                  stdout: argv[0]?.endsWith("sacct") ? output : "",
                  stderr: "",
                },
        }),
      ).rejects.toThrow("terminal");
    }
    for (const controller of [
      "",
      `JobId=123 JobName=${name} JobState=PREEMPTED ExitCode=0:0 Requeue=1`,
      `JobId=124 JobName=${name} JobState=COMPLETED ExitCode=0:0 Requeue=0`,
      `JobId=123 JobName=${name} JobState=PENDING ExitCode=0:0 Requeue=0`,
    ]) {
      await expect(
        confirmSlurmSpackWorkerStopped(cwd, expected, {
          run: async (argv) => ({
            exitCode: 0,
            stderr: "",
            stdout: argv[0]?.endsWith("sacct")
              ? `123|${name}|PREEMPTED|0:0\n`
              : argv[0]?.endsWith("scontrol")
                ? controller
                : "",
          }),
        }),
      ).rejects.toThrow("terminal");
    }
    await confirmSlurmSpackWorkerStopped(cwd, expected, {
      run: async (argv) => ({
        exitCode: argv[0]?.endsWith("sacct") ? 1 : 0,
        stdout: argv[0]?.endsWith("scontrol")
          ? `JobId=123 JobName=${name} JobState=COMPLETED ExitCode=0:0 Requeue=0`
          : "",
        stderr: "",
      }),
    });
    await expect(
      confirmSlurmSpackWorkerStopped(
        cwd,
        { ...expected, manifestDigest: "wrong" },
        {
          run: async () => {
            throw new Error("must not query");
          },
        },
      ),
    ).rejects.toThrow("terminal");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a controller outage cannot fall back to stale accounting or mark the worker stopped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kq-controller-unavailable-"));
  try {
    let accounting = false;
    await expect(
      slurmSpackProcess("cn", {
        run: async (argv) => {
          if (argv[0]?.endsWith("sbatch")) return { exitCode: 0, stdout: "123", stderr: "" };
          if (argv[0]?.endsWith("scontrol") && argv.includes("show"))
            return { exitCode: 1, stdout: "", stderr: "Unable to contact slurm controller" };
          if (argv[0]?.endsWith("sacct")) accounting = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }).run(["/usr/bin/apptainer"], { cwd, env: {}, timeoutMs: 60000, maxOutputBytes: 4096 }),
    ).rejects.toThrow("reconciliation");
    expect(accounting).toBe(false);
    expect(JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8")).phase).toBe(
      "recovery-required",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Spack worker polling requests untruncated Slurm terminal state names", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kq-memory-state-"));
  try {
    const worker = slurmSpackProcess("cn", {
      run: async (argv) => {
        if (argv[0]?.endsWith("sbatch")) return { exitCode: 0, stdout: "123", stderr: "" };
        if (argv[0]?.endsWith("scontrol") && argv.includes("show")) return purged;
        if (argv[0]?.endsWith("sacct")) {
          expect(argv).toContain("--format=JobIDRaw,State%64,ExitCode");
          return { exitCode: 0, stdout: "123|OUT_OF_MEMORY|0:9\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(
      (
        await worker.run(["/usr/bin/apptainer"], {
          cwd,
          env: {},
          timeoutMs: 60000,
          maxOutputBytes: 4096,
        })
      ).exitCode,
    ).toBe(1);
    expect(JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8")).phase).toBe("OUT_OF_MEMORY");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal accounting cannot permit cleanup while a worker remains queued", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kq-requeue-"));
  try {
    await expect(
      slurmSpackProcess("cn", {
        run: async (argv) =>
          argv[0]?.endsWith("scontrol") && argv.includes("show")
            ? purged
            : {
                exitCode: 0,
                stderr: "",
                stdout: argv[0]?.endsWith("sbatch")
                  ? "123"
                  : argv[0]?.endsWith("sacct")
                    ? "123|PREEMPTED|0:0\n"
                    : argv[0]?.endsWith("squeue")
                      ? "123|worker\n"
                      : "",
              },
      }).run(["/usr/bin/apptainer"], { cwd, env: {}, timeoutMs: 60000, maxOutputBytes: 4096 }),
    ).rejects.toThrow("reconciliation");
    const journal = JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8"));
    expect(journal.noRequeue).toBe(true);
    expect(journal.phase).toBe("recovery-required");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("live controller states wait without accounting until a no-requeue terminal record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "kq-controller-"));
  try {
    const phases = ["PENDING", "RUNNING", "COMPLETED"];
    const result = await slurmSpackProcess("cn", {
      run: async (argv) => {
        if (argv[0]?.endsWith("sbatch")) return { exitCode: 0, stdout: "123", stderr: "" };
        if (argv[0]?.endsWith("sacct")) throw new Error("accounting disabled");
        if (argv[0]?.endsWith("scontrol") && argv.includes("show")) {
          const journal = JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8"));
          expect(argv).toContain("-o");
          return {
            exitCode: 0,
            stdout: `JobId=123 JobName=${journal.name} JobState=${phases.shift()} ExitCode=0:0 Requeue=0`,
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }).run(["/usr/bin/apptainer"], { cwd, env: {}, timeoutMs: 60000, maxOutputBytes: 4096 });
    expect(result.exitCode).toBe(0);
    expect(phases).toHaveLength(0);
    expect(JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8")).phase).toBe("COMPLETED");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("conflicting controller identities cannot authorize accounting fallback or cleanup", async () => {
  for (const fields of ["JobId=124", "JobId=123 JobId=124", "JobId=123 JobName=other"]) {
    const cwd = await mkdtemp(join(tmpdir(), "kq-controller-conflict-"));
    try {
      let accounting = false;
      await expect(
        slurmSpackProcess("cn", {
          run: async (argv) => {
            if (argv[0]?.endsWith("sbatch")) return { exitCode: 0, stdout: "123", stderr: "" };
            if (argv[0]?.endsWith("sacct")) accounting = true;
            if (argv[0]?.endsWith("scontrol") && argv.includes("show")) {
              const journal = JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8"));
              return {
                exitCode: 0,
                stdout: `${fields} JobName=${journal.name} JobState=COMPLETED ExitCode=0:0 Requeue=0`,
                stderr: "",
              };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }).run(["/usr/bin/apptainer"], { cwd, env: {}, timeoutMs: 60000, maxOutputBytes: 4096 }),
      ).rejects.toThrow("reconciliation");
      expect(accounting).toBe(false);
      expect(JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8")).phase).toBe(
        "recovery-required",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("scheduler memory covers the larger audit or configured managed budget with headroom", async () => {
  for (const [managedMemoryMib, expected] of [
    [1024, 2560],
    [2048, 2560],
    [3072, 3584],
    [4096, 4608],
    [32768, 33280],
    [1048576, 1049088],
  ]) {
    const cwd = await mkdtemp(join(tmpdir(), "kq-memory-budget-"));
    try {
      const result = await slurmSpackProcess(
        "cn",
        {
          run: async (argv) => {
            if (argv[0]?.endsWith("sbatch")) {
              expect(argv).toContain(`--mem=${expected}M`);
              return { exitCode: 0, stdout: "123", stderr: "" };
            }
            if (argv[0]?.endsWith("scontrol") && argv.includes("show")) {
              const journal = JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8"));
              return {
                exitCode: 0,
                stdout: `JobId=123 JobName=${journal.name} JobState=COMPLETED ExitCode=0:0 Requeue=0`,
                stderr: "",
              };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        { managedMemoryMib },
      ).run(["/usr/bin/apptainer"], { cwd, env: {}, timeoutMs: 60000, maxOutputBytes: 4096 });
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
  for (const managedMemoryMib of [0, 1023, 1048577, 2048.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      slurmSpackProcess(
        "cn",
        {
          run: async () => {
            throw new Error("must not submit");
          },
        },
        { managedMemoryMib },
      ),
    ).toThrow("memory budget");
  }
});

test.each([
  { state: "OUT_OF_MEMORY", code: "0:9", reason: "out-of-memory", accounting: true },
  { state: "OUT_OF_MEMORY", code: "1:0", reason: "out-of-memory", accounting: false },
  { state: "FAILED", code: "137:0", reason: "killed", accounting: false },
  { state: "FAILED", code: "0:9", reason: "killed", accounting: true },
  { state: "FAILED", code: "1:0", reason: undefined, accounting: false },
  { state: "CANCELLED", code: "0:9", reason: undefined, accounting: true },
  { state: "COMPLETED", code: "0:0", reason: undefined, accounting: false },
])("classifies only proven scheduler terminal status: %j", async ({
  state,
  code,
  reason,
  accounting,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), "kq-terminal-reason-"));
  try {
    const worker = slurmSpackProcess("cn", {
      run: async (argv) => {
        if (argv[0]?.endsWith("sbatch")) {
          await writeFile(join(cwd, "slurm.stderr"), "OUT_OF_MEMORY private path /secret");
          return { exitCode: 0, stdout: "123", stderr: "" };
        }
        if (argv[0]?.endsWith("scontrol") && argv.includes("show")) {
          if (accounting) return purged;
          const journal = JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8"));
          return {
            exitCode: 0,
            stdout: `JobId=123 JobName=${journal.name} JobState=${state} ExitCode=${code} Requeue=0`,
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: argv[0]?.endsWith("sacct") ? `123|${state}|${code}\n` : "",
          stderr: "",
        };
      },
    });
    const result = await worker.run(["/usr/bin/apptainer"], {
      cwd,
      env: {},
      timeoutMs: 60000,
      maxOutputBytes: 4096,
    });
    expect(result.exitCode).toBe(state === "COMPLETED" ? 0 : 1);
    expect(result.terminationReason).toBe(reason);
    expect(result.scheduler).toEqual(state === "COMPLETED" ? undefined : { state, exitCode: code });
    const journal = JSON.parse(await readFile(join(cwd, "slurm.json"), "utf8"));
    expect(journal.phase).toBe(state);
    expect(journal.schedulerExitCode).toBe(code);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects reservations larger than the configured Slurm site limit before submission", () => {
  expect(() =>
    slurmSpackProcess("build", undefined, { managedMemoryMib: 32768, memoryLimitMib: 32768 }),
  ).toThrow("site memory limit");
  for (const memoryLimitMib of [0, 2559, 1049089, NaN, Infinity, 33280.5]) {
    expect(() =>
      slurmSpackProcess("build", undefined, { managedMemoryMib: 32768, memoryLimitMib }),
    ).toThrow("site memory limit");
  }
});
