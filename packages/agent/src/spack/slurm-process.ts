import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realSpackAuditProcess, type SpackAuditProcess } from "./audit-process";
import { type SpackWorkerStopProof, SpackWorkerStopProofSchema } from "./install-contract";

export class SpackWorkerUncertainError extends Error {}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const terminal = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "OUT_OF_MEMORY",
  "NODE_FAIL",
  "PREEMPTED",
  "BOOT_FAIL",
  "DEADLINE",
]);

type ControlResult = Awaited<ReturnType<SpackAuditProcess["run"]>>;

function controllerStatus(result: ControlResult, jobId: string, name: string) {
  if (result.exitCode !== 0) {
    // Only an explicit missing ID permits falling back to accounting.
    if (
      /^(?:slurm_load_jobs error: )?Invalid job id specified$/.test(result.stderr.trim()) &&
      !result.stdout.trim()
    )
      return undefined;
    throw new SpackWorkerUncertainError("Slurm controller status is unavailable");
  }
  const field = (key: string) => {
    const values = [...result.stdout.matchAll(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, "g"))];
    if (values.length !== 1)
      throw new SpackWorkerUncertainError("Ambiguous Slurm controller status");
    return values[0]?.[1];
  };
  const id = field("JobId");
  const jobName = field("JobName");
  const phase = field("JobState");
  const exitCode = field("ExitCode");
  const requeue = field("Requeue");
  if (
    id !== jobId ||
    jobName !== name ||
    !phase ||
    !/^[A-Z_]+$/.test(phase) ||
    !exitCode ||
    !/^\d+:\d+$/.test(exitCode) ||
    requeue !== "0"
  )
    throw new SpackWorkerUncertainError("Slurm controller identity or no-requeue proof mismatch");
  return { phase, exitCode };
}

/** Held submission prevents a worker from starting before its scheduler identity is durable. */
export function slurmSpackProcess(
  partition: string,
  transport: SpackAuditProcess = realSpackAuditProcess,
  settings: {
    binDir?: string;
    account?: string;
    qos?: string;
    managedMemoryMib?: number;
    memoryLimitMib?: number;
  } = {},
): SpackAuditProcess {
  if (!/^[A-Za-z0-9_-]+$/.test(partition)) throw new Error("Invalid Spack Slurm partition");
  const binDir = settings.binDir ?? "/usr/bin";
  if (!/^\/[A-Za-z0-9_./-]+$/.test(binDir) || binDir.split("/").includes(".."))
    throw new Error("Invalid Slurm binary directory");
  const managedMemoryMib = settings.managedMemoryMib ?? 4096;
  if (!Number.isInteger(managedMemoryMib) || managedMemoryMib < 1024 || managedMemoryMib > 1048576)
    throw new Error("Invalid managed Spack memory budget");
  const requestedMemoryMib = Math.max(2048, managedMemoryMib) + 512;
  const memoryLimitMib = settings.memoryLimitMib ?? 1049088;
  if (
    !Number.isSafeInteger(memoryLimitMib) ||
    memoryLimitMib < 2560 ||
    memoryLimitMib > 1049088 ||
    requestedMemoryMib > memoryLimitMib
  )
    throw new Error("Managed Spack Slurm reservation exceeds site memory limit");
  const scheduling: string[] = [];
  for (const [key, value] of [
    ["account", settings.account],
    ["qos", settings.qos],
  ] as const) {
    if (value) {
      if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Invalid Slurm scheduling value");
      scheduling.push(`--${key}=${value}`);
    }
  }
  return {
    async run(command, options) {
      const inputs = createHash("sha256");
      let inputNames: string[] = [];
      try {
        inputNames = (await readdir(join(options.cwd, "input"))).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const filename of inputNames) {
        // runtime.json is populated on the compute node after the durable submission.
        if (filename === "runtime.json" || filename === "blobs") continue;
        const path = join(options.cwd, "input", filename);
        const entry = await lstat(path);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16 * 1024 ** 2)
          throw new SpackWorkerUncertainError("Unsafe Spack worker input binding");
        inputs
          .update(filename)
          .update("\0")
          .update(await readFile(path))
          .update("\0");
      }
      const inputDigest = inputs.digest("hex");
      const binding = createHash("sha256")
        .update(
          JSON.stringify({
            command,
            cwd: options.cwd,
            env: options.env,
            partition,
            scheduling,
            requestedMemoryMib,
            inputDigest,
            noRequeue: true,
          }),
        )
        .digest("hex");
      let name = `kq-build-${randomUUID()}`;
      const statePath = join(options.cwd, "slurm.json");
      const stdout = join(options.cwd, "slurm.stdout");
      const stderr = join(options.cwd, "slurm.stderr");
      const script = join(options.cwd, "slurm.sh");
      let previous:
        | {
            name: string;
            binding: string;
            jobId?: string;
            phase: string;
            deadline: number;
            noRequeue?: boolean;
          }
        | undefined;
      try {
        const entry = await lstat(statePath);
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          entry.uid !== process.getuid?.() ||
          (entry.mode & 0o077) !== 0 ||
          entry.size > 16384
        )
          throw new Error("Unsafe Spack Slurm journal");
        previous = JSON.parse(await readFile(statePath, "utf8"));
        if (
          !previous ||
          !/^kq-build-[a-f0-9-]{36}$/.test(previous.name) ||
          previous.binding !== binding ||
          !Number.isSafeInteger(previous.deadline) ||
          (previous.jobId !== undefined && !/^\d+$/.test(previous.jobId))
        )
          throw new Error("Spack Slurm journal binding mismatch");
        name = previous.name;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new SpackWorkerUncertainError(
            "Spack Slurm journal requires reconciliation: binding mismatch or unsafe journal",
          );
      }
      const deadline = previous?.deadline ?? Date.now() + options.timeoutMs;
      async function state(value: object) {
        const temporary = `${statePath}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(
            JSON.stringify({ name, partition, binding, deadline, noRequeue: true, ...value }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, statePath);
        const directory = await open(options.cwd, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      const control = (argv: string[]) =>
        transport.run(argv, {
          ...options,
          signal: undefined,
          timeoutMs: 30_000,
          maxOutputBytes: 65536,
        });
      const run = async (argv: string[]) => {
        const result = await control(argv);
        if (result.exitCode !== 0) throw new Error("Spack Slurm control command failed");
        return result.stdout.trim();
      };
      // runtime.json describes the compute host, not the login node.
      const runtime =
        'printf \'{"hostNetworkNamespace":"%s","hostPidNamespace":"%s"}\\n\' "$(readlink /proc/self/ns/net)" "$(readlink /proc/self/ns/pid)" > input/runtime.json';
      const env = Object.entries(options.env).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid worker environment");
        return `export ${key}=${quote(value)}`;
      });
      if (!previous)
        await writeFile(
          script,
          [
            "#!/bin/bash",
            "set -euo pipefail",
            `cd ${quote(options.cwd)}`,
            ...env,
            "chmod u+w input/runtime.json",
            runtime,
            "chmod 400 input/runtime.json",
            `exec ${command.map(quote).join(" ")}`,
            "",
          ].join("\n"),
          { mode: 0o700, flag: "wx" },
        );
      if (!previous) await state({ phase: "submitting" });
      let jobId: string | undefined = previous?.jobId;
      let stopped = false;
      let cancelRequested = false;
      let held = false;
      try {
        options.signal?.throwIfAborted();
        if (previous) {
          // A lost sbatch reply can leave a held job; zero matches may be accounting delay.
          const matches = new Set<string>();
          const queue = await run([
            join(binDir, "squeue"),
            "--noheader",
            "--name",
            name,
            "--format=%i|%j|%r",
          ]);
          for (const line of queue.split("\n").filter((line) => line.trim())) {
            const [id, jobName, reason] = line.trim().split("|");
            if (!id || !/^\d+$/.test(id) || jobName !== name || matches.has(id))
              throw new SpackWorkerUncertainError(
                "Cannot uniquely reconcile held Slurm submission",
              );
            matches.add(id);
            if (reason === "JobHeldUser") held = true;
          }
          // A live unique queue identity does not depend on optional accounting.
          if (!matches.size && jobId) matches.add(jobId);
          if (!matches.size) {
            const accounting = await run([
              join(binDir, "sacct"),
              "-n",
              "-P",
              "-X",
              "--name",
              name,
              "--format=JobIDRaw,JobName%100",
            ]);
            for (const line of accounting.split("\n").filter((line) => line.trim())) {
              const [id, jobName] = line.trim().split("|");
              if (!id || !/^\d+$/.test(id) || jobName !== name || matches.has(id))
                throw new SpackWorkerUncertainError(
                  "Cannot uniquely reconcile held Slurm submission",
                );
              matches.add(id);
            }
          }
          if (matches.size !== 1 || (jobId && !matches.has(jobId)))
            throw new SpackWorkerUncertainError("Cannot uniquely reconcile held Slurm submission");
          jobId = [...matches][0];
          await state({ phase: previous.phase, jobId });
        }
        if (!previous) {
          const submission = await run([
            join(binDir, "sbatch"),
            ...scheduling,
            "--parsable",
            "--hold",
            "--no-requeue",
            "--export=NONE",
            `--job-name=${name}`,
            `--comment=${name}`,
            `--partition=${partition}`,
            "--nodes=1",
            "--ntasks=1",
            "--cpus-per-task=2",
            `--mem=${requestedMemoryMib}M`,
            `--time=${Math.ceil(options.timeoutMs / 60000)}`,
            `--output=${stdout}`,
            `--error=${stderr}`,
            script,
          ]);
          jobId = submission.split(";")[0];
          if (!jobId || !/^\d+$/.test(jobId))
            throw new SpackWorkerUncertainError(
              "Spack submission outcome unknown; inspect slurm.json and job name before retry",
            );
          await state({ phase: "held", jobId });
        }
        if (!jobId) throw new SpackWorkerUncertainError("Missing Slurm worker identity");
        if (!previous || held) await run([join(binDir, "scontrol"), "release", jobId]);
        await state({ phase: "running", jobId });

        while (true) {
          if (options.signal?.aborted || Date.now() >= deadline)
            throw new Error("Spack Slurm execution interrupted");
          const outputSizes = await Promise.all(
            [stdout, stderr].map(async (path) => {
              try {
                return (await stat(path)).size;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
                throw error;
              }
            }),
          );
          if (outputSizes.reduce((sum, size) => sum + size, 0) > options.maxOutputBytes) {
            cancelRequested = true;
            throw new Error("Spack Slurm output limit exceeded");
          }
          let current = controllerStatus(
            await control([join(binDir, "scontrol"), "show", "job", "-o", jobId]),
            jobId,
            name,
          );
          if (!current) {
            if (previous && previous.noRequeue !== true)
              throw new SpackWorkerUncertainError(
                "Legacy Spack worker lacks durable no-requeue proof",
              );
            const status = await run([
              join(binDir, "sacct"),
              "-n",
              "-P",
              "-X",
              "-j",
              jobId,
              "--format=JobIDRaw,State%64,ExitCode",
            ]);
            const rows = status
              .split("\n")
              .map((line) => line.trim().split("|"))
              .filter((fields) => fields[0] === jobId);
            if (rows.length > 1)
              throw new SpackWorkerUncertainError("Ambiguous Slurm accounting status");
            const row = rows[0];
            if (row) {
              const phase = row[1]?.split(/[ +]/)[0] ?? "";
              const exitCode = row[2] ?? "";
              if (!/^[A-Z_]+$/.test(phase) || !/^\d+:\d+$/.test(exitCode))
                throw new SpackWorkerUncertainError("Invalid Slurm accounting status");
              current = { phase, exitCode };
            }
          }
          const phase = current?.phase ?? "";
          if (current && terminal.has(phase)) {
            // Accounting can still describe an earlier preempted attempt.
            const queued = await run([
              join(binDir, "squeue"),
              "--noheader",
              "--name",
              name,
              "--format=%i|%j",
            ]);
            if (queued.trim())
              throw new SpackWorkerUncertainError("Terminal Spack worker is still queued");
            stopped = true;
            await state({ phase, jobId, schedulerExitCode: current.exitCode });
            for (const path of [stdout, stderr]) {
              const size = await stat(path).then(
                (entry) => entry.size,
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT") return 0;
                  throw error;
                },
              );
              if (size > options.maxOutputBytes)
                throw new Error("Spack Slurm output limit exceeded");
            }
            const out = await readFile(stdout, "utf8").catch(() => "");
            const err = await readFile(stderr, "utf8").catch(() => "");
            if (Buffer.byteLength(out) + Buffer.byteLength(err) > options.maxOutputBytes)
              throw new Error("Spack Slurm output limit exceeded");
            const succeeded = phase === "COMPLETED" && current.exitCode === "0:0";
            const terminationReason =
              phase === "OUT_OF_MEMORY"
                ? "out-of-memory"
                : phase === "FAILED" && ["137:0", "0:9"].includes(current.exitCode)
                  ? "killed"
                  : undefined;
            return {
              exitCode: succeeded ? 0 : 1,
              stdout: out,
              stderr: err,
              slurmTerminal: { jobId, name, binding, state: phase, noRequeue: true },
              ...(!succeeded ? { scheduler: { state: phase, exitCode: current.exitCode } } : {}),
              ...(terminationReason ? { terminationReason } : {}),
            };
          }
          await Bun.sleep(1000);
        }
      } catch (error) {
        if (!stopped) {
          if (jobId && (cancelRequested || options.signal?.aborted || Date.now() >= deadline))
            await run([join(binDir, "scancel"), jobId]).catch(() => undefined);
          await state({ phase: "recovery-required", ...(jobId ? { jobId } : {}) });
          throw new SpackWorkerUncertainError(
            "Spack Slurm worker requires reconciliation; retain staging and query slurm.json before retry",
          );
        }
        throw error;
      } finally {
        await chmod(script, 0o400);
      }
    },
  };
}

/** Explicit recovery only fences a proven terminal worker; it never publishes worker logs. */
export async function confirmSlurmSpackWorkerStopped(
  stagingPath: string,
  expected: {
    manifestDigest: string;
    siteProfileDigest: string;
    storePath: string;
    action?: "install" | "verify" | "verify-partial";
  },
  transport: SpackAuditProcess = realSpackAuditProcess,
  binDir = "/usr/bin",
): Promise<SpackWorkerStopProof> {
  const uncertain = () =>
    new SpackWorkerUncertainError(
      "Spack Slurm recovery requires a uniquely identified terminal scheduler job; retain the writer lock and retry reconciliation after accounting catches up",
    );
  if (!/^\/[A-Za-z0-9_./-]+$/.test(binDir) || binDir.split("/").includes("..")) throw uncertain();
  for (const path of [stagingPath, join(stagingPath, "input")]) {
    const entry = await lstat(path);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o077) !== 0
    )
      throw uncertain();
  }
  async function privateJson(path: string): Promise<unknown> {
    const entry = await lstat(path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o077) !== 0 ||
      entry.size > 2 * 1024 ** 2
    )
      throw uncertain();
    return JSON.parse(await readFile(path, "utf8"));
  }
  const request = (await privateJson(join(stagingPath, "input/request.json"))) as Record<
    string,
    unknown
  >;
  if (
    !["install", "verify", "verify-partial"].includes(String(request.action)) ||
    Object.entries(expected).some(([key, value]) => request[key] !== value)
  )
    throw uncertain();
  const journal = (await privateJson(join(stagingPath, "slurm.json"))) as Record<string, unknown>;
  if (
    typeof journal.name !== "string" ||
    !/^kq-build-[a-f0-9-]{36}$/.test(journal.name) ||
    typeof journal.binding !== "string" ||
    !/^[a-f0-9]{64}$/.test(journal.binding)
  )
    throw uncertain();
  const control = (argv: string[]) =>
    transport.run(argv, {
      cwd: stagingPath,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      timeoutMs: 30_000,
      maxOutputBytes: 65536,
    });
  const query = async (argv: string[]) => {
    const result = await control(argv);
    if (result.exitCode !== 0) throw uncertain();
    return result.stdout;
  };
  const queue = await query([
    join(binDir, "squeue"),
    "--noheader",
    "--name",
    journal.name,
    "--format=%i|%j",
  ]);
  if (queue.trim()) throw uncertain();
  if (journal.jobId !== undefined) {
    if (typeof journal.jobId !== "string" || !/^\d+$/.test(journal.jobId)) throw uncertain();
    let current: ReturnType<typeof controllerStatus>;
    try {
      current = controllerStatus(
        await control([join(binDir, "scontrol"), "show", "job", "-o", journal.jobId]),
        journal.jobId,
        journal.name,
      );
    } catch {
      throw uncertain();
    }
    if (current) {
      if (!terminal.has(current.phase)) throw uncertain();
      return SpackWorkerStopProofSchema.parse({
        schedulerJobId: journal.jobId,
        schedulerJobName: journal.name,
        schedulerBinding: journal.binding,
        noRequeue: true,
        schedulerState: current.phase,
        manifestDigest: request.manifestDigest,
        siteProfileDigest: request.siteProfileDigest,
        storePath: request.storePath,
        action: request.action,
        stoppedAt: new Date().toISOString(),
      });
    }
  }
  const accounting = await query([
    join(binDir, "sacct"),
    "-n",
    "-P",
    "-X",
    "--name",
    journal.name,
    "--format=JobIDRaw,JobName%100,State%64,ExitCode",
  ]);
  const rows = accounting
    .split("\n")
    .map((line) => line.trim().split("|"))
    .filter((row) => row[1] === journal.name);
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    !/^\d+$/.test(row[0] ?? "") ||
    (journal.jobId && journal.jobId !== row[0]) ||
    !terminal.has(row[2]?.split(/[ +]/)[0] ?? "") ||
    !/^\d+:\d+$/.test(row[3] ?? "")
  )
    throw uncertain();
  // Purged controller records cannot prove legacy jobs were submitted without requeue.
  if (journal.noRequeue !== true) throw uncertain();
  return SpackWorkerStopProofSchema.parse({
    schedulerJobId: row[0],
    schedulerJobName: journal.name,
    schedulerBinding: journal.binding,
    noRequeue: true,
    schedulerState: row[2]?.split(/[ +]/)[0],
    manifestDigest: request.manifestDigest,
    siteProfileDigest: request.siteProfileDigest,
    storePath: request.storePath,
    action: request.action,
    stoppedAt: new Date().toISOString(),
  });
}
