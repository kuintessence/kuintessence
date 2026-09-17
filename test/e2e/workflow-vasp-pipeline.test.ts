import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const BENCH_FIXTURES = join(REPO_ROOT, "test/e2e/fixtures/mock-vasp");
const VASP_PKG_ID = "11111111-1111-4111-8111-111111111101";
const CONVERTER_TEXT_PKG_ID = "11111111-1111-4111-8111-111111111102";
const CONVERTER_FILE_PKG_ID = "11111111-1111-4111-8111-111111111103";
const SOFTWARE_ID = "11111111-1111-4111-8111-111111111201";
const PACKAGE_IDS = [VASP_PKG_ID, CONVERTER_TEXT_PKG_ID, CONVERTER_FILE_PKG_ID];

let stack: Stack;
let db: PgDb;
let cliConfigDir: string;
let cliConfigFile: string;
let benchDirectory: string;
let benchArchive: string;
const workflowDirs: string[] = [];

beforeAll(async () => {
  benchDirectory = mkdtempSync(join(tmpdir(), "kq-mock-vasp-"));
  benchArchive = join(benchDirectory, "mock-input.tar.gz");
  const archive = spawn(
    [
      "tar",
      "-czf",
      benchArchive,
      "-C",
      BENCH_FIXTURES,
      "INCAR",
      "KPOINTS",
      "POSCAR",
      "POTCAR.mock",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await archive.exited) !== 0) {
    throw new Error(`Mock fixture archive failed: ${await new Response(archive.stderr).text()}`);
  }
  stack = await startStack({ netdrive: true });
  db = createPgDb(stack.databaseUrl);
  await seedPackages(db);
  cliConfigDir = mkdtempSync(join(tmpdir(), "kq-vasp-cli-e2e-"));
  cliConfigFile = join(cliConfigDir, "config.json");
  writeFileSync(
    cliConfigFile,
    JSON.stringify({ serverUrl: stack.serverBaseUrl, token: stack.adminToken }),
  );
}, 300_000);

afterAll(async () => {
  await stack?.stop();
  if (benchDirectory) {
    rmSync(benchDirectory, { recursive: true, force: true });
  }
  if (cliConfigDir) {
    rmSync(cliConfigDir, { recursive: true, force: true });
  }
  for (const dir of workflowDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("e2e: VASP workflow DSL -> CLI -> Server -> Agent -> Slurm -> results", () => {
  test("runs VASP -> converter -> VASP through the text-value workaround", async () => {
    const file = await uploadBenchArchive("vasp/text/mock-input.tar.gz");
    const yamlPath = writeWorkflowYaml(textValueWorkflow(file));

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.stepJobs.vasp1).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.stepJobs.convert).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.stepJobs.vasp2).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.status).toEqual({
      vasp1: "Succeeded",
      convert: "Succeeded",
      vasp2: "Succeeded",
    });
    expect(final.result?.values.vasp1?.values.energy).toBe(12.345);
    expect(final.result?.values.convert?.values.convertedEnergy).toBe(12.445);
    expect(final.result?.values.vasp2?.values.finalEnergy).toBe(12.545);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("vasp2: Succeeded");
    expect(status.stdout).toContain('"finalEnergy":12.545');
  }, 180_000);

  test("runs VASP -> converter through a real file-artifact edge", async () => {
    const file = await uploadBenchArchive("vasp/file-edge/mock-input.tar.gz");
    const yamlPath = writeWorkflowYaml(fileArtifactWorkflow(file));

    const submit = await runCli(["workflow", "submit", yamlPath]);
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.vasp1).toBe("Succeeded");
    expect(final.result?.status.convertFromFile).toBe("Succeeded");
    expect(final.result?.values.convertFromFile?.values.convertedEnergy).toBe(12.445);
    expect(final.stepJobs.vasp1).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.stepJobs.convertFromFile).toMatch(/^[0-9a-f-]{36}$/);
  }, 180_000);
});

async function seedPackages(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(usecasePackages).where(inArray(usecasePackages.id, PACKAGE_IDS));
  await seedE2eSoftwareRevision(dbHandle, SOFTWARE_ID);
  await dbHandle.insert(usecasePackages).values([
    {
      id: VASP_PKG_ID,
      name: "mock-vasp",
      version: "1",
      spec: commandPackage({
        inputs: ["bench", "script"],
        files: [{ descriptor: "bench", name: "mock-input.tar.gz" }],
        outputs: [
          { descriptor: "metrics", name: "metrics.txt" },
          { descriptor: "relaxedArchive", name: "relaxed.tar.gz" },
        ],
        values: [
          {
            descriptor: "energy",
            type: "double",
            from: { collectedOutDescriptor: "metrics" },
            extract: { kind: "Regex", pattern: "energy=([0-9.]+)", group: 1 },
          },
        ],
      }),
    },
    {
      id: CONVERTER_TEXT_PKG_ID,
      name: "mock-vasp-converter-text",
      version: "1",
      spec: commandPackage({
        inputs: ["bench", "script"],
        files: [{ descriptor: "bench", name: "mock-input.tar.gz" }],
        outputs: [{ descriptor: "converted", name: "converted.txt" }],
        values: [
          {
            descriptor: "convertedEnergy",
            type: "double",
            from: { collectedOutDescriptor: "converted" },
            extract: { kind: "Regex", pattern: "converted_energy=([0-9.]+)", group: 1 },
          },
        ],
      }),
    },
    {
      id: CONVERTER_FILE_PKG_ID,
      name: "mock-vasp-converter-file",
      version: "1",
      spec: commandPackage({
        inputs: ["upstreamArchive", "script"],
        files: [{ descriptor: "upstreamArchive", name: "upstream.tar.gz" }],
        outputs: [{ descriptor: "converted", name: "converted.txt" }],
        values: [
          {
            descriptor: "convertedEnergy",
            type: "double",
            from: { collectedOutDescriptor: "converted" },
            extract: { kind: "Regex", pattern: "converted_energy=([0-9.]+)", group: 1 },
          },
        ],
      }),
    },
  ]);
}

function commandPackage(input: {
  inputs: string[];
  files: Array<{ descriptor: string; name: string }>;
  outputs: Array<{ descriptor: string; name: string }>;
  values: usecase.UsecasePackage["valueOutputs"];
}): usecase.UsecasePackage {
  return governedShellPackage({
    usecase: {
      commandFile: "bash",
      inputSlots: input.inputs.map((descriptor) =>
        descriptor === "script"
          ? {
              kind: "Text",
              descriptor,
              refMaterials: [{ kind: "ArgRef", descriptor: "script", sort: 0 }],
            }
          : {
              kind: "File",
              descriptor,
              refMaterials: [{ kind: "FileInputRef", descriptor }],
            },
      ),
    },
    software: { kind: "Bare" },
    arguments: [{ descriptor: "script", valueFormat: "-lc {}" }],
    environments: [],
    filesomeInputs: input.files.map((file) => ({
      descriptor: file.descriptor,
      fileKind: { kind: "Normal", name: file.name },
    })),
    filesomeOutputs: input.outputs.map((file) => ({
      descriptor: file.descriptor,
      fileKind: { kind: "Normal", name: file.name },
    })),
    valueOutputs: input.values,
  });
}

async function uploadBenchArchive(path: string): Promise<WorkflowFileInput> {
  const body = readFileSync(benchArchive);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const mint = await api<{
    success: true;
    data: { uploadUrl: string; storageKey: string; commitToken: string };
  }>("/api/netdrive/upload-url", {
    method: "POST",
    body: JSON.stringify({
      path,
      size: body.length,
      contentType: "application/gzip",
      sha256,
    }),
  });

  const upload = await fetch(mint.data.uploadUrl, {
    method: "PUT",
    body,
    headers: { "Content-Type": "application/gzip" },
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
      contentType: "application/gzip",
      sha256,
      storageKey: mint.data.storageKey,
      commitToken: mint.data.commitToken,
      etag: upload.headers.get("etag") ?? undefined,
    }),
  });

  return {
    fileMetadataId: commit.data.id,
    fileMetadataName: "mock-input.tar.gz",
    hash: commit.data.sha256,
    size: commit.data.size,
  };
}

function textValueWorkflow(file: WorkflowFileInput): string {
  const vasp1Script = [
    "set -e",
    "tar -tzf mock-input.tar.gz | sort > manifest.txt",
    "grep -qx INCAR manifest.txt",
    "grep -qx KPOINTS manifest.txt",
    "grep -qx POSCAR manifest.txt",
    "grep -qx POTCAR.mock manifest.txt",
    "cp mock-input.tar.gz relaxed.tar.gz",
    'printf "energy=12.345\\n" > metrics.txt',
  ].join("; ");
  const converterPrefix = 'set -e; printf "converted_energy=';
  const converterSuffix = '\\n" > converted.txt';
  const vasp2Prefix = [
    "set -e",
    "tar -tzf mock-input.tar.gz | sort > manifest.txt",
    "grep -qx INCAR manifest.txt",
    "cp mock-input.tar.gz relaxed.tar.gz",
    'printf "final_energy=',
  ].join("; ");
  const vasp2Suffix = '\\n" > metrics.txt';
  return workflowYaml({
    name: "vasp_text_pipeline_e2e",
    nodes: [
      softwareNode("vasp1", "vasp1", VASP_PKG_ID, [
        fileSlot("bench", file),
        textSlot("script", celString(vasp1Script)),
      ]),
      softwareNode("convert", "convert", CONVERTER_TEXT_PKG_ID, [
        fileSlot("bench", file),
        textSlot(
          "script",
          `${celString(converterPrefix)} + string(nodes.vasp1.values.energy + 0.1) + ${celString(
            converterSuffix,
          )}`,
        ),
      ]),
      softwareNode("vasp2", "vasp2", VASP_PKG_ID, [
        fileSlot("bench", file),
        textSlot(
          "script",
          `${celString(vasp2Prefix)} + string(nodes.convert.values.convertedEnergy + 0.1) + ${celString(
            vasp2Suffix,
          )}`,
        ),
        {
          valueOutputsOverride: [
            {
              descriptor: "finalEnergy",
              type: "double",
              from: { collectedOutDescriptor: "metrics" },
              extract: { kind: "Regex", pattern: "final_energy=([0-9.]+)", group: 1 },
            },
          ],
        },
      ]),
    ],
    relations: [
      { fromId: "vasp1", toId: "convert", slotRelations: [] },
      { fromId: "convert", toId: "vasp2", slotRelations: [] },
    ],
  });
}

function fileArtifactWorkflow(file: WorkflowFileInput): string {
  const vasp1Script = [
    "set -e",
    "tar -tzf mock-input.tar.gz > manifest.txt",
    "cp mock-input.tar.gz relaxed.tar.gz",
    'printf "energy=12.345\\n" > metrics.txt',
  ].join("; ");
  const converterScript =
    'set -e; tar -tzf upstream.tar.gz > converted.txt; printf "converted_energy=12.445\\n" >> converted.txt';
  return workflowYaml({
    name: "vasp_file_edge_e2e",
    nodes: [
      {
        ...softwareNode("vasp1", "vasp1", VASP_PKG_ID, [
          fileSlot("bench", file),
          textSlot("script", celString(vasp1Script)),
        ]),
        outputSlots: [
          {
            type: "File",
            descriptor: "relaxedArchive",
            optional: false,
            origin: "UsecaseOut",
            isBatch: false,
          },
        ],
      },
      softwareNode("convertFromFile", "convertFromFile", CONVERTER_FILE_PKG_ID, [
        {
          type: "File",
          descriptor: "upstreamArchive",
          from: { node: "vasp1", output: "relaxedArchive" },
          expectedFileName: "upstream.tar.gz",
          isBatch: false,
        },
        textSlot("script", celString(converterScript)),
      ]),
    ],
    relations: [
      {
        fromId: "vasp1",
        toId: "convertFromFile",
        slotRelations: [
          {
            fromSlot: "relaxedArchive",
            toSlot: "upstreamArchive",
            transferStrategy: { type: "Network" },
          },
        ],
      },
    ],
  });
}

function workflowYaml(input: { name: string; nodes: unknown[]; relations: unknown[] }): string {
  return JSON.stringify(
    {
      name: input.name,
      description: "Mock VASP pipeline e2e.",
      parameters: [],
      spec: {
        nodeDrafts: input.nodes,
        nodeRelations: input.relations,
      },
    },
    null,
    2,
  );
}

function softwareNode(
  id: string,
  name: string,
  packageId: string,
  slotsAndOverrides: unknown[],
): Record<string, unknown> {
  const inputSlots = slotsAndOverrides.filter(
    (item) => !("valueOutputsOverride" in objectOf(item)),
  );
  const override = slotsAndOverrides.find((item) => "valueOutputsOverride" in objectOf(item));
  return {
    type: "SoftwareUsecaseComputing",
    id,
    name,
    usecaseVersionId: packageId,
    softwareVersionId: SOFTWARE_ID,
    inputSlots,
    ...(objectOf(override).valueOutputsOverride
      ? { valueOutputsOverride: objectOf(override).valueOutputsOverride }
      : {}),
  };
}

function fileSlot(descriptor: string, file: WorkflowFileInput): Record<string, unknown> {
  return {
    type: "File",
    descriptor,
    contents: [file],
    expectedFileName: file.fileMetadataName,
    isBatch: false,
  };
}

function textSlot(descriptor: string, expr: string): Record<string, unknown> {
  return {
    type: "Text",
    descriptor,
    from: { expr },
  };
}

function celString(value: string): string {
  if (value.includes("'")) {
    throw new Error("test CEL strings must not contain single quotes");
  }
  return `'${value}'`;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function writeWorkflowYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kq-vasp-workflow-"));
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
      const jobs = await Promise.all(
        Object.values(last.stepJobs).map(async (jobId) => ({
          detail: await api<Record<string, unknown>>(`/api/jobs/${jobId}`, { method: "GET" }),
          logs: await api<{ text: string }>(`/api/jobs/${jobId}/logs?lines=200`, {
            method: "GET",
          }),
        })),
      );
      throw new Error(
        `Workflow ${runId} ended with unexpected status: ${JSON.stringify({ workflow: last, jobs })}`,
      );
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Workflow ${runId} did not reach ${expectedStatus}: ${JSON.stringify(last)}`);
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
