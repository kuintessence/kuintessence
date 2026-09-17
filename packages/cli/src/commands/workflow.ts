import { readFileSync } from "node:fs";
import type { StepJobs, WorkflowRunGraph } from "@kuintessence/shared";
import type { Command } from "commander";
import { ApiClient } from "../lib/api-client";
import { loadCliConfig } from "../lib/config";

/** Synchronous debug result from `/api/workflows/run`. */
export interface RunResult {
  /** Present when the Server persisted the run (audit/listing). */
  runId?: string;
  status: Record<string, string>;
  values: Record<string, { status: string; values: Record<string, unknown> }>;
}

export interface WorkflowSubmitResult {
  runId: string;
  name?: string;
  status: string;
}

/** Submit a control-flow workflow YAML and return the async run handle.
 *  Exported so tests can drive it without the Commander parser. */
export async function submitWorkflow(
  client: ApiClient,
  yaml: string,
): Promise<WorkflowSubmitResult> {
  return client.post<WorkflowSubmitResult>("/workflows", { yaml });
}

export async function cancelWorkflow(
  client: ApiClient,
  runId: string,
): Promise<WorkflowSubmitResult> {
  return client.post<WorkflowSubmitResult>(`/workflows/${runId}/cancel`, {});
}

interface WorkflowRunRow {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

interface WorkflowRunDetail extends WorkflowRunRow {
  description: string | null;
  graph?: WorkflowRunGraph | null;
  stepJobs?: StepJobs;
  /** Per-node result, when available; active runs may not have one yet. */
  result?: RunResult | null;
}

/** Render node results, or graph-backed job associations while results are unavailable. */
export function formatRunDetail(r: WorkflowRunDetail): string[] {
  const lines = [
    `Workflow: ${r.name} (${r.id})`,
    `Status: ${r.status}`,
    `Description: ${r.description ?? "-"}`,
  ];
  if (r.result) {
    lines.push("Nodes:");
    for (const [nodeId, status] of Object.entries(r.result.status)) {
      const values = r.result.values[nodeId]?.values ?? {};
      const valueStr = Object.keys(values).length > 0 ? `  ${JSON.stringify(values)}` : "";
      lines.push(`  - ${nodeId}: ${status}${valueStr}`);
    }
  } else if (r.graph?.nodes.length) {
    lines.push("Nodes:");
    for (const node of r.graph.nodes) {
      const jobId = r.stepJobs?.[node.id];
      // A job association does not establish the node's execution status.
      lines.push(`  - ${node.id}: unknown${jobId ? `  job ${jobId}` : ""}`);
    }
  }
  return lines;
}

/**
 * Register the `kq workflow` subcommand group.
 *
 * Usage:
 *   kq workflow submit <yaml-file>
 *   kq workflow list
 *   kq workflow status <runId>
 */
export function registerWorkflowCommand(program: Command): void {
  const wf = program.command("workflow").description("Workflow operations");

  wf.command("submit <file>")
    .description("Submit a control-flow workflow from a YAML file")
    .action(async (file: string) => {
      const config = loadCliConfig();
      const yamlContent = readFileSync(file, "utf-8");
      const client = ApiClient.fromConfig(config);
      const r = await submitWorkflow(client, yamlContent);
      console.log(`Run ID: ${r.runId}`);
      console.log(`Status: ${r.status}`);
    });

  wf.command("list")
    .description("List recent workflow runs")
    .action(async () => {
      const config = loadCliConfig();
      const client = ApiClient.fromConfig(config);
      const r = await client.get<{ runs: WorkflowRunRow[] }>("/workflows");
      if (r.runs.length === 0) {
        console.log("No workflow runs yet.");
        return;
      }
      console.log("RUN_ID\tNAME\tSTATUS\tCREATED");
      for (const run of r.runs) {
        console.log(`${run.id}\t${run.name}\t${run.status}\t${run.createdAt}`);
      }
    });

  wf.command("status <runId>")
    .description("Get workflow run detail")
    .action(async (runId: string) => {
      const config = loadCliConfig();
      const client = ApiClient.fromConfig(config);
      const r = await client.get<WorkflowRunDetail>(`/workflows/${runId}`);
      console.log(formatRunDetail(r).join("\n"));
    });

  wf.command("cancel <runId>")
    .description("Cancel a workflow run")
    .action(async (runId: string) => {
      const config = loadCliConfig();
      const client = ApiClient.fromConfig(config);
      const r = await cancelWorkflow(client, runId);
      console.log(`Run ID: ${r.runId}`);
      console.log(`Status: ${r.status}`);
    });
}
