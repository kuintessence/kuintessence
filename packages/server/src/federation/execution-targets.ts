import { agents, type PgDb, type PgTransaction, schedulerQueues } from "@kuintessence/db";
import { WorkflowExecutionInterrupted } from "@kuintessence/shared";
import {
  type FederationExecutionTarget,
  FederationExecutionTargetSchema,
} from "@kuintessence/shared/federation";
import { and, eq, inArray } from "drizzle-orm";
import type { QueueAccessContext, QueueRegistryService } from "../services/queue-registry";

export function requireFederationTargets(
  targets: readonly FederationExecutionTarget[] | undefined,
) {
  if (!targets?.length)
    throw new WorkflowExecutionInterrupted(
      "Federation agreement lacks an approved execution target",
      { retryable: false },
    );
  return targets.map((target) => FederationExecutionTargetSchema.parse(target));
}

/** Local visibility and dispatch authorization still apply to every signed target. */
export async function resolveFederationTargets(
  db: PgDb,
  registry: Pick<QueueRegistryService, "inspectPreferredForSubmit">,
  targets: readonly FederationExecutionTarget[],
  principal: QueueAccessContext,
) {
  const allowed = requireFederationTargets(targets);
  const before = new Map(
    (
      await db
        .select()
        .from(schedulerQueues)
        .where(
          inArray(
            schedulerQueues.queueId,
            allowed.map((target) => target.queueId),
          ),
        )
    ).map((queue) => [queue.queueId, JSON.stringify(queue)]),
  );
  const resolved = await registry.inspectPreferredForSubmit(
    allowed.map((target) => target.queueId),
    principal,
  );
  const selections = [];
  for (const selection of resolved.selections) {
    const target = allowed.find((item) => item.queueId === selection.queueId);
    if (!target) continue;
    const [row] = await db
      .select({ agent: agents, queue: schedulerQueues })
      .from(schedulerQueues)
      .innerJoin(agents, eq(agents.agentId, schedulerQueues.agentId))
      .where(eq(schedulerQueues.queueId, target.queueId));
    if (
      row &&
      JSON.stringify(row.queue) === before.get(target.queueId) &&
      row.agent.status === "online" &&
      matchesFederationTarget(target, row.agent, row.queue) &&
      selection.agentId === target.agentId &&
      selection.schedulerType === row.agent.schedulerType
    )
      selections.push({ ...selection, targetUpdatedAt: row.queue.updatedAt });
  }
  return { ...resolved, selections };
}

/** Caller keeps this transaction open through the installation/compute channel enqueue. */
export async function lockFederationTarget(
  tx: PgTransaction,
  targets: readonly FederationExecutionTarget[],
  input: {
    agentId: string;
    queueId?: string | null;
    targetMode?: string | null;
    queueName?: string | null;
    qos?: string | null;
    updatedAt?: Date;
    running?: boolean;
  },
) {
  const allowed = requireFederationTargets(targets).filter(
    (target) =>
      target.agentId === input.agentId && (!input.queueId || target.queueId === input.queueId),
  );
  for (const target of allowed) {
    const [row] = await tx
      .select({ agent: agents, queue: schedulerQueues })
      .from(schedulerQueues)
      .innerJoin(agents, eq(agents.agentId, schedulerQueues.agentId))
      .where(and(eq(schedulerQueues.queueId, target.queueId), eq(agents.agentId, input.agentId)))
      .for("share", { of: [agents, schedulerQueues] });
    if (
      !row ||
      (!input.running && row.agent.status !== "online") ||
      !matchesFederationTarget(target, row.agent, row.queue)
    )
      continue;
    if (input.updatedAt && row.queue.updatedAt.getTime() !== input.updatedAt.getTime()) continue;
    if (input.targetMode !== undefined && row.queue.targetMode !== input.targetMode) continue;
    if (
      input.queueName !== undefined &&
      row.queue.targetMode === "named" &&
      row.queue.queueName !== input.queueName
    )
      continue;
    if (input.qos !== undefined && (row.queue.qos ?? "") !== (input.qos ?? "")) continue;
    return target;
  }
  throw new WorkflowExecutionInterrupted("Federation execution target is no longer authorized", {
    retryable: false,
  });
}

export function matchesFederationTarget(
  target: FederationExecutionTarget,
  agent: typeof agents.$inferSelect,
  queue: typeof schedulerQueues.$inferSelect,
) {
  return (
    agent.agentId === target.agentId &&
    agent.providerOrgId === target.providerOrgId &&
    agent.clusterId === target.clusterId &&
    queue.providerOrgId === target.providerOrgId &&
    queue.agentId === target.agentId &&
    queue.enabled &&
    queue.schedulerType === agent.schedulerType
  );
}
