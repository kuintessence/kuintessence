import { createHash, randomUUID } from "node:crypto";
import { type PgTransaction, workflowExecutionDelegations, workflowRuns } from "@kuintessence/db";
import { type NodeInvocation, WorkflowExecutionInterrupted } from "@kuintessence/shared";
import {
  type FederationDelegation,
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import type { FederationWorkflowMarket } from "@kuintessence/shared/federation/market";
import { and, eq } from "drizzle-orm";
import type { LeasedWorkflowJournal } from "../workflow/execution-journal";
import { type FederationActor, requireFederationCapability } from "./permissions";
import type { FederationStorageGuard } from "./storage-capacity";

export type WorkflowDelegationPlan = Omit<
  FederationDelegation,
  "operationId" | "taskId" | "attempt" | "issuedAt" | "expiresAt"
>;

/** Internal runner boundary: the stored submitter and organization must match, even on replay. */
export async function assertWorkflowDelegationOwner(
  tx: PgTransaction,
  runId: string,
  actor: FederationActor,
) {
  const [run] = await tx
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .for("update");
  if (
    !run ||
    run.submittedBy !== actor.userId ||
    run.input?.orgId !== actor.orgId ||
    run.input.executionModel !== "durable-v2" ||
    run.input.federationReservationId
  )
    throw new FederationError("POLICY_DENIED");
  return run;
}

export async function assertWorkflowDelegationBinding(
  tx: PgTransaction,
  runId: string,
  actor: FederationActor,
  localSiteId: string,
  operationId: string,
) {
  await assertWorkflowDelegationOwner(tx, runId, actor);
  const [binding] = await tx
    .select()
    .from(workflowExecutionDelegations)
    .where(
      and(
        eq(workflowExecutionDelegations.runId, runId),
        eq(workflowExecutionDelegations.localSiteId, localSiteId),
        eq(workflowExecutionDelegations.operationId, operationId),
      ),
    );
  if (!binding) throw new FederationError("POLICY_DENIED");
  return binding;
}

/** Source workflow cancellation fences new institutional actions, even before an outbound exists. */
export async function assertWorkflowRequestActive(
  tx: PgTransaction,
  siteId: string,
  orgId: string,
  request: FederationDelegation,
) {
  const [binding] = await tx
    .select()
    .from(workflowExecutionDelegations)
    .where(
      and(
        eq(workflowExecutionDelegations.localSiteId, siteId),
        eq(workflowExecutionDelegations.operationId, request.operationId),
      ),
    );
  if (!binding) return;
  const [run] = await tx
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, binding.runId))
    .for("update");
  if (
    !run ||
    run.input?.orgId !== orgId ||
    run.input.executionModel !== "durable-v2" ||
    run.input.federationReservationId ||
    request.senderSiteId !== siteId ||
    federationCanonicalJson(binding.request) !== federationCanonicalJson(request)
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (run.status === "cancelling" || run.status === "cancelled")
    throw new FederationError("CANCELLATION_REQUESTED");
  if (run.status !== "running") throw new FederationError("POLICY_DENIED");
}

/** Check before capturing files or deriving materials; exact intent is checked again when binding. */
export async function assertWorkflowDelegationCapacity(
  lease: LeasedWorkflowJournal,
  actor: FederationActor,
  nodeId: string,
  invocation: NodeInvocation,
  plan: WorkflowDelegationPlan,
  guard?: Pick<FederationStorageGuard, "assertAdmission">,
) {
  if (!guard) return;
  if (!invocation.path) throw new FederationError("INVALID_MESSAGE");
  const path = invocation.path;
  const pathHash = createHash("sha256").update(path).digest("hex");
  await lease.transaction(async (tx) => {
    await assertWorkflowDelegationOwner(tx, lease.runId, actor);
    await requireFederationCapability(tx, actor, "delegation.submit");
    const [existing] = await tx
      .select()
      .from(workflowExecutionDelegations)
      .where(
        and(
          eq(workflowExecutionDelegations.runId, lease.runId),
          eq(workflowExecutionDelegations.pathHash, pathHash),
        ),
      );
    if (existing) {
      if (
        existing.path !== path ||
        existing.nodeId !== nodeId ||
        existing.localSiteId !== plan.senderSiteId
      )
        throw new FederationError("OPERATION_CONFLICT");
      return;
    }
    await guard.assertAdmission(plan.mode);
  });
}

export async function bindWorkflowDelegation(
  lease: LeasedWorkflowJournal,
  actor: FederationActor,
  nodeId: string,
  invocation: NodeInvocation,
  plan: WorkflowDelegationPlan,
  admissionWindowSec: number,
  clock: () => Date,
  market?: FederationWorkflowMarket,
  storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
) {
  const path = invocation.path;
  if (!path || Buffer.byteLength(path) > 16_384 || !nodeId || Buffer.byteLength(nodeId) > 1024)
    throw new WorkflowExecutionInterrupted("Invalid durable delegation invocation", {
      retryable: false,
    });
  if (!Number.isInteger(admissionWindowSec) || admissionWindowSec < 1 || admissionWindowSec > 3600)
    throw new FederationError("INVALID_MESSAGE");
  const encoded = federationCanonicalJson({
    plan,
    admissionWindowSec,
    ...(market ? { market } : {}),
  });
  if (Buffer.byteLength(encoded) > 256 * 1024) throw new FederationError("INVALID_MESSAGE");
  const pathHash = createHash("sha256").update(path).digest("hex");
  const intentDigest = createHash("sha256").update(encoded).digest("hex");
  const snapshot: { plan: WorkflowDelegationPlan } = JSON.parse(encoded);
  return lease.transaction(async (tx) => {
    await assertWorkflowDelegationOwner(tx, lease.runId, actor);
    await requireFederationCapability(tx, actor, "delegation.submit");
    const [existing] = await tx
      .select()
      .from(workflowExecutionDelegations)
      .where(
        and(
          eq(workflowExecutionDelegations.runId, lease.runId),
          eq(workflowExecutionDelegations.pathHash, pathHash),
        ),
      );
    if (existing) {
      if (
        existing.path !== path ||
        existing.nodeId !== nodeId ||
        existing.intentDigest !== intentDigest
      )
        throw new WorkflowExecutionInterrupted(
          "Workflow invocation changed its delegation intent",
          { retryable: false },
        );
      return existing.request;
    }
    await storageGuard?.assertAdmission(plan.mode);
    const now = clock();
    const request = FederationDelegationSchema.parse({
      ...snapshot.plan,
      operationId: randomUUID(),
      taskId: randomUUID(),
      attempt: 1,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + admissionWindowSec * 1000).toISOString(),
    });
    await tx.insert(workflowExecutionDelegations).values({
      runId: lease.runId,
      pathHash,
      path,
      nodeId,
      localSiteId: request.senderSiteId,
      operationId: request.operationId,
      intentDigest,
      request,
    });
    return request;
  });
}
