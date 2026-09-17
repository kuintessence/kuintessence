import { describe, expect, test } from "bun:test";
import {
  accountAssignmentDelegations,
  agentCerts,
  agentInstalledSoftware,
  agentMetrics,
  agentSchedulerQueueSnapshots,
  agentSchedulerQueues,
  agents,
  artifactReplicas,
  auditLog,
  authzOutbox,
  authzShadowDiffs,
  clusterExecutionAccounts,
  desensitizeAliasMap,
  desensitizeConfig,
  jobs,
  orgs,
  placementPlans,
  platformBranding,
  queueObservabilityCounters,
  queueObservabilityEvents,
  sandboxPolicyOverlays,
  sandboxRuntimeProfiles,
  schedulerQueues,
  scriptAttestations,
  scriptExecutionStats,
  softwareAssetRevisions,
  softwareOperations,
  softwarePolicies,
  softwarePolicyOverlays,
  ssoConfig,
  userClusterAccountMappings,
  userOrgMemberships,
  users,
  workflowArtifacts,
  workflowDrafts,
} from "./schema";

describe("PG Schema", () => {
  test("agents table has required columns", () => {
    expect(agents.agentId).toBeDefined();
    expect(agents.siteName).toBeDefined();
    expect(agents.schedulerType).toBeDefined();
    expect(agents.status).toBeDefined();
    expect(agents.lastHeartbeat).toBeDefined();
    expect(agents.rootMode).toBeDefined();
    expect(agents.sandboxReadiness).toBeDefined();
    expect(agents.sandboxCapabilities).toBeDefined();
    expect(agents.sandboxRuntimeCache).toBeDefined();
  });

  test("sandbox governance tables expose their identity and policy columns", () => {
    expect(sandboxRuntimeProfiles.language).toBeDefined();
    expect(sandboxRuntimeProfiles.ociDigest).toBeDefined();
    expect(sandboxRuntimeProfiles.sifDigest).toBeDefined();
    expect(clusterExecutionAccounts.uid).toBeDefined();
    expect(clusterExecutionAccounts.serviceAccount).toBeDefined();
    expect(userClusterAccountMappings.status).toBeDefined();
    expect(accountAssignmentDelegations.delegated).toBeDefined();
    expect(scriptAttestations.assetRevisionId).toBeDefined();
    expect(sandboxPolicyOverlays.policy).toBeDefined();
    expect(softwareAssetRevisions.contentSha256).toBeDefined();
  });

  test("artifact and placement tables expose locality planning facts", () => {
    expect(workflowArtifacts.contentHash).toBeDefined();
    expect(workflowArtifacts.durability).toBeDefined();
    expect(artifactReplicas.siteId).toBeDefined();
    expect(artifactReplicas.expiresAt).toBeDefined();
    expect(placementPlans.plannerMode).toBeDefined();
    expect(placementPlans.objective).toBeDefined();
    expect(scriptExecutionStats.averagePredictionError).toBeDefined();
  });

  test("workflow drafts preserve editable content separately from runs", () => {
    expect(workflowDrafts.id).toBeDefined();
    expect(workflowDrafts.ownerId).toBeDefined();
    expect(workflowDrafts.name).toBeDefined();
    expect(workflowDrafts.yaml).toBeDefined();
    expect(workflowDrafts.placementConfig).toBeDefined();
    expect(workflowDrafts.updatedAt).toBeDefined();
  });

  test("jobs table has required columns", () => {
    expect(jobs.id).toBeDefined();
    expect(jobs.name).toBeDefined();
    expect(jobs.status).toBeDefined();
    expect(jobs.agentId).toBeDefined();
    expect(jobs.command).toBeDefined();
    expect(jobs.cpus).toBeDefined();
    expect(jobs.memoryMb).toBeDefined();
    expect(jobs.queueTargetMode).toBeDefined();
    expect(jobs.schedulerQueueName).toBeDefined();
    expect(jobs.queueObservedAt).toBeDefined();
  });

  test("queue registry distinguishes default targets from observed scheduler facts", () => {
    expect(schedulerQueues.targetMode).toBeDefined();
    expect(schedulerQueues.queueName).toBeDefined();
    expect(agentSchedulerQueueSnapshots.agentId).toBeDefined();
    expect(agentSchedulerQueueSnapshots.queueInventoryV1).toBeDefined();
    expect(agentSchedulerQueueSnapshots.defaultQueueName).toBeDefined();
    expect(agentSchedulerQueueSnapshots.lastNoGoAt).toBeDefined();
    expect(agentSchedulerQueueSnapshots.noGoReason).toBeDefined();
    expect(agentSchedulerQueueSnapshots.recoveryStartedAt).toBeDefined();
    expect(agentSchedulerQueueSnapshots.recoveredAt).toBeDefined();
    expect(agentSchedulerQueues.agentId).toBeDefined();
    expect(agentSchedulerQueues.queueName).toBeDefined();
    expect(agentSchedulerQueues.acceptsSubmissions).toBeDefined();
    expect(agentSchedulerQueues.observedAt).toBeDefined();
  });

  // placement_trace JSONB column for the 8-stage placement audit.
  test("jobs.placementTrace column is exposed for the placement-trace audit", () => {
    expect(jobs.placementTrace).toBeDefined();
  });

  test("users table has required columns", () => {
    expect(users.id).toBeDefined();
    expect(users.email).toBeDefined();
    expect(users.role).toBeDefined();
    expect(users.orgId).toBeDefined();
  });

  test("userOrgMemberships table has required columns", () => {
    expect(userOrgMemberships.id).toBeDefined();
    expect(userOrgMemberships.userId).toBeDefined();
    expect(userOrgMemberships.orgId).toBeDefined();
    expect(userOrgMemberships.role).toBeDefined();
    expect(userOrgMemberships.createdAt).toBeDefined();
    expect(userOrgMemberships.updatedAt).toBeDefined();
  });

  test("authzOutbox table has required columns", () => {
    expect(authzOutbox.id).toBeDefined();
    expect(authzOutbox.operation).toBeDefined();
    expect(authzOutbox.resourceType).toBeDefined();
    expect(authzOutbox.resourceId).toBeDefined();
    expect(authzOutbox.relation).toBeDefined();
    expect(authzOutbox.subjectType).toBeDefined();
    expect(authzOutbox.subjectId).toBeDefined();
    expect(authzOutbox.subjectRelation).toBeDefined();
    expect(authzOutbox.status).toBeDefined();
    expect(authzOutbox.attempts).toBeDefined();
    expect(authzOutbox.lastError).toBeDefined();
    expect(authzOutbox.payload).toBeDefined();
    expect(authzOutbox.nextAttemptAt).toBeDefined();
    expect(authzOutbox.processedAt).toBeDefined();
  });

  test("authzShadowDiffs table has required columns", () => {
    expect(authzShadowDiffs.id).toBeDefined();
    expect(authzShadowDiffs.actorUserId).toBeDefined();
    expect(authzShadowDiffs.resourceType).toBeDefined();
    expect(authzShadowDiffs.resourceId).toBeDefined();
    expect(authzShadowDiffs.permission).toBeDefined();
    expect(authzShadowDiffs.localAllowed).toBeDefined();
    expect(authzShadowDiffs.spiceAllowed).toBeDefined();
    expect(authzShadowDiffs.spiceError).toBeDefined();
    expect(authzShadowDiffs.context).toBeDefined();
  });

  test("orgs table has required columns", () => {
    expect(orgs.id).toBeDefined();
    expect(orgs.name).toBeDefined();
  });

  test("auditLog table has required columns", () => {
    expect(auditLog.id).toBeDefined();
    expect(auditLog.actor).toBeDefined();
    expect(auditLog.action).toBeDefined();
    expect(auditLog.target).toBeDefined();
  });

  // per-agent client cert ledger for mTLS.
  test("agentCerts table has required columns", () => {
    expect(agentCerts.id).toBeDefined();
    expect(agentCerts.agentId).toBeDefined();
    expect(agentCerts.fingerprintSha256).toBeDefined();
    expect(agentCerts.subjectCn).toBeDefined();
    expect(agentCerts.certPem).toBeDefined();
    expect(agentCerts.issuedAt).toBeDefined();
    expect(agentCerts.expiresAt).toBeDefined();
    expect(agentCerts.revokedAt).toBeDefined();
  });

  // desensitization framework storage.
  test("desensitizeAliasMap table has required columns", () => {
    expect(desensitizeAliasMap.aliasId).toBeDefined();
    expect(desensitizeAliasMap.salt).toBeDefined();
    expect(desensitizeAliasMap.originalValue).toBeDefined();
    expect(desensitizeAliasMap.createdAt).toBeDefined();
    expect(desensitizeAliasMap.lastSeenAt).toBeDefined();
  });

  test("desensitizeConfig table has required columns", () => {
    expect(desensitizeConfig.id).toBeDefined();
    expect(desensitizeConfig.scope).toBeDefined();
    expect(desensitizeConfig.scopeId).toBeDefined();
    expect(desensitizeConfig.fieldPath).toBeDefined();
    expect(desensitizeConfig.action).toBeDefined();
    expect(desensitizeConfig.updatedAt).toBeDefined();
  });

  // software governance — per-agent (or global) policy
  test("softwarePolicies table has required columns", () => {
    expect(softwarePolicies.id).toBeDefined();
    expect(softwarePolicies.agentId).toBeDefined();
    expect(softwarePolicies.scope).toBeDefined();
    expect(softwarePolicies.allowList).toBeDefined();
    expect(softwarePolicies.denyList).toBeDefined();
    expect(softwarePolicies.lockEnabled).toBeDefined();
    expect(softwarePolicies.mirrors).toBeDefined();
    expect(softwarePolicies.preinstallList).toBeDefined();
    expect(softwarePolicies.version).toBeDefined();
    expect(softwarePolicies.updatedAt).toBeDefined();
  });

  test("softwarePolicyOverlays table has usecase operation policy columns", () => {
    expect(softwarePolicyOverlays.usecaseDefaultAllow).toBeDefined();
    expect(softwarePolicyOverlays.usecaseAllowList).toBeDefined();
    expect(softwarePolicyOverlays.usecaseDenyList).toBeDefined();
  });

  // per-agent installed-software ledger
  test("agentInstalledSoftware table has required columns", () => {
    expect(agentInstalledSoftware.id).toBeDefined();
    expect(agentInstalledSoftware.agentId).toBeDefined();
    expect(agentInstalledSoftware.name).toBeDefined();
    expect(agentInstalledSoftware.version).toBeDefined();
    expect(agentInstalledSoftware.compiler).toBeDefined();
    expect(agentInstalledSoftware.hash).toBeDefined();
    expect(agentInstalledSoftware.spec).toBeDefined();
    expect(agentInstalledSoftware.reportedAt).toBeDefined();
  });

  test("softwareOperations table has required columns", () => {
    expect(softwareOperations.id).toBeDefined();
    expect(softwareOperations.agentId).toBeDefined();
    expect(softwareOperations.requestedBy).toBeDefined();
    expect(softwareOperations.requestedBy.columnType).toBe("PgVarchar");
    expect(softwareOperations.requestedBy.getSQLType()).toBe("varchar(255)");
    expect(softwareOperations.action).toBeDefined();
    expect(softwareOperations.spec).toBeDefined();
    expect(softwareOperations.status).toBeDefined();
    expect(softwareOperations.stdout).toBeDefined();
    expect(softwareOperations.stderr).toBeDefined();
    expect(softwareOperations.exitCode).toBeDefined();
    expect(softwareOperations.error).toBeDefined();
    expect(softwareOperations.requestedAt).toBeDefined();
    expect(softwareOperations.startedAt).toBeDefined();
    expect(softwareOperations.finishedAt).toBeDefined();
    expect(softwareOperations.updatedAt).toBeDefined();
  });

  // per-metric append-only series (TimescaleDB-friendly)
  test("agentMetrics table has required columns", () => {
    expect(agentMetrics.id).toBeDefined();
    expect(agentMetrics.agentId).toBeDefined();
    expect(agentMetrics.metric).toBeDefined();
    expect(agentMetrics.value).toBeDefined();
    expect(agentMetrics.payload).toBeDefined();
    expect(agentMetrics.ts).toBeDefined();
  });

  test("queue observability tables keep durable event claims separate from counters", () => {
    expect(queueObservabilityEvents.agentId).toBeDefined();
    expect(queueObservabilityEvents.eventId).toBeDefined();
    expect(queueObservabilityEvents.metric).toBeDefined();
    expect(queueObservabilityEvents.failureCode).toBeDefined();
    expect(queueObservabilityCounters.metric).toBeDefined();
    expect(queueObservabilityCounters.failureCode).toBeDefined();
    expect(queueObservabilityCounters.count).toBeDefined();
  });

  // singleton SSO/OIDC configuration row (PRD F1.1 / F1.3).
  test("ssoConfig table has required columns", () => {
    expect(ssoConfig.singletonId).toBeDefined();
    expect(ssoConfig.enabled).toBeDefined();
    expect(ssoConfig.providerType).toBeDefined();
    expect(ssoConfig.providerDisplayName).toBeDefined();
    expect(ssoConfig.loginWelcomeZh).toBeDefined();
    expect(ssoConfig.loginWelcomeEn).toBeDefined();
    expect(ssoConfig.issuerUrl).toBeDefined();
    expect(ssoConfig.clientId).toBeDefined();
    expect(ssoConfig.clientSecretEncrypted).toBeDefined();
    expect(ssoConfig.redirectUri).toBeDefined();
    expect(ssoConfig.groupMapping).toBeDefined();
    expect(ssoConfig.autoCreateUsers).toBeDefined();
    expect(ssoConfig.updatedAt).toBeDefined();
    expect(ssoConfig.updatedBy).toBeDefined();
  });

  test("platformBranding table has localized identity and asset columns", () => {
    expect(platformBranding.singletonId).toBeDefined();
    expect(platformBranding.locales).toBeDefined();
    expect(platformBranding.logoUrl).toBeDefined();
    expect(platformBranding.faviconUrl).toBeDefined();
    expect(platformBranding.updatedAt).toBeDefined();
    expect(platformBranding.updatedBy).toBeDefined();
  });
});
