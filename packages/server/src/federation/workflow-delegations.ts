import { createHash, randomUUID } from "node:crypto";
import { type PgTransaction, workflowExecutionDelegations, workflowRuns } from "@kuintessence/db";
import { type NodeInvocation, WorkflowExecutionInterrupted } from "@kuintessence/shared";
import {
  type FederationDelegation,
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import type { LeasedWorkflowJournal } from "../workflow/execution-journal";
import { type FederationActor, requireFederationCapability } from "./permissions";

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

export async function bindWorkflowDelegation(
  lease: LeasedWorkflowJournal,
  actor: FederationActor,
  nodeId: string,
  invocation: NodeInvocation,
  plan: WorkflowDelegationPlan,
  admissionWindowSec: number,
  clock: () => Date,
) {
  const path = invocation.path;
  if (!path || Buffer.byteLength(path) > 16_384 || !nodeId || Buffer.byteLength(nodeId) > 1024)
    throw new WorkflowExecutionInterrupted("Invalid durable delegation invocation", {
      retryable: false,
    });
  if (!Number.isInteger(admissionWindowSec) || admissionWindowSec < 1 || admissionWindowSec > 3600)
    throw new FederationError("INVALID_MESSAGE");
  const encoded = federationCanonicalJson({ plan, admissionWindowSec });
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
