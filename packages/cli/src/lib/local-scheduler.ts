import {
  type DetectOptions,
  detectScheduler,
  type JobSpec,
  type SchedulerAdapter,
} from "@kuintessence/agent/adapters";
import type { Command } from "commander";

export type SchedulerType = NonNullable<DetectOptions["forceType"]>;

const SCHEDULERS: readonly SchedulerType[] = ["slurm", "pbs-pro", "torque", "kubernetes"];

const SCHEDULER_OPTION_DESC =
  "Force the scheduler type in local mode (slurm|pbs-pro|torque|kubernetes)";

/** Register the shared `--local` / `--scheduler` options on a local-capable
 *  command. `localDescription` is the per-command help text for `--local`
 *  (it varies: "query"/"tail"/"list"/…); the `--scheduler` flag + description
 *  are shared. Returns the command for chaining. */
export function withLocalSchedulerOptions(cmd: Command, localDescription: string): Command {
  return cmd
    .option("--local", localDescription)
    .option("--scheduler <type>", SCHEDULER_OPTION_DESC);
}

/** Validate a `--scheduler` value against the supported scheduler types. Shared
 *  by the local-mode (`--local`) CLI commands. Pure + exported for testing. */
export function parseScheduler(value: string): SchedulerType {
  const match = SCHEDULERS.find((s) => s === value);
  if (!match) {
    throw new Error(`Unknown scheduler "${value}". Expected one of: ${SCHEDULERS.join(", ")}`);
  }
  return match;
}

/** Format a local-mode command failure as a clean one/two-liner (never a stack
 *  trace): a detection miss or scheduler-CLI error gets a hint to install a
 *  scheduler CLI or run against a Server. Shared by `--local` commands. Pure +
 *  exported for testing. */
/**
 * One-line, stack-trace-free hint for a local-scheduler failure. `alternative`
 * overrides the trailing fallback clause: dual-mode commands (status/list/…)
 * default to "run … against a Server (without --local)", but always-local serve
 * commands (`gui serve`, `agent serve`) have no `--local` flag and must pass a
 * fitting alternative so the message never references a flag that doesn't exist.
 */
export function localSchedulerErrorMessage(
  command: string,
  err: unknown,
  alternative?: string,
): string {
  const msg = err instanceof Error ? err.message : String(err);
  const fallback = alternative ?? `or run \`kq ${command}\` against a Server (without --local)`;
  return `kq ${command} (local): ${msg}\nEnsure a scheduler CLI (sbatch / qsub / kubectl) is on PATH and reachable, ${fallback}.`;
}

/** Parse + validate raw spec-file contents into an agent JobSpec. Required:
 *  string `name`/`command`, numeric `cpus`/`memoryMb`. Optional fields default
 *  (gpus/wallTimeSec 0, workingDir "", envVars {}, jobId generated). Throws a
 *  clear message on invalid input. `envVars` values are coerced to strings
 *  (process env is string→string), so `{"EPOCHS":10}` becomes `{"EPOCHS":"10"}`
 *  rather than smuggling a non-string into `Record<string,string>`. Shared by
 *  the TUI's local submit and `kq submit --local`. Pure + exported for testing. */
export function parseJobSpec(raw: string): JobSpec {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Spec file is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const name = obj.name;
  const command = obj.command;
  const cpus = obj.cpus;
  const memoryMb = obj.memoryMb;
  if (typeof name !== "string" || typeof command !== "string") {
    throw new Error("Spec must include string 'name' and 'command'");
  }
  if (typeof cpus !== "number" || typeof memoryMb !== "number") {
    throw new Error("Spec must include numeric 'cpus' and 'memoryMb'");
  }
  return {
    jobId: typeof obj.jobId === "string" ? obj.jobId : crypto.randomUUID(),
    name,
    command,
    cpus,
    memoryMb,
    gpus: typeof obj.gpus === "number" ? obj.gpus : 0,
    wallTimeSec: typeof obj.wallTimeSec === "number" ? obj.wallTimeSec : 0,
    workingDir: typeof obj.workingDir === "string" ? obj.workingDir : "",
    envVars:
      obj.envVars && typeof obj.envVars === "object"
        ? Object.fromEntries(
            Object.entries(obj.envVars as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : {},
  };
}

/** Detect the local scheduler (or honour an explicit type) for the all-in-one
 *  binary on an HPC login node. Throws (caught by the command's error handler)
 *  when no supported scheduler is found. */
export function detectLocalAdapter(scheduler?: SchedulerType): Promise<SchedulerAdapter> {
  return detectScheduler(scheduler ? { forceType: scheduler } : {});
}
