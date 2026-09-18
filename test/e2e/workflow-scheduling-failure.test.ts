import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  createPgDb,
  jobs,
  orgs,
  type PgDb,
  schedulerQueues,
  schedulingPreferences,
  usecasePackages,
  users,
} from "../../packages/db/src";
import type { usecase } from "../../packages/shared/src";
import { governedShellPackage, seedE2eSoftwareRevision } from "./fixtures/governed-package";
import { type Stack, startStack } from "./fixtures/stack";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const SCHEDULING_FAILURE_PKG_ID = "66666666-6666-4666-8666-666666666101";
const SOFTWARE_ID = "66666666-6666-4666-8666-666666666201";
const DISABLED_QUEUE_ID = "66666666-6666-4666-8666-666666666301";
const PREFERRED_QUEUE_ID = "66666666-6666-4666-8666-666666666302";
const MISMATCH_QUEUE_ID = "66666666-6666-4666-8666-666666666303";
const MISSING_QOS_QUEUE_ID = "66666666-6666-4666-8666-666666666304";
const MISSING_PARTITION = "kq_missing_partition";
const MISSING_QOS = "kq_missing_qos";
const QUEUE_IDS = [DISABLED_QUEUE_ID, PREFERRED_QUEUE_ID, MISMATCH_QUEUE_ID, MISSING_QOS_QUEUE_ID];
const PACKAGE_IDS = [SCHEDULING_FAILURE_PKG_ID];

let stack: Stack;
let db: PgDb;
let cliConfigDir: string;
let cliConfigFile: string;
let providerOrgId: string | undefined;
let preferredQueueName: string;
let adminUserId: string;
const workflowDirs: string[] = [];

beforeAll(async () => {
  stack = await startStack();
  db = createPgDb(stack.databaseUrl);
  preferredQueueName = await detectSlurmPartition();
  adminUserId = await resolveAdminUserId();
  await seedPackages(db);
  await seedSchedulingQueues(db);
  cliConfigDir = mkdtempSync(join(tmpdir(), "kq-scheduling-failure-cli-e2e-"));
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

describe("e2e: workflow scheduling failures through CLI + Server placement", () => {
  test("fails a node whose Manual queue is disabled", async () => {
    const yamlPath = writeWorkflowYaml(disabledQueueWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.stepJobs.needs_queue).toMatch(/^[0-9a-f-]{36}$/);
    expect(final.result?.status.needs_queue).toBe("Failed");
    expect(final.result?.values.needs_queue?.values).toEqual({});

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("needs_queue: Failed");
  }, 180_000);

  test("runs a node whose Prefer queue is available and sends its partition to Slurm", async () => {
    const yamlPath = writeWorkflowYaml(preferredQueueWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.prefers_queue).toBe("Succeeded");
    expect(final.result?.values.prefers_queue?.values.value).toBe(7);

    const stepJobId = final.stepJobs.prefers_queue;
    expect(stepJobId).toMatch(/^[0-9a-f-]{36}$/);
    const [job] = await db
      .select({ schedulerJobId: jobs.schedulerJobId })
      .from(jobs)
      .where(eq(jobs.id, stepJobId))
      .limit(1);
    expect(job?.schedulerJobId).toMatch(/^[0-9]+$/);
    const slurmJob = await stack.slurm.exec([
      "scontrol",
      "show",
      "job",
      job?.schedulerJobId ?? "",
      "-o",
    ]);
    expect(slurmJob.stdout).toContain(`Partition=${preferredQueueName}`);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("prefers_queue: Succeeded");
  }, 180_000);

  test("falls back to a later Prefer queue when an earlier preferred queue is disabled", async () => {
    const yamlPath = writeWorkflowYaml(preferredQueueFallbackWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.prefer_fallback).toBe("Succeeded");
    expect(final.result?.values.prefer_fallback?.values.value).toBe(9);

    const stepJobId = final.stepJobs.prefer_fallback;
    expect(stepJobId).toMatch(/^[0-9a-f-]{36}$/);
    const [job] = await db
      .select({ schedulerJobId: jobs.schedulerJobId })
      .from(jobs)
      .where(eq(jobs.id, stepJobId))
      .limit(1);
    expect(job?.schedulerJobId).toMatch(/^[0-9]+$/);
    const slurmJob = await stack.slurm.exec([
      "scontrol",
      "show",
      "job",
      job?.schedulerJobId ?? "",
      "-o",
    ]);
    expect(slurmJob.stdout).toContain(`Partition=${preferredQueueName}`);
  }, 180_000);

  test("fails a node whose Manual queue maps to a missing Slurm partition", async () => {
    const yamlPath = writeWorkflowYaml(missingPartitionWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000);

    expect(final.status).toBe("failed");
    expect(final.result?.status.bad_partition).toBe("Failed");
    expect(final.result?.values.bad_partition?.values).toEqual({});

    const stepJobId = final.stepJobs.bad_partition;
    expect(stepJobId).toMatch(/^[0-9a-f-]{36}$/);
    const [job] = await db
      .select({ status: jobs.status, schedulerJobId: jobs.schedulerJobId })
      .from(jobs)
      .where(eq(jobs.id, stepJobId))
      .limit(1);
    expect(job?.status).toBe("failed");
    expect(job?.schedulerJobId).toBeNull();

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("bad_partition: Failed");
  }, 180_000);

  test("passes a Manual queue QoS into the Slurm submit script", async () => {
    const yamlPath = writeWorkflowYaml(missingQosWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "completed", 120_000);

    expect(final.status).toBe("completed");
    expect(final.result?.status.qos_queue).toBe("Succeeded");
    expect(final.result?.values.qos_queue?.values.value).toBe(13);

    const stepJobId = final.stepJobs.qos_queue;
    expect(stepJobId).toMatch(/^[0-9a-f-]{36}$/);
    const [job] = await db
      .select({ status: jobs.status, schedulerJobId: jobs.schedulerJobId })
      .from(jobs)
      .where(eq(jobs.id, stepJobId))
      .limit(1);
    expect(job?.status).toBe("completed");
    expect(job?.schedulerJobId).toMatch(/^[0-9]+$/);

    const schedulerRecord = await stack.slurm.exec([
      "scontrol",
      "show",
      "job",
      job?.schedulerJobId ?? "",
      "-o",
    ]);
    expect(schedulerRecord.exitCode).toBe(0);
    expect(schedulerRecord.stdout).toContain(`Partition=${preferredQueueName}`);
    // This fixture has no QoS accounting; inspect the script accepted by Slurm.
    const batchScript = await stack.slurm.exec([
      "cat",
      `/var/tmp/kq-slurm-shared/qos-${job?.schedulerJobId}.sh`,
    ]);
    expect(batchScript.exitCode).toBe(0);
    const directives = batchScript.stdout.split("\n").filter((line) => line.startsWith("#SBATCH"));
    expect(directives).toContain(`#SBATCH --partition=${preferredQueueName}`);
    expect(directives).toContain(`#SBATCH --qos=${MISSING_QOS}`);

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("qos_queue: Succeeded");
  }, 180_000);

  test("fails a node whose Manual queue agent is denied by user preference", async () => {
    await denyStackAgentForAdminUser();
    try {
      const yamlPath = writeWorkflowYaml(preferenceDeniedManualQueueWorkflow());

      const submit = await runCli(["workflow", "submit", yamlPath]);
      expect(submit.stderr).toBe("");
      const runId = parseRunId(submit.stdout);
      const final = await pollWorkflow(runId, "failed", 120_000);

      expect(final.status).toBe("failed");
      expect(final.result?.status.preference_conflict).toBe("Failed");
      expect(final.result?.values.preference_conflict?.values).toEqual({});

      const stepJobId = final.stepJobs.preference_conflict;
      expect(stepJobId).toMatch(/^[0-9a-f-]{36}$/);
      const [job] = await db
        .select({ status: jobs.status, schedulerJobId: jobs.schedulerJobId })
        .from(jobs)
        .where(eq(jobs.id, stepJobId))
        .limit(1);
      expect(job?.status).toBe("failed");
      expect(job?.schedulerJobId).toBeNull();

      const status = await runCli(["workflow", "status", runId]);
      expect(status.stdout).toContain("preference_conflict: Failed");
    } finally {
      await clearAdminUserPreference();
    }
  }, 180_000);
});

async function seedPackages(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(usecasePackages).where(inArray(usecasePackages.id, PACKAGE_IDS));
  await seedE2eSoftwareRevision(dbHandle, SOFTWARE_ID);
  await dbHandle.insert(usecasePackages).values([
    {
      id: SCHEDULING_FAILURE_PKG_ID,
      name: "mock-bash-scheduling-failure",
      version: "1",
      spec: schedulingFailurePackage(),
    },
  ]);
}

async function seedSchedulingQueues(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(schedulerQueues).where(inArray(schedulerQueues.queueId, QUEUE_IDS));
  const [agent] = await dbHandle
    .select({ providerOrgId: agents.providerOrgId })
    .from(agents)
    .where(eq(agents.agentId, stack.agentId))
    .limit(1);
  if (!agent) {
    throw new Error(`Agent ${stack.agentId} was not registered before queue seed`);
  }
  providerOrgId = agent.providerOrgId ?? (await createProviderOrg(dbHandle));
  if (!agent.providerOrgId) {
    await dbHandle.update(agents).set({ providerOrgId }).where(eq(agents.agentId, stack.agentId));
  }
  await dbHandle.insert(schedulerQueues).values({
    queueId: DISABLED_QUEUE_ID,
    name: "Disabled E2E Queue",
    providerOrgId,
    visibleOrgIds: [],
    agentId: stack.agentId,
    schedulerType: "slurm",
    queueName: "disabled",
    qos: null,
    enabled: false,
    policyTags: [],
  });
  await dbHandle.insert(schedulerQueues).values({
    queueId: PREFERRED_QUEUE_ID,
    name: "Preferred E2E Queue",
    providerOrgId,
    visibleOrgIds: [],
    agentId: stack.agentId,
    schedulerType: "slurm",
    queueName: preferredQueueName,
    qos: null,
    enabled: true,
    policyTags: [],
  });
  await dbHandle.insert(schedulerQueues).values({
    queueId: MISMATCH_QUEUE_ID,
    name: "Missing Partition E2E Queue",
    providerOrgId,
    visibleOrgIds: [],
    agentId: stack.agentId,
    schedulerType: "slurm",
    queueName: MISSING_PARTITION,
    qos: null,
    enabled: true,
    policyTags: [],
  });
  await dbHandle.insert(schedulerQueues).values({
    queueId: MISSING_QOS_QUEUE_ID,
    name: "Missing QoS E2E Queue",
    providerOrgId,
    visibleOrgIds: [],
    agentId: stack.agentId,
    schedulerType: "slurm",
    queueName: preferredQueueName,
    qos: MISSING_QOS,
    enabled: true,
    policyTags: [],
  });
}

async function detectSlurmPartition(): Promise<string> {
  const result = await stack.slurm.exec(["sinfo", "-h", "-o", "%P"]);
  const partition = result.stdout.trim().split(/\s+/)[0]?.replace("*", "");
  if (!partition) {
    throw new Error(
      `Unable to detect Slurm partition from sinfo:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return partition;
}

async function resolveAdminUserId(): Promise<string> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "admin@e2e.test"))
    .limit(1);
  if (!admin) {
    throw new Error("E2E admin user was not created by stack login");
  }
  return admin.id;
}

async function denyStackAgentForAdminUser(): Promise<void> {
  await clearAdminUserPreference();
  await db.insert(schedulingPreferences).values({
    scope: "user",
    scopeId: adminUserId,
    name: "workflow-scheduling-e2e-deny-agent",
    spec: { sitePolicy: { deniedAgents: [stack.agentId] } },
  });
}

async function clearAdminUserPreference(): Promise<void> {
  await db
    .delete(schedulingPreferences)
    .where(
      and(eq(schedulingPreferences.scope, "user"), eq(schedulingPreferences.scopeId, adminUserId)),
    );
}

async function createProviderOrg(dbHandle: PgDb): Promise<string> {
  const [org] = await dbHandle.insert(orgs).values({ name: "workflow-scheduling-e2e" }).returning({
    id: orgs.id,
  });
  if (!org) {
    throw new Error("Failed to create provider org for scheduling E2E");
  }
  return org.id;
}

function schedulingFailurePackage(): usecase.UsecasePackage {
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
    valueOutputs: [
      {
        descriptor: "value",
        type: "int",
        from: { collectedOutDescriptor: "stdout" },
        extract: { kind: "Regex", pattern: "value=([0-9]+)", group: 1 },
      },
    ],
  });
}

function disabledQueueWorkflow(): string {
  return JSON.stringify(
    {
      name: "workflow_disabled_queue_e2e",
      description: "A node with a Manual queue that is disabled.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "needs_queue",
            name: "needs_queue",
            usecaseVersionId: SCHEDULING_FAILURE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            schedulingStrategy: { type: "Manual", queues: [DISABLED_QUEUE_ID] },
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString('printf "value=1\\n"') },
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

function preferredQueueWorkflow(): string {
  return JSON.stringify(
    {
      name: "workflow_preferred_queue_e2e",
      description: "A node with an available Prefer queue.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "prefers_queue",
            name: "prefers_queue",
            usecaseVersionId: SCHEDULING_FAILURE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            schedulingStrategy: { type: "Prefer", queues: [PREFERRED_QUEUE_ID] },
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString('printf "value=7\\n"') },
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

function preferredQueueFallbackWorkflow(): string {
  return JSON.stringify(
    {
      name: "workflow_preferred_queue_fallback_e2e",
      description: "A node with multiple Prefer queues where the first is unavailable.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "prefer_fallback",
            name: "prefer_fallback",
            usecaseVersionId: SCHEDULING_FAILURE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            schedulingStrategy: { type: "Prefer", queues: [DISABLED_QUEUE_ID, PREFERRED_QUEUE_ID] },
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString('printf "value=9\\n"') },
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

function missingPartitionWorkflow(): string {
  return JSON.stringify(
    {
      name: "workflow_missing_partition_e2e",
      description: "A node with a Manual queue whose Slurm partition does not exist.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "bad_partition",
            name: "bad_partition",
            usecaseVersionId: SCHEDULING_FAILURE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            schedulingStrategy: { type: "Manual", queues: [MISMATCH_QUEUE_ID] },
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString('printf "value=11\\n"') },
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

function missingQosWorkflow(): string {
  return JSON.stringify(
    {
      name: "workflow_qos_queue_e2e",
      description: "A node with a Manual queue whose QoS should reach the scheduler script.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "qos_queue",
            name: "qos_queue",
            usecaseVersionId: SCHEDULING_FAILURE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            schedulingStrategy: { type: "Manual", queues: [MISSING_QOS_QUEUE_ID] },
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: {
                  expr: celString(
                    'scontrol write batch_script "$SLURM_JOB_ID" "/var/tmp/kq-slurm-shared/qos-${SLURM_JOB_ID}.sh" && printf "value=13\\n"',
                  ),
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

function preferenceDeniedManualQueueWorkflow(): string {
  return JSON.stringify(
    {
      name: "workflow_preference_denied_queue_e2e",
      description: "A node with an available Manual queue whose agent is denied by preference.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "preference_conflict",
            name: "preference_conflict",
            usecaseVersionId: SCHEDULING_FAILURE_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            schedulingStrategy: { type: "Manual", queues: [PREFERRED_QUEUE_ID] },
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString('printf "value=15\\n"') },
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
  const dir = mkdtempSync(join(tmpdir(), "kq-scheduling-failure-workflow-"));
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
