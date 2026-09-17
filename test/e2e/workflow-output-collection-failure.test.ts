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
const OUTPUT_FAILURE_PKG_ID = "55555555-5555-4555-8555-555555555101";
const SOFTWARE_ID = "55555555-5555-4555-8555-555555555201";
const PACKAGE_IDS = [OUTPUT_FAILURE_PKG_ID];

let stack: Stack;
let db: PgDb;
let cliConfigDir: string;
let cliConfigFile: string;
const workflowDirs: string[] = [];

beforeAll(async () => {
  stack = await startStack({
    agentEnv: { AGENT_TEST_FAIL_OUTPUT_COLLECTION_DESCRIPTOR: "chunks" },
  });
  db = createPgDb(stack.databaseUrl);
  await seedPackages(db);
  cliConfigDir = mkdtempSync(join(tmpdir(), "kq-output-failure-cli-e2e-"));
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

describe("e2e: workflow output collection failure through CLI + Server + Agent + Slurm", () => {
  test("marks the workflow failed when terminal output collection throws", async () => {
    const yamlPath = writeWorkflowYaml(outputCollectionFailureWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.stepJobs.produce).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.status.produce).toBe("Failed");

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("produce: Failed");
  }, 180_000);
});

async function seedPackages(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(usecasePackages).where(inArray(usecasePackages.id, PACKAGE_IDS));
  await seedE2eSoftwareRevision(dbHandle, SOFTWARE_ID);
  await dbHandle.insert(usecasePackages).values([
    {
      id: OUTPUT_FAILURE_PKG_ID,
      name: "mock-bash-output-collection-failure",
      version: "1",
      spec: outputFailurePackage(),
    },
  ]);
}

function outputFailurePackage(): usecase.UsecasePackage {
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
    filesomeOutputs: [
      { descriptor: "chunks", fileKind: { kind: "Batched", pattern: "chunks/*.txt" } },
    ],
    valueOutputs: [
      {
        descriptor: "chunkTexts",
        type: { list: "string" },
        from: { collectedOutDescriptor: "chunks" },
        extract: { kind: "Whole" },
      },
    ],
  });
}

function outputCollectionFailureWorkflow(): string {
  return JSON.stringify(
    {
      name: "output_collection_failure_e2e",
      description: "A successful scheduler job whose terminal output collection throws.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "produce",
            name: "produce",
            usecaseVersionId: OUTPUT_FAILURE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: {
                  expr: celString('mkdir -p chunks; printf "ok\\n" > chunks/part-1.txt'),
                },
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
  const dir = mkdtempSync(join(tmpdir(), "kq-output-failure-workflow-"));
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
