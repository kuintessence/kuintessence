import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { ApiClient } from "../lib/api-client";
import { loadCliConfig } from "../lib/config";
import {
  detectLocalAdapter,
  localSchedulerErrorMessage,
  parseJobSpec,
  parseScheduler,
  withLocalSchedulerOptions,
} from "../lib/local-scheduler";

interface JobResponse {
  id: string;
  name: string;
  status: string;
}

export function registerSubmitCommand(program: Command): void {
  withLocalSchedulerOptions(
    program.command("submit <file>").description("Submit a job from a JSON file"),
    "All-in-one mode: submit directly to the local scheduler, no Server",
  ).action(async (file: string, opts: { local?: boolean; scheduler?: string }) => {
    if (opts.local) {
      // Validate --scheduler before the catch so a bad value reports "Unknown
      // scheduler …" cleanly, not dressed up as a missing-scheduler-CLI failure.
      const scheduler = opts.scheduler ? parseScheduler(opts.scheduler) : undefined;
      try {
        // Read inside the local handler so a missing/unreadable spec file
        // gets the same friendly hint as a detection/scheduler failure.
        const spec = parseJobSpec(readFileSync(file, "utf-8"));
        const adapter = await detectLocalAdapter(scheduler);
        const result = await adapter.submit(spec);
        console.log(`Job submitted: ${result.schedulerJobId}`);
        console.log(`Name: ${spec.name}`);
        console.log("Status: queued");
      } catch (err) {
        console.error(localSchedulerErrorMessage("submit", err));
        process.exit(1);
      }
      return;
    }
    const config = loadCliConfig();
    const jobSpec = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    const client = ApiClient.fromConfig(config);
    const job = await client.post<JobResponse>("/jobs", jobSpec);
    console.log(`Job submitted: ${job.id}`);
    console.log(`Name: ${job.name}`);
    console.log(`Status: ${job.status}`);
  });
}
