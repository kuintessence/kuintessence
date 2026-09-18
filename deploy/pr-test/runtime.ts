import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const JobSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  schedulerJobId: z.string().nullable(),
});
const OperationSchema = z.object({
  status: z.string(),
  error: z.string().nullable(),
});

export async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (ready(value)) return value;
    await Bun.sleep(1000);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

export function schedulerCancelled(scheduler: "slurm" | "pbs", stdout: string): boolean {
  if (scheduler === "slurm") return /\bJobState=CANCELLED\b/.test(stdout);
  const result = z
    .object({
      Jobs: z.record(
        z.string(),
        z.object({ job_state: z.string(), Exit_status: z.number().optional() }),
      ),
    })
    .parse(JSON.parse(stdout));
  const jobs = Object.values(result.Jobs);
  return (
    jobs.length === 1 &&
    jobs[0]?.job_state === "F" &&
    jobs[0].Exit_status !== undefined &&
    jobs[0].Exit_status !== 0
  );
}

async function main() {
  assert.equal(process.env.KQ_PR_TEST, "1", "Only run inside the disposable PR test container");
  assert.equal(process.env.SERVER_HTTP_URL, "http://server:3000");
  const scheduler = z.enum(["slurm", "pbs"]).parse(process.env.KQ_PR_SCHEDULER);
  const base = "http://server:3000/api";
  let token = "";

  async function request(path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Idempotency-Key": randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // Response bodies may contain credentials; never include them in failures.
    assert(response.ok, `${path}: HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }

  token = z
    .object({ token: z.string().min(1) })
    .parse(
      await request("/auth/login", {
        email: "scheduler-compose-seed@kuintessence.test",
        role: "platform_admin",
      }),
    ).token;
  await waitFor(
    "Agent control channel",
    async () =>
      z
        .object({
          agents: z.array(z.object({ agentId: z.string(), controlChannelOnline: z.boolean() })),
        })
        .parse(await request("/cp/software/overview")),
    (value) =>
      value.agents.some((agent) => agent.agentId === "pr-scheduler" && agent.controlChannelOnline),
  );
  const context = z
    .object({ providerOrgs: z.array(z.object({ id: z.string().uuid(), name: z.string() })) })
    .parse(await request("/cp/agent-registration-context"));
  const provider = context.providerOrgs.find((org) => org.name === "Development Compute Provider");
  assert(provider, "Development provider was not initialized");
  const queueId = randomUUID();
  await request("/admin/queues", {
    queueId,
    name: `PR ${scheduler}`,
    providerOrgId: provider.id,
    visibleOrgIds: [provider.id],
    agentId: "pr-scheduler",
    schedulerType: scheduler === "pbs" ? "pbs-pro" : "slurm",
    queueName: scheduler === "pbs" ? "workq" : "debug",
    enabled: true,
    qos: null,
    policyTags: [],
  });

  const job = (id: string) => request(`/jobs/${id}`).then((value) => JobSchema.parse(value));
  async function submit(command: string) {
    return JobSchema.parse(
      await request("/jobs", {
        name: `pr_${scheduler}_smoke`,
        command,
        resources: { cpus: 1, memoryMb: 128, wallTimeSec: 180 },
        schedulingStrategy: { queueId },
      }),
    );
  }
  const marker = `kq-pr-${scheduler}-completed`;
  const completed = await submit(`printf '${marker}\\n'`);
  const final = await waitFor(
    "completed scheduler job",
    () => job(completed.id),
    (value) => ["completed", "failed", "cancelled"].includes(value.status),
  );
  assert.equal(final.status, "completed");
  assert(final.schedulerJobId, "Agent did not return a real scheduler job ID");
  await waitFor(
    "job stdout via Server",
    async () =>
      z.object({ text: z.string() }).parse(await request(`/jobs/${completed.id}/logs?lines=50`)),
    (value) => value.text.includes(marker),
  );
  console.log(`${scheduler}: Server -> Agent -> scheduler completion and logs passed`);

  const cancellable = await submit("sleep 150");
  try {
    const running = await waitFor(
      "running cancellable job",
      () => job(cancellable.id),
      (value) => {
        assert(!["failed", "completed", "cancelled"].includes(value.status));
        return value.status === "running" && value.schedulerJobId !== null;
      },
    );
    assert(running.schedulerJobId);
    await request(`/jobs/${cancellable.id}/cancel`, {});
    await waitFor(
      "Server cancellation",
      () => job(cancellable.id),
      (v) => v.status === "cancelled",
    );
    const args =
      scheduler === "slurm"
        ? ["show", "job", running.schedulerJobId, "-o"]
        : ["-x", "-f", "-F", "json", running.schedulerJobId];
    await waitFor(
      "native scheduler cancellation",
      async () => {
        const result = await execute(scheduler === "slurm" ? "scontrol" : "qstat", args, {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        return schedulerCancelled(scheduler, result.stdout);
      },
      Boolean,
    );
  } finally {
    // The Compose entry point also destroys the whole isolated stack on failure.
    const current = await job(cancellable.id);
    if (!["completed", "failed", "cancelled"].includes(current.status)) {
      await request(`/jobs/${cancellable.id}/cancel`, {});
    }
  }
  console.log(`${scheduler}: Server and native scheduler cancellation passed`);

  const install = OperationSchema.parse(
    await request("/cp/software/operations", {
      agentId: "pr-scheduler",
      action: "install",
      spec: "zlib@1.3.1",
    }),
  );
  assert.equal(install.status, "rejected");
  assert.match(install.error ?? "", /unmanaged installation is disabled/);
  console.log("Spack: unconfigured material delivery correctly rejects installation");
}

if (import.meta.main) await main();
