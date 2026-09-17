// `kq dsl schema` subcommand.
//
// Fetches the workflow DSL JSON Schema the Server serves at
// `/api/dsl/schema/workflow` and either writes it to a file or prints
// it to stdout. CI lint pipelines that don't speak HTTP should pin a copy
// via this command so the lint step stays offline-deterministic.
//
// We deliberately bypass `ApiClient.get` because that helper assumes a
// JSON envelope `{ data, error }` — the schema endpoint returns the raw
// JSON Schema document so external tools can hand it straight to Ajv.

import { readFileSync, writeFileSync } from "node:fs";
import { workflowDsl } from "@kuintessence/shared";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { loadCliConfig } from "../lib/config";

/**
 * Validate a control-flow workflow document offline (no Server): parse the
 * YAML, check it against the shared `WorkflowSchema`, then run the cross-field
 * static checks. Returns a list of human-readable problems (empty = valid).
 * Mirrors the Server's `parseWorkflowYaml` ingestion path so `kq dsl validate`
 * gives the same verdict the Server would. Pure + exported for testing.
 */
export function validateWorkflowYaml(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    return [`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`];
  }
  const result = workflowDsl.WorkflowSchema.safeParse(parsed);
  if (!result.success) {
    return result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  return workflowDsl.validateWorkflow(result.data);
}

/**
 * Fetch the control-flow workflow DSL JSON Schema from the configured Server.
 * Exported separately from the action handler so tests can drive it without
 * spawning the full Commander parser.
 */
export async function fetchWorkflowDslSchema(serverUrl: string): Promise<string> {
  const url = `${serverUrl}/api/dsl/schema/workflow`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Server returned ${res.status} ${res.statusText} for ${url}`);
  }
  return res.text();
}

/**
 * Register the `kq dsl` subcommand group.
 *
 * Usage:
 *   kq dsl schema           # prints to stdout
 *   kq dsl schema --output schema.json
 */
export function registerDslCommand(program: Command): void {
  const d = program.command("dsl").description("Workflow DSL helpers");

  d.command("schema")
    .description("Fetch the workflow DSL JSON Schema served by the Server")
    .option("-o, --output <path>", "Write schema to a file instead of stdout")
    .action(async (opts: { output?: string }) => {
      const config = loadCliConfig();
      const body = await fetchWorkflowDslSchema(config.serverUrl);
      if (opts.output) {
        writeFileSync(opts.output, body, "utf-8");
        console.log(`Wrote DSL schema to ${opts.output}`);
        return;
      }
      // stdout — pretty-print so a human eyeballing the output sees the
      // structure, while machine consumers can still pipe through `jq`.
      const parsed: unknown = JSON.parse(body);
      console.log(JSON.stringify(parsed, null, 2));
    });

  d.command("validate <file>")
    .description("Validate a workflow YAML offline (no Server)")
    .action((file: string) => {
      const errors = validateWorkflowYaml(readFileSync(file, "utf-8"));
      if (errors.length === 0) {
        console.log(`✓ ${file} is a valid workflow`);
        return;
      }
      console.error(`✗ ${file} is not a valid workflow:`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    });
}
