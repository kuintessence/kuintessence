import {
  agents,
  clusterFileRoots,
  dataAccessPolicies,
  dataAssets,
  dataGrants,
  jobs,
  netdriveFiles,
  orgs,
  type PgDb,
  schedulerQueues,
  softwareAssetGrants,
  softwareAssets,
  sshCredentials,
  sshRecordings,
  userCapabilities,
  userOrgMemberships,
  users,
  workflowRuns,
} from "@kuintessence/db";
import {
  agentPlatformTuple,
  agentProviderTuple,
  clusterFileRootPlatformTuple,
  clusterFileRootProviderTuple,
  clusterFileRootVisibleOrgTuple,
  dataAssetGrantTuples,
  dataAssetOwnerOrgTuple,
  dataAssetOwnerTuple,
  dataAssetPlatformTuple,
  dataAssetProviderTuple,
  dataAssetPublicTuples,
  jobConsumerOrgTuple,
  jobOwnerTuple,
  jobPlatformTuple,
  jobProviderTuple,
  jobQueueTuple,
  netdriveConsumerOrgTuple,
  netdriveOwnerTuple,
  netdrivePlatformTuple,
  organizationBaselineTuples,
  organizationMembershipTuple,
  platformAuditorTuple,
  platformMemberTuple,
  platformRoleTuple,
  queuePlatformTuple,
  queueProviderTuple,
  queueVisibleOrgTuple,
  softwareAssetGrantTuples,
  softwareAssetOwnerOrgTuple,
  softwareAssetOwnerTuple,
  softwareAssetPlatformTuple,
  softwareAssetProviderTuple,
  softwareAssetPublicGrantTuples,
  sshCredentialAgentTuple,
  sshCredentialPlatformTuple,
  sshRecordingActorTuple,
  sshRecordingAgentTuple,
  sshRecordingPlatformTuple,
  workflowConsumerOrgTuple,
  workflowOwnerTuple,
  workflowPlatformTuple,
} from "./projection";
import type { AuthzTuple } from "./service";

export interface AuthzRebuildPlan {
  tuples: AuthzTuple[];
  counts: Record<string, number>;
}

const MEMBERSHIP_ROLES = new Set(["owner", "admin", "operator", "member", "viewer"]);

export async function buildAuthzRebuildPlan(db: PgDb): Promise<AuthzRebuildPlan> {
  const now = new Date();
  const [
    orgRows,
    userRows,
    membershipRows,
    agentRows,
    queueRows,
    jobRows,
    fileRows,
    rootRows,
    assetRows,
    grantRows,
    credentialRows,
    recordingRows,
    workflowRows,
    capabilityRows,
    dataAssetRows,
    dataGrantRows,
    dataPolicyRows,
  ] = await Promise.all([
    db.select().from(orgs),
    db.select({ id: users.id, email: users.email, role: users.role }).from(users),
    db.select().from(userOrgMemberships),
    db.select().from(agents),
    db.select().from(schedulerQueues),
    db.select().from(jobs),
    db.select().from(netdriveFiles),
    db.select().from(clusterFileRoots),
    db.select().from(softwareAssets),
    db.select().from(softwareAssetGrants),
    db.select().from(sshCredentials),
    db.select().from(sshRecordings),
    db.select().from(workflowRuns),
    db.select().from(userCapabilities),
    db.select().from(dataAssets),
    db.select().from(dataGrants),
    db.select().from(dataAccessPolicies),
  ]);

  const tuples: AuthzTuple[] = [];
  for (const org of orgRows) {
    tuples.push(...organizationBaselineTuples(org.id));
  }
  for (const user of userRows) {
    tuples.push(platformMemberTuple(user.id));
    if (isPlatformRole(user.role)) {
      tuples.push(platformRoleTuple({ userId: user.id, role: user.role }));
    }
  }
  for (const capability of capabilityRows) {
    if (capability.capability === "audit_readonly") {
      tuples.push(platformAuditorTuple(capability.userId));
    }
  }
  for (const row of membershipRows) {
    if (isMembershipRole(row.role)) {
      tuples.push(
        organizationMembershipTuple({ userId: row.userId, orgId: row.orgId, role: row.role }),
      );
    }
  }
  const primaryOrgByUser = primaryMembershipOrgByUser(membershipRows);
  const userIdByActor = userIdentityMap(userRows);
  for (const agent of agentRows) {
    tuples.push(agentPlatformTuple(agent.agentId));
    if (agent.providerOrgId) {
      tuples.push(
        agentProviderTuple({ agentId: agent.agentId, providerOrgId: agent.providerOrgId }),
      );
    }
  }
  for (const queue of queueRows) {
    tuples.push(
      queueProviderTuple({ queueId: queue.queueId, providerOrgId: queue.providerOrgId }),
      queuePlatformTuple(queue.queueId),
    );
    for (const orgId of queue.visibleOrgIds) {
      tuples.push(queueVisibleOrgTuple({ queueId: queue.queueId, orgId }));
    }
  }
  for (const job of jobRows) {
    if (job.submittedBy) tuples.push(jobOwnerTuple({ jobId: job.id, userId: job.submittedBy }));
    const jobOrgId =
      job.orgId ?? (job.submittedBy ? primaryOrgByUser.get(job.submittedBy) : undefined);
    if (jobOrgId) tuples.push(jobConsumerOrgTuple({ jobId: job.id, orgId: jobOrgId }));
    if (job.queueId) tuples.push(jobQueueTuple({ jobId: job.id, queueId: job.queueId }));
    if (job.providerOrgId) {
      tuples.push(jobProviderTuple({ jobId: job.id, providerOrgId: job.providerOrgId }));
    }
    tuples.push(jobPlatformTuple(job.id));
  }
  for (const file of fileRows) {
    if (!file.deletedAt) {
      tuples.push(netdriveOwnerTuple({ fileId: file.id, userId: file.ownerId }));
      const orgId = primaryOrgByUser.get(file.ownerId);
      if (orgId) tuples.push(netdriveConsumerOrgTuple({ fileId: file.id, orgId }));
      tuples.push(netdrivePlatformTuple(file.id));
    }
  }
  for (const workflow of workflowRows) {
    if (workflow.submittedBy) {
      tuples.push(workflowOwnerTuple({ workflowId: workflow.id, userId: workflow.submittedBy }));
      const orgId =
        workflow.input && Object.hasOwn(workflow.input, "orgId")
          ? workflow.input.orgId
          : primaryOrgByUser.get(workflow.submittedBy);
      if (orgId) tuples.push(workflowConsumerOrgTuple({ workflowId: workflow.id, orgId }));
    }
    tuples.push(workflowPlatformTuple(workflow.id));
  }
  for (const root of rootRows) {
    tuples.push(
      clusterFileRootProviderTuple({ rootId: root.id, providerOrgId: root.providerOrgId }),
      clusterFileRootPlatformTuple(root.id),
    );
    for (const orgId of root.visibleOrgIds) {
      tuples.push(clusterFileRootVisibleOrgTuple({ rootId: root.id, orgId }));
    }
  }
  for (const credential of credentialRows) {
    tuples.push(
      sshCredentialAgentTuple(credential.agentId),
      sshCredentialPlatformTuple(credential.agentId),
    );
  }
  for (const recording of recordingRows) {
    tuples.push(
      sshRecordingAgentTuple({ agentId: recording.agentId, sessionId: recording.sessionId }),
      sshRecordingPlatformTuple(recording.sessionId),
    );
    const actorUserId = userIdByActor.get(recording.actorUser);
    if (actorUserId) {
      tuples.push(sshRecordingActorTuple({ sessionId: recording.sessionId, userId: actorUserId }));
    }
  }
  for (const asset of assetRows) {
    if (asset.ownerUserId) {
      tuples.push(softwareAssetOwnerTuple({ assetId: asset.id, userId: asset.ownerUserId }));
    }
    if (asset.ownerOrgId) {
      tuples.push(softwareAssetOwnerOrgTuple({ assetId: asset.id, orgId: asset.ownerOrgId }));
    }
    if (asset.providerOrgId) {
      tuples.push(
        softwareAssetProviderTuple({ assetId: asset.id, providerOrgId: asset.providerOrgId }),
      );
    }
    tuples.push(softwareAssetPlatformTuple(asset.id));
    if (asset.visibility === "platform-public" && asset.lifecycle === "published") {
      tuples.push(
        ...softwareAssetPublicGrantTuples({
          assetId: asset.id,
          trustedForGlobalUse: asset.trustedForGlobalUse,
          operation: "create",
        }),
      );
    }
  }
  for (const grant of grantRows) {
    tuples.push(...softwareGrantTuples(grant));
  }
  for (const asset of dataAssetRows) {
    if (asset.ownerKind === "user" && asset.ownerUserId) {
      tuples.push(dataAssetOwnerTuple({ assetId: asset.id, userId: asset.ownerUserId }));
    }
    if (asset.ownerKind === "org" && asset.ownerOrgId) {
      tuples.push(dataAssetOwnerOrgTuple({ assetId: asset.id, orgId: asset.ownerOrgId }));
    }
    if (asset.ownerKind === "provider" && asset.providerOrgId) {
      tuples.push(
        dataAssetProviderTuple({ assetId: asset.id, providerOrgId: asset.providerOrgId }),
      );
    }
    tuples.push(dataAssetPlatformTuple(asset.id));
    if (asset.visibility === "public" && asset.lifecycle === "published") {
      tuples.push(...dataAssetPublicTuples({ assetId: asset.id, accessMode: asset.accessMode }));
    }
  }
  for (const grant of dataGrantRows) {
    if (
      grant.status === "active" &&
      !grant.dataAssetVersionId &&
      (grant.expiresAt === null || grant.expiresAt > now)
    ) {
      tuples.push(
        ...dataAssetGrantTuples({ ...grant, assetId: grant.dataAssetId, operation: "create" }),
      );
    }
  }
  for (const policy of dataPolicyRows) {
    if (
      policy.effect === "allow" &&
      policy.status === "active" &&
      !policy.dataAssetVersionId &&
      (policy.expiresAt === null || policy.expiresAt > now)
    ) {
      tuples.push(
        ...dataAssetGrantTuples({ ...policy, assetId: policy.dataAssetId, operation: "create" }),
      );
    }
  }

  return { tuples, counts: countByResourceType(tuples) };
}

function softwareGrantTuples(grant: typeof softwareAssetGrants.$inferSelect): AuthzTuple[] {
  return softwareAssetGrantTuples({
    assetId: grant.assetId,
    subjectKind: grant.subjectKind,
    subjectId: grant.subjectId,
    capabilities: grant.capabilities,
    operation: "create",
  });
}

function countByResourceType(tuples: AuthzTuple[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tuple of tuples) {
    counts[tuple.resource.type] = (counts[tuple.resource.type] ?? 0) + 1;
  }
  return counts;
}

function primaryMembershipOrgByUser(
  rows: Array<typeof userOrgMemberships.$inferSelect>,
): Map<string, string> {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const byUser = new Map<string, string>();
  for (const row of sorted) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, row.orgId);
  }
  return byUser;
}

function userIdentityMap(rows: Array<{ id: string; email: string | null }>): Map<string, string> {
  const byActor = new Map<string, string>();
  for (const row of rows) {
    byActor.set(row.id, row.id);
    if (row.email) byActor.set(row.email, row.id);
  }
  return byActor;
}

function isMembershipRole(
  role: string,
): role is "owner" | "admin" | "operator" | "member" | "viewer" {
  return MEMBERSHIP_ROLES.has(role);
}

function isPlatformRole(role: string): role is "super_admin" | "platform_admin" | "operator" {
  return role === "super_admin" || role === "platform_admin" || role === "operator";
}
