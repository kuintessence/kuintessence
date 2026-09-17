import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "bun";
import { eq, inArray } from "drizzle-orm";
import { GenericContainer, Wait } from "testcontainers";
import {
  agents,
  createPgDb,
  jobs,
  type PgDb,
  schedulerQueues,
  usecasePackages,
  userOrgMemberships,
  users,
} from "../../packages/db/src";
import type { usecase } from "../../packages/shared/src";
import { governedShellPackage, seedE2eSoftwareRevision } from "./fixtures/governed-package";
import { type Stack, startStack } from "./fixtures/stack";
import { waitForTcp } from "./fixtures/util";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const AUTHZ_PKG_ID = "77777777-7777-4777-8777-777777777101";
const SOFTWARE_ID = "77777777-7777-4777-8777-777777777201";
const AUTHZ_DENIED_QUEUE_ID = "77777777-7777-4777-8777-777777777301";
const PACKAGE_IDS = [AUTHZ_PKG_ID];
const QUEUE_IDS = [AUTHZ_DENIED_QUEUE_ID];
const SPICEDB_TOKEN = "local-dev-authz";
const USER_EMAIL = "workflow-authz-user@e2e.test";

let stack: Stack;
let db: PgDb;
let spicedb: { stop(): Promise<unknown>; getHost(): string; getMappedPort(port: number): number };
let userToken: string;
let userOrgId: string;
let preferredQueueName: string;
const workflowDirs: string[] = [];

beforeAll(async () => {
  spicedb = await startSpiceDb();
  const spicedbEndpoint = `${spicedb.getHost()}:${spicedb.getMappedPort(50051)}`;
  stack = await startStack({
    serverEnv: {
      AUTHZ_MODE: "enforce",
      AUTHZ_SPICEDB_ENDPOINT: spicedbEndpoint,
      AUTHZ_SPICEDB_TOKEN: SPICEDB_TOKEN,
      AUTHZ_OUTBOX_INTERVAL_SEC: "1",
      AUTHZ_OUTBOX_BATCH_SIZE: "1000",
    },
  });
  db = createPgDb(stack.databaseUrl);
  preferredQueueName = await detectSlurmPartition();
  userToken = await loginUser(USER_EMAIL, "user");
  userOrgId = await resolveUserOrgId(USER_EMAIL);
  await seedPackage(db);
  await seedQueue(db);
}, 300_000);

afterAll(async () => {
  await stack?.stop();
  for (const dir of workflowDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  await spicedb?.stop();
});

describe("e2e: workflow queue authorization through real SpiceDB", () => {
  test("fails a Manual queue node when SpiceDB denies queue#submit", async () => {
    const yamlPath = writeWorkflowYaml(authzDeniedWorkflow());

    const submit = await runCli(["workflow", "submit", yamlPath]);
    expect(submit.stderr).toBe("");
    const runId = parseRunId(submit.stdout);
    const final = await pollWorkflow(runId, "failed", 120_000, userToken);

    expect(final.status).toBe("failed");
    expect(final.result?.status.authz_denied).toBe("Failed");
    expect(final.result?.values.authz_denied?.values).toEqual({});

    const stepJobId = final.stepJobs.authz_denied;
    expect(stepJobId).toMatch(/^[0-9a-f-]{36}$/);
    const [job] = await db
      .select({ status: jobs.status, schedulerJobId: jobs.schedulerJobId })
      .from(jobs)
      .where(eq(jobs.id, stepJobId))
      .limit(1);
    expect(job?.status).toBe("failed");
    expect(job?.schedulerJobId).toBeNull();

    const status = await runCli(["workflow", "status", runId]);
    expect(status.stdout).toContain("authz_denied: Failed");
  }, 180_000);
});

async function startSpiceDb(): Promise<{
  stop(): Promise<unknown>;
  getHost(): string;
  getMappedPort(port: number): number;
}> {
  const container = await new GenericContainer("authzed/spicedb:v1.54.0")
    .withCommand(["serve", "--grpc-preshared-key", SPICEDB_TOKEN, "--datastore-engine", "memory"])
    .withExposedPorts(50051)
    .withWaitStrategy(Wait.forLogMessage("grpc server started serving"))
    .withStartupTimeout(60_000)
    .start();
  await waitForTcp(container.getHost(), container.getMappedPort(50051), 30_000);
  return container;
}

async function loginUser(email: string, role: "user"): Promise<string> {
  const res = await fetch(`${stack.serverBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) {
    throw new Error(`user login failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function resolveUserOrgId(email: string): Promise<string> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    throw new Error(`User ${email} was not created by dev login`);
  }
  const [membership] = await db
    .select({ orgId: userOrgMemberships.orgId })
    .from(userOrgMemberships)
    .where(eq(userOrgMemberships.userId, user.id))
    .limit(1);
  if (!membership) {
    throw new Error(`User ${email} has no default org membership`);
  }
  return membership.orgId;
}

async function seedPackage(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(usecasePackages).where(inArray(usecasePackages.id, PACKAGE_IDS));
  await seedE2eSoftwareRevision(dbHandle, SOFTWARE_ID);
  await dbHandle.insert(usecasePackages).values([
    {
      id: AUTHZ_PKG_ID,
      name: "mock-bash-authz-denied",
      version: "1",
      spec: authzPackage(),
    },
  ]);
}

async function seedQueue(dbHandle: PgDb): Promise<void> {
  await dbHandle.delete(schedulerQueues).where(inArray(schedulerQueues.queueId, QUEUE_IDS));
  await dbHandle
    .update(agents)
    .set({ providerOrgId: userOrgId })
    .where(eq(agents.agentId, stack.agentId));
  await dbHandle.insert(schedulerQueues).values({
    queueId: AUTHZ_DENIED_QUEUE_ID,
    name: "SpiceDB Denied E2E Queue",
    providerOrgId: userOrgId,
    visibleOrgIds: [userOrgId],
    agentId: stack.agentId,
    schedulerType: "slurm",
    queueName: preferredQueueName,
    qos: null,
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

function authzPackage(): usecase.UsecasePackage {
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

function authzDeniedWorkflow(): string {
  return JSON.stringify(
    {
      name: "workflow_authz_denied_queue_e2e",
      description: "A node whose Manual queue is locally visible but denied by SpiceDB.",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "SoftwareUsecaseComputing",
            id: "authz_denied",
            name: "authz_denied",
            usecaseVersionId: AUTHZ_PKG_ID,
            softwareVersionId: SOFTWARE_ID,
            schedulingStrategy: { type: "Manual", queues: [AUTHZ_DENIED_QUEUE_ID] },
            inputSlots: [
              {
                type: "Text",
                descriptor: "script",
                from: { expr: celString('printf "value=17\\n"') },
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
  const dir = mkdtempSync(join(tmpdir(), "kq-workflow-authz-"));
  workflowDirs.push(dir);
  const path = join(dir, "workflow.yaml");
  writeFileSync(path, content);
  return path;
}

async function runCli(
  args: string[],
  token: string = userToken,
): Promise<{ stdout: string; stderr: string }> {
  const configDir = mkdtempSync(join(tmpdir(), "kq-workflow-authz-cli-run-"));
  const configFile = join(configDir, "config.json");
  writeFileSync(configFile, JSON.stringify({ serverUrl: stack.serverBaseUrl, token }));
  const proc = spawn(["bun", "run", join(REPO_ROOT, "packages/cli/src/index.ts"), ...args], {
    env: { ...process.env, KQ_CONFIG_FILE: configFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  rmSync(configDir, { recursive: true, force: true });
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
  token: string,
): Promise<WorkflowRunDetail> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowRunDetail | undefined;
  let lastErr: string | undefined;
  while (Date.now() < deadline) {
    const detail = await api<WorkflowRunDetail>(
      `/api/workflows/${runId}`,
      { method: "GET" },
      token,
    );
    if (!detail.ok) {
      lastErr = detail.error;
      await Bun.sleep(1000);
      continue;
    }
    last = detail.value;
    if (last.status === expectedStatus) {
      return last;
    }
    if (last.status === "completed" || last.status === "failed" || last.status === "cancelled") {
      throw new Error(`Workflow ${runId} ended with unexpected status: ${JSON.stringify(last)}`);
    }
    await Bun.sleep(1000);
  }
  throw new Error(
    `Workflow ${runId} did not reach ${expectedStatus}: ${JSON.stringify(last)}; lastErr=${lastErr}`,
  );
}

async function api<T>(
  path: string,
  init: RequestInit,
  token: string,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${stack.serverBaseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    return { ok: false, error: `${res.status} ${await res.text()}` };
  }
  return { ok: true, value: (await res.json()) as T };
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
