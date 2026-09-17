import type { Command } from "commander";
import { ApiClient } from "../lib/api-client";
import { loadCliConfig } from "../lib/config";
import {
  detectLocalAdapter,
  localSchedulerErrorMessage,
  parseScheduler,
  withLocalSchedulerOptions,
} from "../lib/local-scheduler";

interface JobResponse {
  id: string;
  status: string;
}

export function registerCancelCommand(program: Command): void {
  withLocalSchedulerOptions(
    program.command("cancel <jobId>").description("Cancel a job"),
    "All-in-one mode: cancel directly on the local scheduler, no Server",
  ).action(async (jobId: string, opts: { local?: boolean; scheduler?: string }) => {
    if (opts.local) {
      // Validate --scheduler before the catch so a bad value reports "Unknown
      // scheduler …" cleanly, not dressed up as a missing-scheduler-CLI failure.
      const scheduler = opts.scheduler ? parseScheduler(opts.scheduler) : undefined;
      try {
        const adapter = await detectLocalAdapter(scheduler);
        await adapter.cancel(jobId);
        console.log(`Job ${jobId} cancelled on ${adapter.type}.`);
      } catch (err) {
        console.error(localSchedulerErrorMessage("cancel", err));
        process.exit(1);
      }
      return;
    }
    const config = loadCliConfig();
    const client = ApiClient.fromConfig(config);
    const job = await client.post<JobResponse>(`/jobs/${jobId}/cancel`, {});
    console.log(`Job ${job.id} status: ${job.status}`);
  });
}
