// kq logs <jobId> [--follow] [--lines <n>]
//
// Default: prints the last N lines of a job's stdout/stderr via the Server
// `GET /api/jobs/:id/logs?text=1` endpoint.
// `--follow` switches to SSE streaming `GET /api/jobs/:id/logs/stream`;
// when the Server doesn't support SSE yet, falls back to polling with a
// clear warning.

import type { Command } from "commander";
import { ApiClient, ApiError } from "../lib/api-client";
import { loadCliConfig } from "../lib/config";
import {
  detectLocalAdapter,
  localSchedulerErrorMessage,
  parseScheduler,
  withLocalSchedulerOptions,
} from "../lib/local-scheduler";
import { SseClient } from "../lib/sse-client";

interface LogsResp {
  text: string;
}

function unavailableLogMessage(): string {
  return "Job log output is not available yet or has been cleaned.";
}

export function registerLogsCommand(program: Command): void {
  withLocalSchedulerOptions(
    program
      .command("logs <jobId>")
      .description("Print job stdout/stderr; --follow streams new lines")
      .option("--follow", "Stream new log lines (SSE)", false)
      .option("--lines <n>", "Tail N lines on first fetch", "200"),
    "All-in-one mode: tail the local scheduler's job log, no Server",
  ).action(
    async (
      jobId: string,
      opts: { follow: boolean; lines: string; local?: boolean; scheduler?: string },
    ) => {
      const lines = Number.parseInt(opts.lines, 10);
      if (!Number.isInteger(lines) || lines <= 0) {
        console.error("--lines must be a positive integer");
        process.exit(1);
      }
      if (opts.local) {
        await runLocalLogs(jobId, lines, opts);
        return;
      }
      await runRemoteLogs(jobId, lines, opts.follow);
    },
  );
}

/** Tail a local scheduler job's output for the all-in-one binary (no Server).
 *  Live follow needs the Server's stream, so in local mode we point users at the
 *  TUI's poll-based follow rather than ship an imprecise tail-window stream. */
async function runLocalLogs(
  jobId: string,
  lines: number,
  opts: { follow: boolean; scheduler?: string },
): Promise<void> {
  // Validate --scheduler before the catch so a bad value reports "Unknown
  // scheduler …" cleanly, not dressed up as a missing-scheduler-CLI failure.
  const scheduler = opts.scheduler ? parseScheduler(opts.scheduler) : undefined;
  try {
    const adapter = await detectLocalAdapter(scheduler);
    if (!adapter.getJobLogs) {
      throw new Error(`Log viewing is not supported on ${adapter.type}.`);
    }
    const text = await adapter.getJobLogs(jobId, lines);
    if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    if (opts.follow) {
      console.error(
        "[kq logs] live --follow needs a Server; for local live logs run `kq tui --local`, open the job, and press f.",
      );
    }
  } catch (err) {
    console.error(localSchedulerErrorMessage("logs", err));
    process.exit(1);
  }
}

async function runRemoteLogs(jobId: string, lines: number, followFlag: boolean): Promise<void> {
  const config = loadCliConfig();
  if (followFlag) {
    await follow(
      config.serverUrl,
      config.token,
      jobId,
      (chunk) => process.stdout.write(chunk),
      lines,
    );
    return;
  }
  const client = ApiClient.fromConfig(config);
  try {
    const initial = await client.get<LogsResp>(`/jobs/${jobId}/logs?text=1&lines=${lines}`);
    if (initial.text) process.stdout.write(initial.text);
  } catch (err) {
    if (err instanceof ApiError && err.code === "JOB_LOG_UNAVAILABLE") {
      throw new Error(unavailableLogMessage());
    }
    if (err instanceof ApiError && err.status === 404) {
      console.error(`job ${jobId} not found`);
      process.exit(2);
    }
    throw err;
  }
}

export async function follow(
  baseUrl: string,
  token: string | undefined,
  jobId: string,
  onChunk: (s: string) => void,
  lines = 200,
): Promise<void> {
  const sse = new SseClient(
    `${baseUrl}/api/jobs/${jobId}/logs/stream?lines=${encodeURIComponent(lines)}`,
    token,
  );
  try {
    for await (const ev of sse.events()) {
      if (ev.event === "log" && ev.data) onChunk(ev.data);
      if (ev.event === "end") return;
      if (ev.event === "error") throw new Error(ev.data || "Job logs stream failed");
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === "JOB_LOG_UNAVAILABLE") {
      throw new Error(unavailableLogMessage());
    }
    if (err instanceof ApiError && err.status === 404) {
      console.error("[kq logs] streaming endpoint not available on Server; polling fallback");
      await pollFallback(baseUrl, token, jobId, onChunk);
      return;
    }
    throw err;
  }
}

async function pollFallback(
  baseUrl: string,
  token: string | undefined,
  jobId: string,
  onChunk: (s: string) => void,
): Promise<void> {
  const client = new ApiClient(baseUrl, token);
  let lastLen = 0;
  let backoff = 1000;
  for (;;) {
    try {
      const r = await client.get<LogsResp>(`/jobs/${jobId}/logs?text=1`);
      if (r.text.length > lastLen) {
        onChunk(r.text.slice(lastLen));
        lastLen = r.text.length;
        backoff = 1000;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return;
      backoff = Math.min(backoff * 2, 30_000);
    }
    await new Promise((r) => setTimeout(r, backoff));
  }
}
