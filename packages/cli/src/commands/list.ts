import type { Command } from "commander";
import { ApiClient } from "../lib/api-client";
import { loadCliConfig } from "../lib/config";
import {
  detectLocalAdapter,
  localSchedulerErrorMessage,
  parseScheduler,
  type SchedulerType,
  withLocalSchedulerOptions,
} from "../lib/local-scheduler";

interface JobListItem {
  id: string;
  name: string;
  status: string;
  submittedAt: string;
}

interface JobsList {
  jobs: JobListItem[];
}

interface JobRow {
  id: string;
  name: string;
  status: string;
  submittedAt?: string;
}

/** Render the jobs table: a header line plus one tab-separated row per job. A
 *  missing submit time shows as "—". Empty input yields a distinct notice. Pure
 *  + exported for testing. */
export function formatJobRows(rows: JobRow[]): string {
  if (rows.length === 0) return "No jobs found.";
  const lines = ["ID\tNAME\tSTATUS\tSUBMITTED"];
  for (const r of rows) {
    lines.push(`${r.id}\t${r.name}\t${r.status}\t${r.submittedAt ?? "—"}`);
  }
  return lines.join("\n");
}

/** Scenario 2: list the local scheduler's jobs directly, no Server — for the
 *  all-in-one binary on an HPC login node. Detects the scheduler (or honours
 *  `--scheduler`) and reads its queue via the agent adapter. */
async function listLocalJobs(scheduler?: SchedulerType): Promise<JobRow[]> {
  const adapter = await detectLocalAdapter(scheduler);
  if (!adapter.listJobs) {
    throw new Error(`Job listing is not supported on ${adapter.type}.`);
  }
  const jobs = await adapter.listJobs();
  return jobs.map((j) => ({
    id: j.schedulerJobId,
    name: j.name,
    status: j.status,
    submittedAt: j.submittedAt,
  }));
}

export function registerListCommand(program: Command): void {
  withLocalSchedulerOptions(
    program.command("list").description("List recent jobs"),
    "All-in-one mode: list the local scheduler's jobs directly, no Server",
  ).action(async (opts: { local?: boolean; scheduler?: string }) => {
    if (opts.local) {
      // Validate --scheduler before the catch so a bad value reports "Unknown
      // scheduler …" cleanly, not dressed up as a missing-scheduler-CLI failure.
      const scheduler = opts.scheduler ? parseScheduler(opts.scheduler) : undefined;
      try {
        const rows = await listLocalJobs(scheduler);
        console.log(formatJobRows(rows));
      } catch (err) {
        console.error(localSchedulerErrorMessage("list", err));
        process.exit(1);
      }
      return;
    }
    const config = loadCliConfig();
    const client = ApiClient.fromConfig(config);
    const result = await client.get<JobsList>("/jobs");
    console.log(formatJobRows(result.jobs));
  });
}
