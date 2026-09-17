import type { JobStatusResult } from "@kuintessence/agent/adapters";
import type { Command } from "commander";
import { ApiClient } from "../lib/api-client";
import { loadCliConfig } from "../lib/config";
import {
  detectLocalAdapter,
  localSchedulerErrorMessage,
  parseScheduler,
  withLocalSchedulerOptions,
} from "../lib/local-scheduler";

interface JobDetail {
  id: string;
  name: string;
  status: string;
  schedulerJobId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  exitCode?: number | null;
}

/** Render a local scheduler-status snapshot for `kq status --local`. Only the
 *  fields the scheduler reports are shown. Pure + exported for testing. */
export function formatLocalStatus(jobId: string, result: JobStatusResult): string {
  const lines = [`Job ${jobId}`, `Status: ${result.status}`];
  if (result.node) lines.push(`Node: ${result.node}`);
  if (result.startedAt) lines.push(`Started: ${result.startedAt}`);
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  if (result.exitCode !== undefined) lines.push(`Exit code: ${result.exitCode}`);
  if (result.message) lines.push(result.message);
  return lines.join("\n");
}

export function registerStatusCommand(program: Command): void {
  withLocalSchedulerOptions(
    program.command("status <jobId>").description("Get job status"),
    "All-in-one mode: query the local scheduler directly, no Server",
  ).action(async (jobId: string, opts: { local?: boolean; scheduler?: string }) => {
    if (opts.local) {
      // Validate --scheduler before the catch so a bad value reports "Unknown
      // scheduler …" cleanly, not dressed up as a missing-scheduler-CLI failure.
      const scheduler = opts.scheduler ? parseScheduler(opts.scheduler) : undefined;
      try {
        const adapter = await detectLocalAdapter(scheduler);
        console.log(formatLocalStatus(jobId, await adapter.status(jobId)));
      } catch (err) {
        console.error(localSchedulerErrorMessage("status", err));
        process.exit(1);
      }
      return;
    }
    const config = loadCliConfig();
    const client = ApiClient.fromConfig(config);
    const job = await client.get<JobDetail>(`/jobs/${jobId}`);
    console.log(`Job: ${job.name} (${job.id})`);
    console.log(`Status: ${job.status}`);
    if (job.schedulerJobId) console.log(`Scheduler ID: ${job.schedulerJobId}`);
    if (job.startedAt) console.log(`Started: ${job.startedAt}`);
    if (job.completedAt) console.log(`Completed: ${job.completedAt}`);
    if (job.exitCode !== null && job.exitCode !== undefined) {
      console.log(`Exit code: ${job.exitCode}`);
    }
  });
}
