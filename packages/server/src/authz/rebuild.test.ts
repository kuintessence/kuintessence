import { describe, expect, test } from "bun:test";
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
import { buildAuthzRebuildPlan } from "./rebuild";

function fakeDb(rowsByTable: Map<unknown, unknown[]>): PgDb {
  return {
    select: () => ({
      from: (table: unknown) => rowsByTable.get(table) ?? [],
    }),
  } as unknown as PgDb;
}

function emptyRebuildTables(overrides: Map<unknown, unknown[]>): Map<unknown, unknown[]> {
  return new Map<unknown, unknown[]>([
    [orgs, []],
    [users, []],
    [userOrgMemberships, []],
    [agents, []],
    [schedulerQueues, []],
    [jobs, []],
    [netdriveFiles, []],
    [clusterFileRoots, []],
    [softwareAssets, []],
    [softwareAssetGrants, []],
    [sshCredentials, []],
    [sshRecordings, []],
    [userCapabilities, []],
    [workflowRuns, []],
    [dataAssets, []],
    [dataGrants, []],
    [dataAccessPolicies, []],
    ...overrides,
  ]);
}

describe("buildAuthzRebuildPlan", () => {
  test("rebuilds job provider from the immutable job snapshot", async () => {
    const historicalProviderId = "00000000-0000-4000-8000-0000000000a1";
    const currentProviderId = "00000000-0000-4000-8000-0000000000a2";
    const jobId = "00000000-0000-4000-8000-0000000000b1";
    const agentId = "agent-rebound";
    const plan = await buildAuthzRebuildPlan(
      fakeDb(
        emptyRebuildTables(
          new Map<unknown, unknown[]>([
            [orgs, [{ id: historicalProviderId }, { id: currentProviderId }]],
            [agents, [{ agentId, providerOrgId: currentProviderId }]],
            [
              jobs,
              [
                {
                  id: jobId,
                  submittedBy: null,
                  orgId: null,
                  providerOrgId: historicalProviderId,
                  queueId: null,
                  agentId,
                },
              ],
            ],
          ]),
        ),
      ),
    );

    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "job", id: jobId },
      relation: "provider",
      subject: { type: "provider", id: historicalProviderId },
    });
    expect(plan.tuples).not.toContainEqual({
      operation: "create",
      resource: { type: "job", id: jobId },
      relation: "provider",
      subject: { type: "provider", id: currentProviderId },
    });
  });

  test("rebuilds job consumer_org from membership when the job org snapshot is missing", async () => {
    const userId = "00000000-0000-4000-8000-000000000001";
    const orgId = "00000000-0000-4000-8000-0000000000a1";
    const jobId = "00000000-0000-4000-8000-0000000000b2";

    const plan = await buildAuthzRebuildPlan(
      fakeDb(
        emptyRebuildTables(
          new Map<unknown, unknown[]>([
            [orgs, [{ id: orgId }]],
            [users, [{ id: userId, email: "rebuild@test.local", role: "user" }]],
            [
              userOrgMemberships,
              [
                {
                  userId,
                  orgId,
                  role: "member",
                  createdAt: new Date("2026-01-01T00:00:00Z"),
                },
              ],
            ],
            [
              jobs,
              [
                {
                  id: jobId,
                  submittedBy: userId,
                  orgId: null,
                  queueId: null,
                  agentId: null,
                },
              ],
            ],
          ]),
        ),
      ),
    );

    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "job", id: jobId },
      relation: "consumer_org",
      subject: { type: "organization", id: orgId },
    });
    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "platform", id: "root" },
      relation: "member",
      subject: { type: "user", id: userId },
    });
  });

  test("preserves workflow org snapshots and only falls back for rows without an org field", async () => {
    const userId = "00000000-0000-4000-8000-000000000011";
    const primaryOrgId = "00000000-0000-4000-8000-0000000000a1";
    const selectedOrgId = "00000000-0000-4000-8000-0000000000a2";
    const explicitOrgWorkflowId = "00000000-0000-4000-8000-0000000000b1";
    const explicitNullWorkflowId = "00000000-0000-4000-8000-0000000000b2";
    const missingOrgWorkflowId = "00000000-0000-4000-8000-0000000000b3";

    const plan = await buildAuthzRebuildPlan(
      fakeDb(
        emptyRebuildTables(
          new Map<unknown, unknown[]>([
            [orgs, [{ id: primaryOrgId }, { id: selectedOrgId }]],
            [users, [{ id: userId, email: "workflow-rebuild@test.local", role: "user" }]],
            [
              userOrgMemberships,
              [
                {
                  userId,
                  orgId: primaryOrgId,
                  role: "member",
                  createdAt: new Date("2026-01-01T00:00:00Z"),
                },
                {
                  userId,
                  orgId: selectedOrgId,
                  role: "member",
                  createdAt: new Date("2026-02-01T00:00:00Z"),
                },
              ],
            ],
            [
              workflowRuns,
              [
                {
                  id: explicitOrgWorkflowId,
                  submittedBy: userId,
                  input: { yaml: "name: explicit", role: "user", orgId: selectedOrgId },
                },
                {
                  id: explicitNullWorkflowId,
                  submittedBy: userId,
                  input: { yaml: "name: no-org", role: "user", orgId: null },
                },
                {
                  id: missingOrgWorkflowId,
                  submittedBy: userId,
                  input: { yaml: "name: legacy", role: "user" },
                },
              ],
            ],
          ]),
        ),
      ),
    );

    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "workflow", id: explicitOrgWorkflowId },
      relation: "consumer_org",
      subject: { type: "organization", id: selectedOrgId },
    });
    expect(plan.tuples).not.toContainEqual({
      operation: "create",
      resource: { type: "workflow", id: explicitOrgWorkflowId },
      relation: "consumer_org",
      subject: { type: "organization", id: primaryOrgId },
    });
    expect(
      plan.tuples.filter(
        (tuple) =>
          tuple.resource.type === "workflow" &&
          tuple.resource.id === explicitNullWorkflowId &&
          tuple.relation === "consumer_org",
      ),
    ).toEqual([]);
    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "workflow", id: missingOrgWorkflowId },
      relation: "consumer_org",
      subject: { type: "organization", id: primaryOrgId },
    });
  });

  test("rebuilds platform-public software asset grants from asset visibility", async () => {
    const privateAssetId = "00000000-0000-4000-8000-0000000000c0";
    const publicAssetId = "00000000-0000-4000-8000-0000000000c1";
    const trustedAssetId = "00000000-0000-4000-8000-0000000000c2";
    const deprecatedAssetId = "00000000-0000-4000-8000-0000000000c3";

    const plan = await buildAuthzRebuildPlan(
      fakeDb(
        emptyRebuildTables(
          new Map<unknown, unknown[]>([
            [
              softwareAssets,
              [
                {
                  id: privateAssetId,
                  ownerUserId: null,
                  ownerOrgId: null,
                  providerOrgId: null,
                  visibility: "private",
                  lifecycle: "published",
                  trustedForGlobalUse: false,
                },
                {
                  id: publicAssetId,
                  ownerUserId: null,
                  ownerOrgId: null,
                  providerOrgId: null,
                  visibility: "platform-public",
                  lifecycle: "published",
                  trustedForGlobalUse: false,
                },
                {
                  id: trustedAssetId,
                  ownerUserId: null,
                  ownerOrgId: null,
                  providerOrgId: null,
                  visibility: "platform-public",
                  lifecycle: "published",
                  trustedForGlobalUse: true,
                },
                {
                  id: deprecatedAssetId,
                  ownerUserId: null,
                  ownerOrgId: null,
                  providerOrgId: null,
                  visibility: "platform-public",
                  lifecycle: "deprecated",
                  trustedForGlobalUse: true,
                },
              ],
            ],
          ]),
        ),
      ),
    );

    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: privateAssetId },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(plan.tuples).not.toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: privateAssetId },
      relation: "viewer",
      subject: { type: "platform", id: "root", relation: "software_view" },
    });
    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: publicAssetId },
      relation: "viewer",
      subject: { type: "platform", id: "root", relation: "software_view" },
    });
    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: publicAssetId },
      relation: "user",
      subject: { type: "platform", id: "root", relation: "software_use" },
    });
    expect(plan.tuples).not.toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: publicAssetId },
      relation: "installer",
      subject: { type: "platform", id: "root", relation: "software_use" },
    });
    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: trustedAssetId },
      relation: "installer",
      subject: { type: "platform", id: "root", relation: "software_use" },
    });
    expect(plan.tuples).not.toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: deprecatedAssetId },
      relation: "viewer",
      subject: { type: "platform", id: "root", relation: "software_view" },
    });
  });

  test("rebuilds active asset-wide data grants and policies", async () => {
    const assetId = "00000000-0000-4000-8000-0000000000c3";
    const userId = "00000000-0000-4000-8000-0000000000c4";
    const expiredUserId = "00000000-0000-4000-8000-0000000000c8";
    const orgId = "00000000-0000-4000-8000-0000000000c5";
    const plan = await buildAuthzRebuildPlan(
      fakeDb(
        emptyRebuildTables(
          new Map<unknown, unknown[]>([
            [
              dataAssets,
              [
                {
                  id: assetId,
                  ownerKind: "user",
                  ownerUserId: userId,
                  ownerOrgId: null,
                  providerOrgId: null,
                  visibility: "private",
                  accessMode: "request",
                },
              ],
            ],
            [
              dataGrants,
              [
                {
                  dataAssetId: assetId,
                  dataAssetVersionId: null,
                  subjectKind: "user",
                  subjectId: userId,
                  capabilities: ["download"],
                  status: "active",
                  expiresAt: null,
                },
                {
                  dataAssetId: assetId,
                  dataAssetVersionId: null,
                  subjectKind: "user",
                  subjectId: expiredUserId,
                  capabilities: ["use"],
                  status: "active",
                  expiresAt: new Date("2000-01-01T00:00:00.000Z"),
                },
              ],
            ],
            [
              dataAccessPolicies,
              [
                {
                  dataAssetId: assetId,
                  dataAssetVersionId: null,
                  subjectKind: "org",
                  subjectId: orgId,
                  capabilities: ["derive"],
                  effect: "allow",
                  status: "active",
                  expiresAt: null,
                },
              ],
            ],
          ]),
        ),
      ),
    );

    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "data_asset", id: assetId },
      relation: "owner",
      subject: { type: "user", id: userId },
    });
    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "data_asset", id: assetId },
      relation: "downloader",
      subject: { type: "user", id: userId },
    });
    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "data_asset", id: assetId },
      relation: "deriver",
      subject: { type: "organization", id: orgId, relation: "use" },
    });
    expect(plan.tuples).not.toContainEqual({
      operation: "create",
      resource: { type: "data_asset", id: assetId },
      relation: "user",
      subject: { type: "user", id: expiredUserId },
    });
  });

  test("does not publish reviewing data assets to platform members", async () => {
    const reviewingAssetId = "00000000-0000-4000-8000-0000000000c6";
    const publishedAssetId = "00000000-0000-4000-8000-0000000000c7";
    const plan = await buildAuthzRebuildPlan(
      fakeDb(
        emptyRebuildTables(
          new Map<unknown, unknown[]>([
            [
              dataAssets,
              [
                {
                  id: reviewingAssetId,
                  ownerKind: "provider",
                  ownerUserId: null,
                  ownerOrgId: null,
                  providerOrgId: "00000000-0000-4000-8000-0000000000c8",
                  visibility: "public",
                  lifecycle: "reviewing",
                  accessMode: "open",
                },
                {
                  id: publishedAssetId,
                  ownerKind: "provider",
                  ownerUserId: null,
                  ownerOrgId: null,
                  providerOrgId: "00000000-0000-4000-8000-0000000000c8",
                  visibility: "public",
                  lifecycle: "published",
                  accessMode: "open",
                },
              ],
            ],
          ]),
        ),
      ),
    );

    expect(plan.tuples).not.toContainEqual({
      operation: "create",
      resource: { type: "data_asset", id: reviewingAssetId },
      relation: "viewer",
      subject: { type: "platform", id: "root", relation: "software_view" },
    });
    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "data_asset", id: publishedAssetId },
      relation: "user",
      subject: { type: "platform", id: "root", relation: "software_use" },
    });
  });

  test("rebuilds platform operator relations from user roles", async () => {
    const operatorId = "00000000-0000-4000-8000-0000000000d1";
    const userId = "00000000-0000-4000-8000-0000000000d2";

    const plan = await buildAuthzRebuildPlan(
      fakeDb(
        emptyRebuildTables(
          new Map<unknown, unknown[]>([
            [
              users,
              [
                { id: operatorId, email: "operator@test.local", role: "operator" },
                { id: userId, email: "user@test.local", role: "user" },
              ],
            ],
          ]),
        ),
      ),
    );

    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "platform", id: "root" },
      relation: "operator",
      subject: { type: "user", id: operatorId },
    });
    expect(plan.tuples).not.toContainEqual({
      operation: "create",
      resource: { type: "platform", id: "root" },
      relation: "operator",
      subject: { type: "user", id: userId },
    });
  });

  test("rebuilds the independent auditor relation from an audit capability", async () => {
    const userId = "00000000-0000-4000-8000-0000000000d3";
    const plan = await buildAuthzRebuildPlan(
      fakeDb(
        emptyRebuildTables(
          new Map<unknown, unknown[]>([
            [users, [{ id: userId, email: "auditor@test.local", role: "user" }]],
            [userCapabilities, [{ userId, capability: "audit_readonly" }]],
          ]),
        ),
      ),
    );

    expect(plan.tuples).toContainEqual({
      operation: "create",
      resource: { type: "platform", id: "root" },
      relation: "auditor",
      subject: { type: "user", id: userId },
    });
  });

  test("rebuilds direct platform relations for platform-scoped resources", async () => {
    const orgId = "00000000-0000-4000-8000-0000000000a1";
    const userId = "00000000-0000-4000-8000-0000000000a2";
    const agentId = "agent-rebuild";
    const queueId = "queue-rebuild";
    const jobId = "00000000-0000-4000-8000-0000000000e1";
    const fileId = "00000000-0000-4000-8000-0000000000e2";
    const workflowId = "00000000-0000-4000-8000-0000000000e3";
    const rootId = "00000000-0000-4000-8000-0000000000f1";
    const assetId = "00000000-0000-4000-8000-0000000000f2";
    const sessionId = "recording-rebuild";

    const plan = await buildAuthzRebuildPlan(
      fakeDb(
        emptyRebuildTables(
          new Map<unknown, unknown[]>([
            [orgs, [{ id: orgId }]],
            [users, [{ id: userId, email: "platform-rebuild@test.local", role: "user" }]],
            [
              userOrgMemberships,
              [{ userId, orgId, role: "member", createdAt: new Date("2026-01-01T00:00:00Z") }],
            ],
            [agents, [{ agentId, providerOrgId: orgId }]],
            [
              schedulerQueues,
              [
                {
                  queueId,
                  providerOrgId: orgId,
                  visibleOrgIds: [],
                },
              ],
            ],
            [jobs, [{ id: jobId, submittedBy: userId, orgId, queueId, agentId }]],
            [netdriveFiles, [{ id: fileId, ownerId: userId, deletedAt: null }]],
            [workflowRuns, [{ id: workflowId, submittedBy: userId }]],
            [
              clusterFileRoots,
              [
                {
                  id: rootId,
                  providerOrgId: orgId,
                  visibleOrgIds: [],
                },
              ],
            ],
            [
              softwareAssets,
              [
                {
                  id: assetId,
                  ownerUserId: userId,
                  ownerOrgId: null,
                  providerOrgId: null,
                  visibility: "private",
                  trustedForGlobalUse: false,
                },
              ],
            ],
            [sshCredentials, [{ agentId }]],
            [sshRecordings, [{ agentId, sessionId, actorUser: null }]],
          ]),
        ),
      ),
    );

    const expectedPlatformRelations = [
      { type: "provider", id: orgId },
      { type: "agent", id: agentId },
      { type: "queue", id: queueId },
      { type: "job", id: jobId },
      { type: "netdrive_file", id: fileId },
      { type: "workflow", id: workflowId },
      { type: "cluster_file_root", id: rootId },
      { type: "software_asset", id: assetId },
      { type: "ssh_credential", id: agentId },
      { type: "ssh_recording", id: sessionId },
    ];
    for (const resource of expectedPlatformRelations) {
      expect(plan.tuples).toContainEqual({
        operation: "create",
        resource,
        relation: "platform",
        subject: { type: "platform", id: "root" },
      });
    }
  });
});
