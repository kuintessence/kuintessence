import {
  workflowConsumerOrgTuple,
  workflowOwnerTuple,
  workflowPlatformTuple,
} from "../authz/projection";
import type { AuthzService } from "../authz/service";

export async function registerWorkflowAuthorization(
  authz: AuthzService | undefined,
  workflowId: string,
  userId: string,
  orgId: string | null,
): Promise<void> {
  const tuples = [workflowOwnerTuple({ workflowId, userId }), workflowPlatformTuple(workflowId)];
  if (orgId) tuples.push(workflowConsumerOrgTuple({ workflowId, orgId }));
  if (authz?.mode === "enforce") {
    await authz.writeRelationships(tuples);
  }
  await authz?.enqueueMany(tuples);
}
