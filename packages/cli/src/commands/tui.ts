import type { DetectOptions } from "@kuintessence/agent/adapters";
import { type Command, Option } from "commander";
import { withLocalSchedulerOptions } from "../lib/local-scheduler";
import { NotATtyError, runTui, runTuiRendererSmoke } from "../tui/run";
import { PANE_ORDER, type PaneId } from "../tui/store";

const SCHEDULERS: ReadonlyArray<NonNullable<DetectOptions["forceType"]>> = [
  "slurm",
  "pbs-pro",
  "torque",
  "kubernetes",
];

/** Validate a `--scheduler` value against the supported scheduler types. Pure +
 *  exported for testing, like {@link parsePane} / {@link parseInterval}. */
export function parseScheduler(value: string): NonNullable<DetectOptions["forceType"]> {
  const match = SCHEDULERS.find((s) => s === value);
  if (!match) {
    throw new Error(`Unknown scheduler "${value}". Expected one of: ${SCHEDULERS.join(", ")}`);
  }
  return match;
}

/** Validate a `--pane` value against the known pane ids. Pure + exported for
 *  testing. A pane disabled in the active mode is handled gracefully at
 *  startup (the TUI falls back to the first enabled pane). */
export function parsePane(value: string): PaneId {
  const match = PANE_ORDER.find((p) => p === value);
  if (!match) {
    throw new Error(`Unknown pane "${value}". Expected one of: ${PANE_ORDER.join(", ")}`);
  }
  return match;
}

/** Validate a `--interval` value (refresh cadence in seconds) and return it in
 *  milliseconds. Bounded to [1s, 3600s] to avoid hammering the Server or an
 *  effectively-frozen view. Pure + exported for testing. */
export function parseInterval(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    throw new Error(`Invalid --interval "${value}". Expected a number of seconds.`);
  }
  if (seconds < 1 || seconds > 3600) {
    throw new Error(`--interval must be between 1 and 3600 seconds (got ${value}).`);
  }
  return Math.round(seconds * 1000);
}

/**
 * Format a startup failure for the terminal — a clean one/two-liner, never a
 * stack trace. In local mode a detection failure gets a hint to install a
 * scheduler CLI or fall back to remote; remote failures hint at `--local`.
 * Pure + exported for testing.
 */
export function tuiStartupErrorMessage(err: unknown, opts: { local?: boolean }): string {
  if (err instanceof NotATtyError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  if (opts.local) {
    return `kq tui (local): ${msg}\nEnsure a scheduler CLI (sbatch / qsub / kubectl) is on PATH, or run \`kq tui\` against a Server (without --local).`;
  }
  return `kq tui: ${msg}\nIf this node has no Server, try \`kq tui --local\` to drive the local scheduler directly.`;
}

export function registerTuiCommand(program: Command): void {
  withLocalSchedulerOptions(
    program
      .command("tui")
      .description("Interactive terminal UI (k9s-style) for jobs, workflows, and agents"),
    "All-in-one mode: drive the local scheduler directly, no Server required",
  )
    .option("--pane <id>", "Open directly to a pane (jobs|workflows|agents|metrics|software)")
    .option("--interval <seconds>", "Refresh cadence in seconds (default 2; range 1–3600)")
    .option("--db <path>", "Local-mode SQLite job store path (default ~/.kuintessence/local.db)")
    .option("--no-db", "Local mode: don't persist jobs (ephemeral; default persists)")
    .option(
      "--agent-url <url>",
      "Drive a remote `kq agent serve` over HTTP (no Server); takes precedence over local/remote",
    )
    .option("--agent-token <token>", "Bearer token for --agent-url (defaults to KQ_AGENT_TOKEN)")
    .addOption(new Option("--renderer-smoke").hideHelp())
    .action(
      async (opts: {
        local?: boolean;
        scheduler?: string;
        pane?: string;
        interval?: string;
        db?: string | boolean;
        agentUrl?: string;
        agentToken?: string;
        rendererSmoke?: boolean;
      }) => {
        try {
          if (opts.rendererSmoke) {
            await runTuiRendererSmoke();
            return;
          }
          // Commander sets `db` to false for --no-db, or the string path for --db.
          const noDb = opts.db === false;
          const dbPath = typeof opts.db === "string" ? opts.db : undefined;
          await runTui({
            local: opts.local,
            scheduler: opts.scheduler ? parseScheduler(opts.scheduler) : undefined,
            initialPane: opts.pane ? parsePane(opts.pane) : undefined,
            pollMs: opts.interval ? parseInterval(opts.interval) : undefined,
            noDb,
            dbPath,
            agentUrl: opts.agentUrl,
            agentToken: opts.agentToken ?? process.env.KQ_AGENT_TOKEN,
          });
        } catch (err) {
          console.error(tuiStartupErrorMessage(err, { local: opts.local }));
          process.exit(1);
        }
      },
    );
}
