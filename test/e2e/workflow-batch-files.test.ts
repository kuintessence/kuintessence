import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
const BATCH_FILE_PKG_ID = "44444444-4444-4444-8444-444444444101";
const SOFTWARE_ID = "44444444-4444-4444-8444-444444444201";
const PACKAGE_IDS = [BATCH_FILE_PKG_ID];

let stack: Stack;
let db: PgDb;
let cliConfigDir: string;
let cliConfigFile: string;
const workflowDirs: string[] = [];

beforeAll(async () => {
  stack = await startStack({ netdrive: true });
  db = createPgDb(stack.databaseUrl);
  await seedPackages(db);
  cliConfigDir = mkdtempSync(join(tmpdir(), "kq-batch-files-cli-e2e-"));
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

describe("e2e: workflow batched file inputs and outputs", () => {
  test("stages multiple File inputs and collects a batched output glob", async () => {
    const inputA = await uploadTextFile("batch/inputs/a.txt", "alpha\n");
    const inputB = await uploadTextFile("batch/inputs/b.txt", "beta\n");
    const yamlPath = writeWorkflowYaml(batchFilesWorkflow([inputA, inputB]));

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.stepJobs.batchFanout).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.status.batchFanout).toBe("Succeeded");
    expect(final.result?.values.batchFanout?.values.chunkTexts).toEqual(["ALPHA\n", "BETA\n"]);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("batchFanout: Succeeded");
    expect(status.stdout).toContain('"chunkTexts":["ALPHA\\n","BETA\\n"]');
  }, 180_000);

  test("publishes a batched output as downstream File[] artifacts", async () => {
    const inputA = await uploadTextFile("batch/artifact-edge/a.txt", "alpha\n");
    const inputB = await uploadTextFile("batch/artifact-edge/b.txt", "beta\n");
    const yamlPath = writeWorkflowYaml(batchArtifactEdgeWorkflow([inputA, inputB]));

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 180_000);

    const chunks = final.result?.values.batchFanout?.values.chunks;
    expect(final.status).toBe("completed");
    expect(final.result?.status.batchFanout).toBe("Succeeded");
    expect(final.result?.status.batchConsume).toBe("Succeeded");
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks).toHaveLength(2);
    expect(final.result?.values.batchConsume?.values.summary).toBe("ALPHA,BETA");

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("batchConsume: Succeeded");
    expect(status.stdout).toContain('"summary":"ALPHA,BETA"');
  }, 240_000);

  test("passes an empty batched output through a downstream File[] edge", async () => {
    const yamlPath = writeWorkflowYaml(
      batchArtifactEdgeWorkflow([], batchConsumeEmptyAwareScript()),
    );

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 180_000);

    const chunks = final.result?.values.batchFanout?.values.chunks;
    expect(final.status).toBe("completed");
    expect(final.result?.status.batchFanout).toBe("Succeeded");
    expect(final.result?.status.batchConsume).toBe("Succeeded");
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks).toHaveLength(0);
    expect(final.result?.values.batchConsume?.values.summary).toBe("EMPTY");

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("batchConsume: Succeeded");
    expect(status.stdout).toContain('"summary":"EMPTY"');
  }, 240_000);

  test("fanout returns empty array for empty batch input", async () => {
    const yamlPath = writeWorkflowYaml(batchFilesWorkflow([]));

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.stepJobs.batchFanout).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.status.batchFanout).toBe("Succeeded");
    expect(final.result?.values.batchFanout?.values.chunkTexts).toEqual([]);
  }, 180_000);
});

async function seedPackages(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(usecasePackages).where(inArray(usecasePackages.id, PACKAGE_IDS));
  await seedE2eSoftwareRevision(dbHandle, SOFTWARE_ID);
  await dbHandle.insert(usecasePackages).values([
    {
      id: BATCH_FILE_PKG_ID,
      name: "mock-bash-batch-files",
      version: "1",
      spec: batchFilePackage(),
    },
  ]);
}

function batchFilePackage(): usecase.UsecasePackage {
  return governedShellPackage({
    usecase: {
      commandFile: "bash",
      inputSlots: [
        {
          kind: "File",
          descriptor: "inputs",
          refMaterials: [{ kind: "FileInputRef", descriptor: "inputFiles" }],
        },
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
    filesomeInputs: [
      { descriptor: "inputFiles", fileKind: { kind: "Batched", pattern: "inputs/*.txt" } },
    ],
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

async function uploadTextFile(path: string, text: string): Promise<WorkflowFileInput> {
  const body = new TextEncoder().encode(text);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const mint = await api<{
    success: true;
    data: { uploadUrl: string; storageKey: string; commitToken: string };
  }>("/api/netdrive/upload-url", {
    method: "POST",
    body: JSON.stringify({
      path,
      size: body.length,
      contentType: "text/plain",
      sha256,
    }),
  });

  const upload = await fetch(mint.data.uploadUrl, {
    method: "PUT",
    body,
    headers: { "Content-Type": "text/plain" },
  });
  if (!upload.ok) {
    throw new Error(`MinIO upload failed: ${upload.status} ${await upload.text()}`);
  }

  const commit = await api<{
    success: true;
    data: { id: string; path: string; size: number; sha256: string };
  }>("/api/netdrive/files", {
    method: "POST",
    body: JSON.stringify({
      path,
      size: body.length,
      contentType: "text/plain",
      sha256,
      storageKey: mint.data.storageKey,
      commitToken: mint.data.commitToken,
      etag: upload.headers.get("etag") ?? undefined,
    }),
  });

  return {
    fileMetadataId: commit.data.id,
    fileMetadataName: path.split("/").at(-1) ?? "input.txt",
    hash: commit.data.sha256,
    size: commit.data.size,
  };
}

function batchFilesWorkflow(files: WorkflowFileInput[]): string {
  return JSON.stringify(
    {
      name: "batch_files_e2e",
      description: "Mock batched file input/output workflow e2e.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "batchFanout",
            name: "batchFanout",
            usecaseVersionId: BATCH_FILE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            inputSlots: [
              {
                type: "File",
                descriptor: "inputs",
                contents: files,
                expectedFileName: "inputs/*.txt",
                isBatch: true,
              },
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString(batchScript()) },
              },
            ],
            outputSlots: [
              {
                type: "File",
                descriptor: "chunks",
                optional: false,
                origin: "UsecaseOut",
                isBatch: true,
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

function batchArtifactEdgeWorkflow(
  files: WorkflowFileInput[],
  consumeScript = batchConsumeScript(),
): string {
  return JSON.stringify(
    {
      name: "batch_file_artifact_edge_e2e",
      description: "Mock batched file artifact edge workflow e2e.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "batchFanout",
            name: "batchFanout",
            usecaseVersionId: BATCH_FILE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            inputSlots: [
              {
                type: "File",
                descriptor: "inputs",
                contents: files,
                expectedFileName: "inputs/*.txt",
                isBatch: true,
              },
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString(batchScript()) },
              },
            ],
            outputSlots: [
              {
                type: "File",
                descriptor: "chunks",
                optional: false,
                origin: "UsecaseOut",
                isBatch: true,
              },
            ],
          },
          {
            type: "SoftwareUsecaseComputing",
            id: "batchConsume",
            name: "batchConsume",
            usecaseVersionId: BATCH_FILE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            inputSlots: [
              {
                type: "File",
                descriptor: "inputs",
                from: { node: "batchFanout", output: "chunks" },
                expectedFileName: "chunks/*.txt",
                isBatch: true,
              },
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString(consumeScript) },
              },
            ],
            valueOutputsOverride: [
              {
                descriptor: "summary",
                type: "string",
                from: { collectedOutDescriptor: "stdout" },
                extract: { kind: "Regex", pattern: "summary=([A-Z,]+)", group: 1 },
              },
            ],
          },
        ],
        nodeRelations: [{ fromId: "batchFanout", toId: "batchConsume", slotRelations: [] }],
      },
    },
    null,
    2,
  );
}

function batchScript(): string {
  return [
    "set -e",
    "mkdir -p chunks",
    "shopt -s nullglob",
    'for f in inputs/*.txt; do b=$(basename "$f"); tr "[:lower:]" "[:upper:]" < "$f" > "chunks/$b"; done',
    "shopt -u nullglob",
  ].join("; ");
}

function batchConsumeScript(): string {
  return 'printf "summary=%s\\n" "$(cat inputs/*.txt | tr "\\n" "," | sed "s/,$//")"';
}

function batchConsumeEmptyAwareScript(): string {
  const fileCount = '"$' + '{#files[@]}"';
  const filesArg = '"$' + '{files[@]}"';
  return [
    "shopt -s nullglob",
    "files=(inputs/*.txt)",
    `if [ ${fileCount} -eq 0 ]; then printf "summary=EMPTY\\n"; else printf "summary=%s\\n" "$(cat ${filesArg} | tr "\\n" "," | sed "s/,$//")"; fi`,
  ].join("; ");
}

function celString(value: string): string {
  if (value.includes("'")) {
    throw new Error("test CEL strings must not contain single quotes");
  }
  return `'${value}'`;
}

function writeWorkflowYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kq-batch-files-workflow-"));
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
      const jobs = await fetchStepJobs(last.stepJobs);
      throw new Error(
        `Workflow ${runId} ended with unexpected status: ${JSON.stringify({ workflow: last, jobs })}`,
      );
    }
    await Bun.sleep(1000);
  }
  const jobs = last ? await fetchStepJobs(last.stepJobs) : {};
  throw new Error(
    `Workflow ${runId} did not reach ${expectedStatus}: ${JSON.stringify({ workflow: last, jobs })}`,
  );
}

async function fetchStepJobs(stepJobs: Record<string, string>): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(stepJobs).map(async ([nodeId, jobId]) => {
      try {
        const job = await api<Record<string, unknown>>(`/api/jobs/${jobId}`, { method: "GET" });
        return [nodeId, { ...job, diagnostics: await fetchSlurmDiagnostics(job) }] as const;
      } catch (err) {
        return [
          nodeId,
          { error: err instanceof Error ? err.message : String(err), jobId },
        ] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function fetchSlurmDiagnostics(
  job: Record<string, unknown>,
): Promise<Record<string, string>> {
  const schedulerJobId = typeof job.schedulerJobId === "string" ? job.schedulerJobId : "";
  const workingDir = typeof job.workingDir === "string" ? job.workingDir : "";
  const [slurmJob, workingDirListing] = await Promise.all([
    schedulerJobId
      ? stack.slurm.exec(["scontrol", "show", "job", schedulerJobId, "-o"])
      : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    workingDir
      ? stack.slurm.exec(["sh", "-c", `ls -ld ${workingDir} && find ${workingDir} -maxdepth 3 -ls`])
      : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  ]);
  return {
    slurmJob: slurmJob.stdout.trim() || slurmJob.stderr.trim(),
    workingDirListing: workingDirListing.stdout.trim() || workingDirListing.stderr.trim(),
  };
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

interface WorkflowFileInput {
  fileMetadataId: string;
  fileMetadataName: string;
  hash: string;
  size: number;
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
