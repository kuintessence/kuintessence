import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { inArray } from "drizzle-orm";
import { createPgDb, type PgDb, usecasePackages } from "../../packages/db/src";
import type { usecase } from "../../packages/shared/src";
import { governedShellPackage, seedE2eSoftwareRevision } from "./fixtures/governed-package";
import { type Stack, startStack } from "./fixtures/stack";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const BASH_SLEEP_PKG_ID = "55555555-5555-4555-8555-555555555101";
const SOFTWARE_ID = "55555555-5555-4555-8555-555555555201";
const PACKAGE_IDS = [BASH_SLEEP_PKG_ID];

let stack: Stack;
let db: PgDb;
let cliConfigDir: string;
let cliConfigFile: string;
const workflowDirs: string[] = [];

beforeAll(async () => {
  stack = await startStack();
  db = createPgDb(stack.databaseUrl);
  await seedPackages(db);
  cliConfigDir = mkdtempSync(join(tmpdir(), "kq-resilience-cli-e2e-"));
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

describe("e2e: workflow cancellation through CLI + Server + Agent + Slurm", () => {
  test("cancels a running workflow and propagates cancellation to Slurm", async () => {
    const yamlPath = writeWorkflowYaml(sleepWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const job = await waitForNodeJob(runId, "sleepy", "running", 90_000);

    const cancel = await runCli(["workflow", "cancel", runId]);
    expect(cancel.stderr).toBe("");
    expect(cancel.stdout).toContain(`Run ID: ${runId}`);
    expect(cancel.stdout).toMatch(/Status: cancell(?:ed|ing)/);

    const final = await pollWorkflow(runId, "cancelled", 90_000);
    const cancelledJob = await api<JobDetail>(`/api/jobs/${job.id}`, { method: "GET" });
    const slurmState = await pollSlurmCancelled(job.schedulerJobId, 60_000);

    expect(final.status).toBe("cancelled");
    expect(final.stepJobs.sleepy).toBe(job.id);
    expect(cancelledJob.status).toBe("cancelled");
    expect(slurmState).toContain("JobState=CANCELLED");

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("Status: cancelled");
  }, 240_000);

  test("marks a running workflow interrupted after Server restart", async () => {
    const yamlPath = writeWorkflowYaml(sleepWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const job = await waitForNodeJob(runId, "sleepy", "running", 90_000);

    try {
      await stack.restartServer();
      const final = await pollWorkflow(runId, "failed", 90_000);

      expect(final.status).toBe("failed");
      expect(final.errorCode).toBe("WORKFLOW_INTERRUPTED");
      expect(final.stepJobs.sleepy).toBe(job.id);

      const status = await runCli(["workflow", "status", runId]);
      expect(status.stdout).toContain("Status: failed");
    } finally {
      if (job.schedulerJobId) {
        await stack.slurm.exec(["scancel", job.schedulerJobId]);
      }
    }
  }, 240_000);

  test("resumes polling a running scheduler job after Agent restart", async () => {
    const yamlPath = writeWorkflowYaml(sleepWorkflow("sleep 30"));

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const job = await waitForNodeJob(runId, "sleepy", "running", 90_000);

    try {
      await stack.restartAgent();
      const final = await pollWorkflow(runId, "completed", 120_000);

      expect(final.status).toBe("completed");
      expect(final.stepJobs.sleepy).toBe(job.id);

      const completedJob = await api<JobDetail>(`/api/jobs/${job.id}`, { method: "GET" });
      expect(completedJob.status).toBe("completed");
    } finally {
      if (job.schedulerJobId) {
        await stack.slurm.exec(["scancel", job.schedulerJobId]);
      }
    }
  }, 240_000);
});

async function seedPackages(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(usecasePackages).where(inArray(usecasePackages.id, PACKAGE_IDS));
  await seedE2eSoftwareRevision(dbHandle, SOFTWARE_ID);
  await dbHandle.insert(usecasePackages).values([
    {
      id: BASH_SLEEP_PKG_ID,
      name: "mock-bash-sleep",
      version: "1",
      spec: bashPackage(),
    },
  ]);
}

function bashPackage(): usecase.UsecasePackage {
  return governedShellPackage({
    usecase: {
      commandFile: "bash",
      inputSlots: [
        {
          kind: "Text",
          descriptor: "script",
          refMaterials: [{ kind: "ArgRef", descriptor: "script", sort: 0 }],
        },
      ],
    },
    software: { kind: "Bare" },
    arguments: [{ descriptor: "script", valueFormat: "-lc {}" }],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
  });
}

function sleepWorkflow(script = "sleep 120"): string {
  return JSON.stringify(
    {
      name: "workflow_cancel_e2e",
      description: "Mock long-running workflow used to test cancellation.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "sleepy",
            name: "sleepy",
            usecaseVersionId: BASH_SLEEP_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString(script) },
              },
            ],
            requirements: { maxWallTime: 180 },
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
  const dir = mkdtempSync(join(tmpdir(), "kq-resilience-workflow-"));
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

async function waitForNodeJob(
  runId: string,
  nodeId: string,
  expectedStatus: JobDetail["status"],
  timeoutMs: number,
): Promise<JobDetail> {
  const deadline = Date.now() + timeoutMs;
  let lastRun: WorkflowRunDetail | undefined;
  let lastJob: JobDetail | undefined;
  while (Date.now() < deadline) {
    lastRun = await api<WorkflowRunDetail>(`/api/workflows/${runId}`, { method: "GET" });
    const jobId = lastRun.stepJobs[nodeId];
    if (jobId) {
      lastJob = await api<JobDetail>(`/api/jobs/${jobId}`, { method: "GET" });
      if (lastJob.status === expectedStatus && lastJob.schedulerJobId) {
        return lastJob;
      }
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `Workflow ${runId} node ${nodeId} did not reach job status ${expectedStatus}: ${JSON.stringify({ lastRun, lastJob })}`,
  );
}

async function pollWorkflow(
  runId: string,
  expectedStatus: "cancelled" | "completed" | "failed",
  timeoutMs: number,
): Promise<WorkflowRunDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowRunDetail | undefined;
  while (Date.now() < deadline) {
    last = await api<WorkflowRunDetail>(`/api/workflows/${runId}`, { method: "GET" });
    if (last.status === expectedStatus) {
      return last;
    }
    if (
      last.status === "completed" ||
      (expectedStatus !== "failed" && last.status === "failed") ||
      (expectedStatus !== "cancelled" && last.status === "cancelled")
    ) {
      throw new Error(`Workflow ${runId} ended with unexpected status: ${JSON.stringify(last)}`);
    }
    await Bun.sleep(500);
  }
  throw new Error(`Workflow ${runId} did not reach ${expectedStatus}: ${JSON.stringify(last)}`);
}

async function pollSlurmCancelled(schedulerJobId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const result = await stack.slurm.exec(["scontrol", "show", "job", schedulerJobId, "-o"]);
    last = result.stdout.trim() || result.stderr.trim();
    if (last.includes("JobState=CANCELLED")) {
      return last;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Slurm job ${schedulerJobId} was not cancelled: ${last}`);
}

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${stack.adminToken}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${stack.serverBaseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface WorkflowRunDetail {
  id: string;
  status: string;
  errorCode?: string | null;
  stepJobs: Record<string, string>;
}

interface JobDetail {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  schedulerJobId: string;
}
