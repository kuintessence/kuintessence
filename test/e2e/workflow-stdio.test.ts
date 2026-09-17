import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { eq, inArray } from "drizzle-orm";
import { createPgDb, jobs, type PgDb, usecasePackages } from "../../packages/db/src";
import type { usecase } from "../../packages/shared/src";
import { governedShellPackage, seedE2eSoftwareRevision } from "./fixtures/governed-package";
import { type Stack, startStack } from "./fixtures/stack";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const BASH_STDIN_STDOUT_PKG_ID = "33333333-3333-4333-8333-333333333101";
const SOFTWARE_ID = "33333333-3333-4333-8333-333333333201";
const PACKAGE_IDS = [BASH_STDIN_STDOUT_PKG_ID];

let stack: Stack;
let db: PgDb;
let cliConfigDir: string;
let cliConfigFile: string;
const workflowDirs: string[] = [];

beforeAll(async () => {
  stack = await startStack();
  db = createPgDb(stack.databaseUrl);
  await seedPackages(db);
  cliConfigDir = mkdtempSync(join(tmpdir(), "kq-stdio-cli-e2e-"));
  cliConfigFile = join(cliConfigDir, "config.json");
  writeFileSync(
    cliConfigFile,
    JSON.stringify({ serverUrl: stack.serverBaseUrl, token: stack.adminToken }),
  );
}, 300_000);

afterAll(async () => {
  await stack?.stop();
  if (cliConfigDir) {
    rmSync(cliConfigDir, { recursive: true, force: true });
  }
  for (const dir of workflowDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("e2e: workflow stdin/stdout through CLI + Server + Agent + Slurm", () => {
  test("feeds text stdin into bash and extracts a value from captured stdout", async () => {
    const yamlPath = writeWorkflowYaml(stdinStdoutWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.stepJobs.sum).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.status.sum).toBe("Succeeded");
    expect(final.result?.values.sum?.values.sum).toBe(6);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("sum: Succeeded");
    expect(status.stdout).toContain('"sum":6');
  }, 180_000);

  test("keeps a completed job successful when scheduler stdout capture fails", async () => {
    const yamlPath = writeWorkflowYaml(stdoutCaptureFailureWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.stepJobs.no_stdout).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.status.no_stdout).toBe("Succeeded");
    expect(final.result?.values.no_stdout?.values.sum).toBe(0);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("no_stdout: Succeeded");
    expect(status.stdout).toContain('"sum":0');
  }, 180_000);

  test("fails the workflow when stdout extraction misses with onMissing=Fail", async () => {
    const yamlPath = writeWorkflowYaml(stdoutRegexMissWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.stepJobs.regex_miss).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.status.regex_miss).toBe("Failed");
    expect(final.result?.values.regex_miss?.values).toEqual({});

    const stepJobId = final.stepJobs.regex_miss;
    const [job] = await db
      .select({ status: jobs.status, schedulerJobId: jobs.schedulerJobId })
      .from(jobs)
      .where(eq(jobs.id, stepJobId))
      .limit(1);
    expect(job?.status).toBe("completed");
    expect(job?.schedulerJobId).toMatch(/^[0-9]+$/);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("regex_miss: Failed");
  }, 180_000);
});

async function seedPackages(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(usecasePackages).where(inArray(usecasePackages.id, PACKAGE_IDS));
  await seedE2eSoftwareRevision(dbHandle, SOFTWARE_ID);
  await dbHandle.insert(usecasePackages).values([
    {
      id: BASH_STDIN_STDOUT_PKG_ID,
      name: "mock-bash-io-stdin",
      version: "1",
      spec: bashStdinPackage(),
    },
  ]);
}

function bashStdinPackage(): usecase.UsecasePackage {
  return governedShellPackage({
    usecase: {
      commandFile: "bash",
      inputSlots: [
        {
          kind: "Text",
          descriptor: "script",
          refMaterials: [{ kind: "ArgRef", descriptor: "script", sort: 0 }],
        },
        {
          kind: "Text",
          descriptor: "stdin",
          refMaterials: [{ kind: "StdinRef", descriptor: "stdin" }],
        },
      ],
    },
    software: { kind: "Bare" },
    arguments: [{ descriptor: "script", valueFormat: "-lc {}" }],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [
      {
        descriptor: "sum",
        type: "int",
        from: { collectedOutDescriptor: "stdout" },
        extract: { kind: "Regex", pattern: "sum=([0-9]+)", group: 1 },
      },
    ],
  });
}

function stdinStdoutWorkflow(): string {
  return JSON.stringify(
    {
      name: "stdin_stdout_e2e",
      description: "Mock stdio workflow e2e.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "sum",
            name: "sum",
            usecaseVersionId: BASH_STDIN_STDOUT_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: {
                  expr: celString('awk "{s+=\\$1} END {printf \\"sum=%d\\\\n\\", s}"'),
                },
              },
              {
                type: "Text",
                descriptor: "stdin",
                from: { expr: "'1\n2\n3\n'" },
              },
            ],
          },
        ],
        nodeRelations: [],
      },
    },
    null,
    2,
  );
}

function stdoutCaptureFailureWorkflow(): string {
  return JSON.stringify(
    {
      name: "stdout_capture_failure_e2e",
      description: "A completed job whose scheduler stdout file disappears before collection.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "no_stdout",
            name: "no_stdout",
            usecaseVersionId: BASH_STDIN_STDOUT_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: {
                  expr: celString(
                    'printf "sum=9\\n"; out=$(scontrol show job "$SLURM_JOB_ID" -o | sed -n "s/.*StdOut=\\([^ ]*\\).*/\\1/p"); rm -f "$out"',
                  ),
                },
              },
              {
                type: "Text",
                descriptor: "stdin",
                from: { expr: "''" },
              },
            ],
            valueOutputsOverride: [
              {
                descriptor: "sum",
                type: "int",
                from: { collectedOutDescriptor: "stdout" },
                extract: { kind: "Regex", pattern: "sum=([0-9]+)", group: 1 },
                onMissing: "Default",
                default: 0,
              },
            ],
          },
        ],
        nodeRelations: [],
      },
    },
    null,
    2,
  );
}

function stdoutRegexMissWorkflow(): string {
  return JSON.stringify(
    {
      name: "stdout_regex_miss_e2e",
      description: "A completed job whose stdout exists but does not match a required extractor.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "regex_miss",
            name: "regex_miss",
            usecaseVersionId: BASH_STDIN_STDOUT_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString('printf "total=6\\n"') },
              },
              {
                type: "Text",
                descriptor: "stdin",
                from: { expr: "''" },
              },
            ],
            valueOutputsOverride: [
              {
                descriptor: "sum",
                type: "int",
                from: { collectedOutDescriptor: "stdout" },
                extract: { kind: "Regex", pattern: "sum=([0-9]+)", group: 1 },
                onMissing: "Fail",
              },
            ],
          },
        ],
        nodeRelations: [],
      },
    },
    null,
    2,
  );
}

function celString(value: string): string {
  if (value.includes("'")) {
    throw new Error("test CEL strings must not contain single quotes");
  }
  return `'${value}'`;
}

function writeWorkflowYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kq-stdio-workflow-"));
  workflowDirs.push(dir);
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, content);
  return path;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = spawn(["bun", "run", join(REPO_ROOT, "packages/cli/src/index.ts"), ...args], {
    env: { ...process.env, KQ_CONFIG_FILE: cliConfigFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`kq ${args.join(" ")} failed with exit ${exitCode}\n${stdout}\n${stderr}`);
  }
  return { stdout, stderr };
}

function parseRunId(stdout: string): string {
  const match = /Run ID: ([0-9a-f-]{36})/.exec(stdout);
  if (!match?.[1]) {
    throw new Error(`CLI output did not contain a run id:\n${stdout}`);
  }
  return match[1];
}

async function pollWorkflow(
  runId: string,
  expectedStatus: "completed" | "failed",
  timeoutMs: number,
): Promise<WorkflowRunDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowRunDetail | undefined;
  while (Date.now() < deadline) {
    last = await api<WorkflowRunDetail>(`/api/workflows/${runId}`, { method: "GET" });
    if (last.status === expectedStatus) {
      return last;
    }
    if (last.status === "completed" || last.status === "failed" || last.status === "cancelled") {
      throw new Error(`Workflow ${runId} ended with unexpected status: ${JSON.stringify(last)}`);
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Workflow ${runId} did not reach ${expectedStatus}: ${JSON.stringify(last)}`);
}

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${stack.adminToken}`);
  const res = await fetch(`${stack.serverBaseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface WorkflowRunDetail {
  id: string;
  status: string;
  stepJobs: Record<string, string>;
  result?: {
    status: Record<string, string>;
    values: Record<string, { status: string; values: Record<string, unknown> }>;
  } | null;
}
