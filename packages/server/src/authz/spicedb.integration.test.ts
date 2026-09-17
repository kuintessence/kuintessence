import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import {
  agentPlatformTuple,
  agentProviderTuple,
  clusterFileRootPlatformTuple,
  clusterFileRootProviderTuple,
  clusterFileRootVisibleOrgTuple,
  jobConsumerOrgTuple,
  jobOwnerTuple,
  jobPlatformTuple,
  jobProviderTuple,
  jobQueueTuple,
  netdriveOwnerTuple,
  netdrivePlatformTuple,
  organizationMembershipTuple,
  organizationPlatformTuple,
  platformMemberTuple,
  platformRoleTuple,
  providerOrganizationTuple,
  providerPlatformTuple,
  queuePlatformTuple,
  queueProviderTuple,
  queueVisibleOrgTuple,
  softwareAssetGrantTuples,
  softwareAssetOwnerTuple,
  softwareAssetPlatformTuple,
  softwareAssetProviderTuple,
  sshCredentialAgentTuple,
  sshCredentialPlatformTuple,
  sshRecordingAgentTuple,
  sshRecordingPlatformTuple,
  sshSessionAgentTuple,
  sshSessionOpenerTuple,
  sshSessionPlatformTuple,
  workflowOwnerTuple,
  workflowPlatformTuple,
} from "./projection";
import { AuthzService, type AuthzTuple } from "./service";

const endpoint = process.env.SPICEDB_E2E_ENDPOINT;
const token = process.env.SPICEDB_E2E_TOKEN ?? process.env.AUTHZ_SPICEDB_TOKEN ?? "local-dev-authz";
const describeSpiceDb = endpoint ? describe : describe.skip;

describeSpiceDb("SpiceDB authorization integration", () => {
  test("writes schema, projects relationships, checks permissions, and looks up resources", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `user-${suffix}`;
    const strangerId = `stranger-${suffix}`;
    const platformMemberId = `platform-member-${suffix}`;
    const platformAdminId = `platform-admin-${suffix}`;
    const platformOperatorId = `platform-operator-${suffix}`;
    const consumerAdminId = `consumer-admin-${suffix}`;
    const providerOperatorId = `provider-operator-${suffix}`;
    const ordinaryMemberId = `ordinary-member-${suffix}`;
    const orgId = `org-${suffix}`;
    const agentId = `agent-${suffix}`;
    const queueId = `queue-${suffix}`;
    const jobId = `job-${suffix}`;
    const workflowId = `workflow-${suffix}`;
    const fileId = `file-${suffix}`;
    const rootId = `root-${suffix}`;
    const assetId = `asset-${suffix}`;
    const sessionId = `session-${suffix}`;
    const orphanAgentId = `orphan-agent-${suffix}`;
    const orphanProviderId = `orphan-provider-${suffix}`;
    const orphanQueueId = `orphan-queue-${suffix}`;
    const orphanRootId = `orphan-root-${suffix}`;
    const orphanRecordingId = `orphan-recording-${suffix}`;
    const db = {} as PgDb;
    const service = new AuthzService({
      mode: "shadow",
      endpoint: endpoint ?? "",
      token,
      schemaPath: "authz/schema.zed",
      db,
      platformAdminDegrade: false,
    });
    const tuples: AuthzTuple[] = [
      organizationPlatformTuple(orgId),
      platformMemberTuple(platformMemberId),
      platformRoleTuple({ userId: platformAdminId, role: "platform_admin" }),
      platformRoleTuple({ userId: platformOperatorId, role: "operator" }),
      organizationMembershipTuple({ userId, orgId, role: "admin" }),
      organizationMembershipTuple({ userId: consumerAdminId, orgId, role: "admin" }),
      organizationMembershipTuple({ userId: providerOperatorId, orgId, role: "operator" }),
      organizationMembershipTuple({ userId: ordinaryMemberId, orgId, role: "member" }),
      providerOrganizationTuple(orgId),
      agentProviderTuple({ agentId, providerOrgId: orgId }),
      queueProviderTuple({ queueId, providerOrgId: orgId }),
      queueVisibleOrgTuple({ queueId, orgId }),
      jobOwnerTuple({ jobId, userId }),
      jobConsumerOrgTuple({ jobId, orgId }),
      jobQueueTuple({ jobId, queueId }),
      jobProviderTuple({ jobId, providerOrgId: orgId }),
      jobPlatformTuple(jobId),
      workflowOwnerTuple({ workflowId, userId }),
      workflowPlatformTuple(workflowId),
      netdriveOwnerTuple({ fileId, userId }),
      netdrivePlatformTuple(fileId),
      clusterFileRootProviderTuple({ rootId, providerOrgId: orgId }),
      clusterFileRootVisibleOrgTuple({ rootId, orgId }),
      softwareAssetOwnerTuple({ assetId, userId }),
      softwareAssetProviderTuple({ assetId, providerOrgId: orgId }),
      softwareAssetPlatformTuple(assetId),
      ...softwareAssetGrantTuples({
        assetId,
        subjectKind: "platform",
        subjectId: "platform",
        capabilities: ["view", "use", "install"],
        operation: "create",
      }),
      sshCredentialAgentTuple(agentId),
      sshSessionAgentTuple({ sessionId, agentId }),
      sshSessionOpenerTuple({ sessionId, userId }),
      sshSessionPlatformTuple(sessionId),
      sshRecordingAgentTuple({ agentId, sessionId }),
      providerPlatformTuple(orphanProviderId),
      agentPlatformTuple(orphanAgentId),
      queuePlatformTuple(orphanQueueId),
      clusterFileRootPlatformTuple(orphanRootId),
      sshCredentialPlatformTuple(orphanAgentId),
      sshRecordingPlatformTuple(orphanRecordingId),
    ];
    try {
      await service.writeSchemaFromDisk();
      await service.writeRelationships(tuples);
      await expect(
        service.checkBulk([
          {
            resource: { type: "job", id: jobId },
            permission: "view",
            subject: { type: "user", id: consumerAdminId },
          },
          {
            resource: { type: "job", id: jobId },
            permission: "view",
            subject: { type: "user", id: providerOperatorId },
          },
          {
            resource: { type: "job", id: jobId },
            permission: "view",
            subject: { type: "user", id: ordinaryMemberId },
          },
          {
            resource: { type: "job", id: jobId },
            permission: "view",
            subject: { type: "user", id: strangerId },
          },
        ]),
      ).resolves.toEqual([true, true, false, false]);
      await expect(
        service.check({
          resource: { type: "platform", id: "root" },
          permission: "manage",
          subject: { type: "user", id: platformAdminId },
        }),
      ).resolves.toBe(true);
      await expect(
        service.checkBulk([
          {
            resource: { type: "platform", id: "root" },
            permission: "view",
            subject: { type: "user", id: platformOperatorId },
          },
          {
            resource: { type: "platform", id: "root" },
            permission: "operate",
            subject: { type: "user", id: platformOperatorId },
          },
          {
            resource: { type: "platform", id: "root" },
            permission: "manage",
            subject: { type: "user", id: platformOperatorId },
          },
          {
            resource: { type: "job", id: jobId },
            permission: "view",
            subject: { type: "user", id: platformOperatorId },
          },
          {
            resource: { type: "job", id: jobId },
            permission: "cancel",
            subject: { type: "user", id: platformOperatorId },
          },
          {
            resource: { type: "workflow", id: workflowId },
            permission: "cancel",
            subject: { type: "user", id: platformOperatorId },
          },
          {
            resource: { type: "netdrive_file", id: fileId },
            permission: "use",
            subject: { type: "user", id: platformOperatorId },
          },
          {
            resource: { type: "netdrive_file", id: fileId },
            permission: "delete",
            subject: { type: "user", id: platformOperatorId },
          },
          {
            resource: { type: "ssh_session", id: sessionId },
            permission: "open",
            subject: { type: "user", id: platformOperatorId },
          },
          {
            resource: { type: "ssh_session", id: sessionId },
            permission: "view",
            subject: { type: "user", id: platformOperatorId },
          },
        ]),
      ).resolves.toEqual([true, true, false, true, true, true, true, false, true, true]);
      await expect(
        service.check({
          resource: { type: "queue", id: queueId },
          permission: "submit",
          subject: { type: "user", id: userId },
        }),
      ).resolves.toBe(true);
      await expect(
        service.check({
          resource: { type: "queue", id: queueId },
          permission: "submit",
          subject: { type: "user", id: strangerId },
        }),
      ).resolves.toBe(false);
      await expect(
        service.check({
          resource: { type: "agent", id: orphanAgentId },
          permission: "manage",
          subject: { type: "user", id: platformAdminId },
        }),
      ).resolves.toBe(true);
      await expect(
        service.checkBulk([
          {
            resource: { type: "provider", id: orphanProviderId },
            permission: "manage",
            subject: { type: "user", id: platformAdminId },
          },
          {
            resource: { type: "queue", id: orphanQueueId },
            permission: "manage",
            subject: { type: "user", id: platformAdminId },
          },
          {
            resource: { type: "cluster_file_root", id: orphanRootId },
            permission: "manage",
            subject: { type: "user", id: platformAdminId },
          },
          {
            resource: { type: "ssh_credential", id: orphanAgentId },
            permission: "manage",
            subject: { type: "user", id: platformAdminId },
          },
          {
            resource: { type: "ssh_recording", id: orphanRecordingId },
            permission: "delete",
            subject: { type: "user", id: platformAdminId },
          },
        ]),
      ).resolves.toEqual([true, true, true, true, true]);
      await expect(
        service.checkBulk([
          {
            resource: { type: "job", id: jobId },
            permission: "cancel",
            subject: { type: "user", id: userId },
          },
          {
            resource: { type: "workflow", id: workflowId },
            permission: "cancel",
            subject: { type: "user", id: userId },
          },
          {
            resource: { type: "netdrive_file", id: fileId },
            permission: "delete",
            subject: { type: "user", id: userId },
          },
          {
            resource: { type: "cluster_file_root", id: rootId },
            permission: "use",
            subject: { type: "user", id: userId },
          },
          {
            resource: { type: "software_asset", id: assetId },
            permission: "install",
            subject: { type: "user", id: userId },
          },
          {
            resource: { type: "software_asset", id: assetId },
            permission: "install",
            subject: { type: "user", id: platformMemberId },
          },
          {
            resource: { type: "ssh_credential", id: agentId },
            permission: "manage",
            subject: { type: "user", id: userId },
          },
          {
            resource: { type: "ssh_session", id: sessionId },
            permission: "close",
            subject: { type: "user", id: userId },
          },
          {
            resource: { type: "ssh_session", id: sessionId },
            permission: "open",
            subject: { type: "user", id: platformAdminId },
          },
          {
            resource: { type: "ssh_session", id: sessionId },
            permission: "view",
            subject: { type: "user", id: platformAdminId },
          },
          {
            resource: { type: "ssh_recording", id: sessionId },
            permission: "delete",
            subject: { type: "user", id: userId },
          },
        ]),
      ).resolves.toEqual([true, true, true, true, true, true, true, true, true, true, true]);
      const resources = await service.lookupResources({
        resourceType: "queue",
        permission: "submit",
        subject: { type: "user", id: userId },
        limit: 10,
      });
      expect(resources).toContain(queueId);
    } finally {
      const deletes: AuthzTuple[] = tuples.map((tuple) => ({ ...tuple, operation: "delete" }));
      await service.writeRelationships(deletes).catch(() => undefined);
      service.close();
    }
  }, 60_000);
});
