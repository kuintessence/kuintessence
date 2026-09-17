import type { AuthzTuple } from "./service";

export {
  dataAssetPlatformTuple,
  dataAssetPublicTuples,
  softwareAssetPlatformTuple,
  softwareAssetPublicGrantTuples,
} from "@kuintessence/shared";

export type MembershipRole = "owner" | "admin" | "operator" | "member" | "viewer";
export type PlatformRole = "super_admin" | "platform_admin" | "operator";

const MEMBERSHIP_ROLES: MembershipRole[] = ["owner", "admin", "operator", "member", "viewer"];
const PLATFORM_RELATIONS = ["super_admin", "admin", "operator"] as const;
const PLATFORM_MEMBER_RELATION = "member";
const PLATFORM_AUDITOR_RELATION = "auditor";

export function organizationMembershipTuple(input: {
  userId: string;
  orgId: string;
  role: MembershipRole;
}): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "organization", id: input.orgId },
    relation: input.role,
    subject: { type: "user", id: input.userId },
  };
}

export function organizationMembershipDeleteTuples(input: {
  userId: string;
  orgId: string;
}): AuthzTuple[] {
  return MEMBERSHIP_ROLES.map((role) => ({
    operation: "delete",
    resource: { type: "organization", id: input.orgId },
    relation: role,
    subject: { type: "user", id: input.userId },
  }));
}

export function organizationMembershipReplacementTuples(input: {
  userId: string;
  orgId: string;
  role: MembershipRole;
}): AuthzTuple[] {
  const deletions = MEMBERSHIP_ROLES.filter((role) => role !== input.role).map((role) => ({
    operation: "delete" as const,
    resource: { type: "organization", id: input.orgId },
    relation: role,
    subject: { type: "user", id: input.userId },
  }));
  return [...deletions, organizationMembershipTuple(input)];
}

export function platformRoleTuple(input: { userId: string; role: PlatformRole }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "platform", id: "root" },
    relation: platformRoleRelation(input.role),
    subject: { type: "user", id: input.userId },
  };
}

export function platformMemberTuple(userId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "platform", id: "root" },
    relation: PLATFORM_MEMBER_RELATION,
    subject: { type: "user", id: userId },
  };
}

export function platformAuditorTuple(userId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "platform", id: "root" },
    relation: PLATFORM_AUDITOR_RELATION,
    subject: { type: "user", id: userId },
  };
}

export function platformRoleDeleteTuples(userId: string): AuthzTuple[] {
  return PLATFORM_RELATIONS.map((relation) => ({
    operation: "delete",
    resource: { type: "platform", id: "root" },
    relation,
    subject: { type: "user", id: userId },
  }));
}

export function platformRoleReplacementTuples(input: {
  userId: string;
  role: PlatformRole | null;
}): AuthzTuple[] {
  const targetRelation = input.role ? platformRoleRelation(input.role) : null;
  const deletions = platformRoleDeleteTuples(input.userId).filter(
    (tuple) => tuple.relation !== targetRelation,
  );
  if (!input.role) return deletions;
  return [...deletions, platformRoleTuple({ userId: input.userId, role: input.role })];
}

function platformRoleRelation(role: PlatformRole): (typeof PLATFORM_RELATIONS)[number] {
  return role === "platform_admin" ? "admin" : role;
}

export function organizationPlatformTuple(orgId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "organization", id: orgId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function organizationBaselineTuples(orgId: string): AuthzTuple[] {
  return [
    organizationPlatformTuple(orgId),
    providerOrganizationTuple(orgId),
    providerPlatformTuple(orgId),
  ];
}

export function providerOrganizationTuple(orgId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "provider", id: orgId },
    relation: "org",
    subject: { type: "organization", id: orgId },
  };
}

export function providerPlatformTuple(providerOrgId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "provider", id: providerOrgId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function agentProviderTuple(input: { agentId: string; providerOrgId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "agent", id: input.agentId },
    relation: "provider",
    subject: { type: "provider", id: input.providerOrgId },
  };
}

export function agentPlatformTuple(agentId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "agent", id: agentId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function queueProviderTuple(input: { queueId: string; providerOrgId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "queue", id: input.queueId },
    relation: "provider",
    subject: { type: "provider", id: input.providerOrgId },
  };
}

export function queuePlatformTuple(queueId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "queue", id: queueId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function queueVisibleOrgTuple(input: { queueId: string; orgId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "queue", id: input.queueId },
    relation: "visible_org",
    subject: { type: "organization", id: input.orgId },
  };
}

export function jobOwnerTuple(input: { jobId: string; userId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "job", id: input.jobId },
    relation: "owner",
    subject: { type: "user", id: input.userId },
  };
}

export function jobConsumerOrgTuple(input: { jobId: string; orgId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "job", id: input.jobId },
    relation: "consumer_org",
    subject: { type: "organization", id: input.orgId },
  };
}

export function jobQueueTuple(input: { jobId: string; queueId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "job", id: input.jobId },
    relation: "queue",
    subject: { type: "queue", id: input.queueId },
  };
}

export function jobProviderTuple(input: { jobId: string; providerOrgId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "job", id: input.jobId },
    relation: "provider",
    subject: { type: "provider", id: input.providerOrgId },
  };
}

export function jobPlatformTuple(jobId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "job", id: jobId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function jobSubmissionTuples(input: {
  jobId: string;
  userId: string;
  orgId: string | null;
  queueId: string | null;
}): AuthzTuple[] {
  const tuples = [
    jobOwnerTuple({ jobId: input.jobId, userId: input.userId }),
    jobPlatformTuple(input.jobId),
  ];
  if (input.orgId) {
    tuples.push(jobConsumerOrgTuple({ jobId: input.jobId, orgId: input.orgId }));
  }
  if (input.queueId) {
    tuples.push(jobQueueTuple({ jobId: input.jobId, queueId: input.queueId }));
  }
  return tuples;
}

export function netdriveOwnerTuple(input: { fileId: string; userId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "netdrive_file", id: input.fileId },
    relation: "owner",
    subject: { type: "user", id: input.userId },
  };
}

export function netdriveConsumerOrgTuple(input: { fileId: string; orgId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "netdrive_file", id: input.fileId },
    relation: "consumer_org",
    subject: { type: "organization", id: input.orgId },
  };
}

export function netdrivePlatformTuple(fileId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "netdrive_file", id: fileId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function netdriveFileTuples(
  input: { fileId: string; userId: string; orgId?: string | null },
  operation: AuthzTuple["operation"] = "create",
): AuthzTuple[] {
  const tuples: AuthzTuple[] = [
    { ...netdriveOwnerTuple({ fileId: input.fileId, userId: input.userId }), operation },
    { ...netdrivePlatformTuple(input.fileId), operation },
  ];
  if (input.orgId) {
    tuples.push({
      ...netdriveConsumerOrgTuple({ fileId: input.fileId, orgId: input.orgId }),
      operation,
    });
  }
  return tuples;
}

export function workflowOwnerTuple(input: { workflowId: string; userId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "workflow", id: input.workflowId },
    relation: "owner",
    subject: { type: "user", id: input.userId },
  };
}

export function workflowConsumerOrgTuple(input: { workflowId: string; orgId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "workflow", id: input.workflowId },
    relation: "consumer_org",
    subject: { type: "organization", id: input.orgId },
  };
}

export function workflowPlatformTuple(workflowId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "workflow", id: workflowId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function clusterFileRootProviderTuple(input: {
  rootId: string;
  providerOrgId: string;
}): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "cluster_file_root", id: input.rootId },
    relation: "provider",
    subject: { type: "provider", id: input.providerOrgId },
  };
}

export function clusterFileRootVisibleOrgTuple(input: {
  rootId: string;
  orgId: string;
}): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "cluster_file_root", id: input.rootId },
    relation: "visible_org",
    subject: { type: "organization", id: input.orgId },
  };
}

export function clusterFileRootPlatformTuple(rootId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "cluster_file_root", id: rootId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function sshCredentialAgentTuple(agentId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "ssh_credential", id: agentId },
    relation: "agent",
    subject: { type: "agent", id: agentId },
  };
}

export function sshCredentialPlatformTuple(agentId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "ssh_credential", id: agentId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function sshSessionAgentTuple(input: { sessionId: string; agentId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "ssh_session", id: input.sessionId },
    relation: "agent",
    subject: { type: "agent", id: input.agentId },
  };
}

export function sshSessionOpenerTuple(input: { sessionId: string; userId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "ssh_session", id: input.sessionId },
    relation: "opener",
    subject: { type: "user", id: input.userId },
  };
}

export function sshSessionPlatformTuple(sessionId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "ssh_session", id: sessionId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function sshRecordingAgentTuple(input: { agentId: string; sessionId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "ssh_recording", id: input.sessionId },
    relation: "agent",
    subject: { type: "agent", id: input.agentId },
  };
}

export function sshRecordingActorTuple(input: { sessionId: string; userId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "ssh_recording", id: input.sessionId },
    relation: "actor",
    subject: { type: "user", id: input.userId },
  };
}

export function sshRecordingPlatformTuple(sessionId: string): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "ssh_recording", id: sessionId },
    relation: "platform",
    subject: { type: "platform", id: "root" },
  };
}

export function softwareAssetOwnerTuple(input: { assetId: string; userId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "software_asset", id: input.assetId },
    relation: "owner",
    subject: { type: "user", id: input.userId },
  };
}

export function softwareAssetOwnerOrgTuple(input: { assetId: string; orgId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "software_asset", id: input.assetId },
    relation: "owner_org",
    subject: { type: "organization", id: input.orgId },
  };
}

export function softwareAssetProviderTuple(input: {
  assetId: string;
  providerOrgId: string;
}): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "software_asset", id: input.assetId },
    relation: "provider",
    subject: { type: "provider", id: input.providerOrgId },
  };
}

export function softwareAssetGrantTuples(input: {
  assetId: string;
  subjectKind: string;
  subjectId: string;
  capabilities: string[];
  operation: AuthzTuple["operation"];
}): AuthzTuple[] {
  const tuples: AuthzTuple[] = [];
  for (const capability of input.capabilities) {
    const relation = softwareCapabilityToRelation(capability);
    if (!relation) continue;
    const subject = softwareGrantSubject(input.subjectKind, input.subjectId, capability);
    if (!subject) continue;
    tuples.push({
      operation: input.operation,
      resource: { type: "software_asset", id: input.assetId },
      relation,
      subject,
    });
  }
  return tuples;
}

export function dataAssetOwnerTuple(input: { assetId: string; userId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "data_asset", id: input.assetId },
    relation: "owner",
    subject: { type: "user", id: input.userId },
  };
}

export function dataAssetOwnerOrgTuple(input: { assetId: string; orgId: string }): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "data_asset", id: input.assetId },
    relation: "owner_org",
    subject: { type: "organization", id: input.orgId },
  };
}

export function dataAssetProviderTuple(input: {
  assetId: string;
  providerOrgId: string;
}): AuthzTuple {
  return {
    operation: "create",
    resource: { type: "data_asset", id: input.assetId },
    relation: "provider",
    subject: { type: "provider", id: input.providerOrgId },
  };
}

export function dataAssetGrantTuples(input: {
  assetId: string;
  subjectKind: string;
  subjectId: string;
  capabilities: string[];
  operation: AuthzTuple["operation"];
}): AuthzTuple[] {
  const tuples: AuthzTuple[] = [];
  for (const capability of input.capabilities) {
    const relation = dataCapabilityToRelation(capability);
    if (!relation) continue;
    const subject = dataGrantSubject(input.subjectKind, input.subjectId, capability);
    if (!subject) continue;
    tuples.push({
      operation: input.operation,
      resource: { type: "data_asset", id: input.assetId },
      relation,
      subject,
    });
  }
  return tuples;
}

export function dataAssetGrantDeltaTuples(input: {
  assetId: string;
  subjectKind: string;
  subjectId: string;
  previousCapabilities: string[];
  nextCapabilities: string[];
}): AuthzTuple[] {
  const previous = normalizeDataGrantCapabilities(input.previousCapabilities);
  const next = normalizeDataGrantCapabilities(input.nextCapabilities);
  const nextSet = new Set(next);
  const previousSet = new Set(previous);
  return [
    ...dataAssetGrantTuples({
      assetId: input.assetId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      capabilities: previous.filter((capability) => !nextSet.has(capability)),
      operation: "delete",
    }),
    ...dataAssetGrantTuples({
      assetId: input.assetId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      capabilities: next.filter((capability) => !previousSet.has(capability)),
      operation: "create",
    }),
  ];
}

export function normalizeDataGrantCapabilities(capabilities: string[]): string[] {
  return [
    ...new Set(capabilities.filter((capability) => dataCapabilityToRelation(capability))),
  ].sort();
}

function dataCapabilityToRelation(
  capability: string,
): "viewer" | "user" | "downloader" | "deriver" | "manager" | null {
  if (capability === "view") return "viewer";
  if (capability === "use") return "user";
  if (capability === "download") return "downloader";
  if (capability === "derive") return "deriver";
  if (capability === "manage") return "manager";
  return null;
}

function dataGrantSubject(
  subjectKind: string,
  subjectId: string,
  capability: string,
): AuthzTuple["subject"] | null {
  if (subjectKind === "user") return { type: "user", id: subjectId };
  if (subjectKind === "org") {
    return {
      type: "organization",
      id: subjectId,
      relation: capability === "view" ? "view" : capability === "manage" ? "manage" : "use",
    };
  }
  if (subjectKind === "provider-org" && capability === "manage") {
    return { type: "provider", id: subjectId, relation: "manage" };
  }
  if (subjectKind === "platform") {
    return {
      type: "platform",
      id: "root",
      relation:
        capability === "view"
          ? "software_view"
          : capability === "manage"
            ? "manage"
            : "software_use",
    };
  }
  return null;
}

function softwareCapabilityToRelation(capability: string): "viewer" | "user" | "installer" | null {
  if (capability === "view") return "viewer";
  if (capability === "use") return "user";
  if (capability === "install") return "installer";
  return null;
}

function softwareGrantSubject(
  subjectKind: string,
  subjectId: string,
  capability: string,
): AuthzTuple["subject"] | null {
  if (subjectKind === "user") return { type: "user", id: subjectId };
  if (subjectKind === "org") {
    return {
      type: "organization",
      id: subjectId,
      relation: capability === "view" ? "view" : "use",
    };
  }
  if (subjectKind === "platform") {
    return {
      type: "platform",
      id: "root",
      relation: capability === "view" ? "software_view" : "software_use",
    };
  }
  if (subjectKind === "provider-org" && capability === "install") {
    return { type: "provider", id: subjectId, relation: "operate" };
  }
  return null;
}
