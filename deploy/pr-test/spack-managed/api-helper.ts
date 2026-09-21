import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JobStatus, JobSubmitSchema } from "@kuintessence/shared";
import { z } from "zod";
import { queueInventoryReady, waitFor } from "../runtime";
import { jsonRequest, OperationSchema } from "../spack-case/api";
import { diagnoseManagedQueue, managedQueueMarker } from "./queue-diagnostic";

const origin = "https://server:3443";
const agentId = "pr-scheduler";
const operationTimeoutMs = 15 * 60_000;
const ActionSchema = z.enum(["install", "import_preinstalled", "load", "uninstall"]);
const TerminalStatusSchema = z.enum(["succeeded", "failed", "rejected"]);
const ManagedOperationSchema = OperationSchema.extend({
  agentId: z.string(),
  action: ActionSchema,
  spec: z.string(),
  stdout: z.string().nullable(),
});
// CP overview exposes spec strings, not InstalledSpec objects or readiness states.
const OverviewSchema = z.object({
  agents: z.array(
    z.object({
      agentId: z.string(),
      controlChannelOnline: z.boolean(),
      installedCount: z.number().int().nonnegative(),
      installedSpecs: z.array(z.string()),
    }),
  ),
});
const JobSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(JobStatus),
  schedulerJobId: z.string().nullable(),
});
const terminalOperation = (status: z.infer<typeof OperationSchema>["status"]) =>
  status === "succeeded" || status === "failed" || status === "rejected";
const terminalJob = (status: z.infer<typeof JobSchema>["status"]) =>
  status === JobStatus.COMPLETED || status === JobStatus.FAILED || status === JobStatus.CANCELLED;

export function managedApi(token: string) {
  const request = (path: string, body?: unknown) => jsonRequest(origin, token, path, body);
  const overview = async () => OverviewSchema.parse(await request("/cp/software/overview"));
  const job = async (id: string) => JobSchema.parse(await request(`/jobs/${id}`));

  async function online() {
    await waitFor(
      "managed Agent control channel",
      overview,
      (view) =>
        view.agents.some((agent) => agent.agentId === agentId && agent.controlChannelOnline),
    );
  }

  async function inventory(spec: string, present: boolean) {
    await waitFor(
      "managed software ledger",
      overview,
      (view) => {
        const agent = view.agents.find((item) => item.agentId === agentId);
        return (
          agent !== undefined &&
          agent.controlChannelOnline &&
          agent.installedCount === agent.installedSpecs.length &&
          agent.installedSpecs.includes(spec) === present
        );
      },
    );
  }

  async function operation(
    action: z.infer<typeof ActionSchema>,
    spec: string,
    options: { expectedStatus?: z.infer<typeof TerminalStatusSchema> } = {},
  ) {
    const expectedStatus = TerminalStatusSchema.parse(options.expectedStatus ?? "succeeded");
    // Bound the whole request/poll cycle, including an in-flight helper HTTP request.
    // The entry point exits on failure so no abandoned poll survives the deadline.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Managed operation deadline exceeded")),
        operationTimeoutMs,
      );
    });
    try {
      return await Promise.race([
        (async () => {
          const created = ManagedOperationSchema.parse(
            await request("/cp/software/operations", { agentId, action, spec }),
          );
          assert(
            created.agentId === agentId && created.action === action && created.spec === spec,
            "Managed operation request identity mismatch",
          );
          const completed = terminalOperation(created.status)
            ? created
            : await waitFor(
                "managed software operation terminal status",
                async () => {
                  const page = z
                    .object({ items: z.array(ManagedOperationSchema) })
                    .parse(
                      await request("/cp/software/operations?agentId=pr-scheduler&limit=500"),
                    );
                  const item = page.items.find((entry) => entry.id === created.id);
                  assert(item, "Managed operation disappeared");
                  assert(
                    item.agentId === agentId && item.action === action && item.spec === spec,
                    "Managed operation history identity mismatch",
                  );
                  return item;
                },
                (item) => terminalOperation(item.status),
                operationTimeoutMs,
              );
          console.log(`Spack managed operation: action=${action} status=${completed.status}`);
          if (completed.status !== expectedStatus) {
            const detail = `${completed.error ?? ""}\n${completed.stderr ?? ""}`;
            for (const [category, text] of [
              ["download", "Spack material preparation failed"],
              ["preflight", "preflight failed"],
              ["source-audit", "Spack source audit"],
              ["managed-worker", "Managed Spack operation failed"],
              ["inventory-refresh", "installed inventory refresh failed"],
              ["verification", "Managed Spack verification failed"],
            ] as const) {
              if (detail.includes(text)) console.error(`Managed failure category: ${category}`);
            }
          }
          assert(
            completed.status === expectedStatus,
            "Managed operation returned an unexpected terminal status",
          );
          return completed;
        })(),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readyQueue() {
    let previous: string | undefined;
    let observations = 0;
    try {
      await waitFor(
        "managed Slurm queue inventory",
        async () => {
          const value = await request("/admin/agents/pr-scheduler/queue-inventory");
          const marker = managedQueueMarker(value);
          if (marker !== previous && observations < 8) {
            console.log(marker);
            previous = marker;
            observations++;
          }
          return value;
        },
        (value) => queueInventoryReady(value, "debug"),
      );
    } catch (error) {
      await diagnoseManagedQueue();
      throw error;
    }
  }

  async function createQueue() {
    await readyQueue();
    const context = z
      .object({
        providerOrgs: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
      })
      .parse(await request("/cp/agent-registration-context"));
    const provider = context.providerOrgs.find((org) => org.name === "Development Compute Provider");
    assert(provider, "Development provider was not initialized");
    const queueId = randomUUID();
    await request("/admin/queues", {
      queueId,
      name: `PR managed GNU Hello ${queueId}`,
      providerOrgId: provider.id,
      visibleOrgIds: [provider.id],
      agentId,
      schedulerType: "slurm",
      queueName: "debug",
      enabled: true,
      qos: null,
      policyTags: [],
    });
    return queueId;
  }

  async function hello(queueId: string, prefix: string, shell: string) {
    assert(
      shell.trim().length > 0 && shell.length <= 256 * 1024 && !shell.includes("\0"),
      "Managed load did not return a usable shell",
    );
    await readyQueue();
    const created = JobSchema.parse(
      await request(
        "/jobs",
        JobSubmitSchema.parse({
          name: "pr_spack_managed_hello",
          // Reset PATH so neither a distro Hello nor a previous load can satisfy this job.
          command: [
            "set -eu",
            "export PATH=/usr/bin:/bin",
            "unset SPACK_LOADED_HASHES",
            shell,
            `test "$(command -v hello)" = '${prefix}/bin/hello'`,
            "LC_ALL=C hello",
          ].join("\n"),
          resources: { cpus: 1, memoryMb: 128, wallTimeSec: 60 },
          schedulingStrategy: { queueId },
        }),
      ),
    );
    let terminal = terminalJob(created.status);
    try {
      const completed = await waitFor(
        "managed GNU Hello Slurm job",
        () => job(created.id),
        (value) => terminalJob(value.status),
      );
      terminal = true;
      console.log(`Spack managed job: status=${completed.status}`);
      assert(completed.status === JobStatus.COMPLETED, "Managed GNU Hello job did not complete");
      assert(
        completed.schedulerJobId !== null && /^[1-9][0-9]*$/.test(completed.schedulerJobId),
        "Managed GNU Hello job did not receive a Slurm job ID",
      );
      await waitFor(
        "managed GNU Hello stdout through Server",
        async () =>
          z.object({ text: z.string() }).parse(await request(`/jobs/${created.id}/logs?lines=50`)),
        (value) => /(?:^|\n)Hello, world!\r?(?:\n|$)/.test(value.text),
      );
    } finally {
      if (!terminal) {
        const current = await job(created.id);
        if (!terminalJob(current.status)) await request(`/jobs/${created.id}/cancel`, {});
      }
    }
  }

  return { online, inventory, operation, createQueue, hello };
}
