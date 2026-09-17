import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type AuthorizationSubjectId = `user:${string}` | `organization:${string}`;

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: varchar("external_id", { length: 255 }).unique(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  displayName: varchar("display_name", { length: 255 }),
  role: varchar("role", { length: 50 }).notNull().default("user"),
  orgId: uuid("org_id").references(() => orgs.id),
  // Migration 0012 — CP Console suspend toggle. When true the auth
  // middleware refuses new sessions and the placement orchestrator
  // refuses new jobs while preserving history.
  suspended: boolean("suspended").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    activeOrgId: uuid("active_org_id").references(() => orgs.id, { onDelete: "set null" }),
    familyId: uuid("family_id").notNull(),
    currentRefreshJtiHash: varchar("current_refresh_jti_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    lastUsedAt: timestamp("last_used_at").defaultNow().notNull(),
    rotatedAt: timestamp("rotated_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
    revokedReason: varchar("revoked_reason", { length: 32 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    activeRefreshTokenIdx: uniqueIndex("auth_sessions_active_refresh_jti_idx").on(
      t.currentRefreshJtiHash,
    ),
    userSessionIdx: index("auth_sessions_user_created_at_idx").on(t.userId, t.createdAt),
    familyIdx: index("auth_sessions_family_idx").on(t.familyId),
    revokedReasonCheck: check(
      "auth_sessions_revoked_reason_check",
      sql`${t.revokedReason} IS NULL OR ${t.revokedReason} IN ('logout', 'replay', 'admin')`,
    ),
  }),
);

export const userOrgMemberships = pgTable(
  "user_org_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    role: varchar("role", { length: 32 }).notNull().default("member"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userOrgIdx: uniqueIndex("user_org_memberships_user_org_idx").on(t.userId, t.orgId),
    orgRoleIdx: index("user_org_memberships_org_role_idx").on(t.orgId, t.role),
    roleCheck: check(
      "user_org_memberships_role_check",
      sql`${t.role} IN ('owner', 'admin', 'operator', 'member', 'viewer')`,
    ),
  }),
);

export const userCapabilities = pgTable(
  "user_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    capability: varchar("capability", { length: 64 }).notNull(),
    grantedBy: uuid("granted_by").references(() => users.id),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
  },
  (t) => ({
    userCapabilityIdx: uniqueIndex("user_capabilities_user_capability_idx").on(
      t.userId,
      t.capability,
    ),
    capabilityCheck: check(
      "user_capabilities_capability_check",
      sql`${t.capability} IN ('software_provider', 'audit_readonly')`,
    ),
  }),
);

export const authzOutbox = pgTable(
  "authz_outbox",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    operation: varchar("operation", { length: 32 }).notNull(),
    resourceType: varchar("resource_type", { length: 128 }).notNull(),
    resourceId: varchar("resource_id", { length: 512 }).notNull(),
    relation: varchar("relation", { length: 128 }).notNull(),
    subjectType: varchar("subject_type", { length: 128 }).notNull(),
    subjectId: varchar("subject_id", { length: 512 }).notNull(),
    subjectRelation: varchar("subject_relation", { length: 128 }),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
  },
  (t) => ({
    statusNextAttemptIdx: index("authz_outbox_status_next_attempt_idx").on(
      t.status,
      t.nextAttemptAt,
    ),
    tupleIdx: index("authz_outbox_tuple_idx").on(
      t.resourceType,
      t.resourceId,
      t.relation,
      t.subjectType,
      t.subjectId,
    ),
    resourceSequenceIdx: index("authz_outbox_resource_sequence_idx").on(
      t.resourceType,
      t.resourceId,
      t.sequence,
    ),
    operationCheck: check(
      "authz_outbox_operation_check",
      sql`${t.operation} IN ('touch_schema', 'create', 'delete')`,
    ),
    statusCheck: check(
      "authz_outbox_status_check",
      sql`${t.status} IN ('pending', 'processing', 'succeeded', 'dead')`,
    ),
  }),
);

/** Durable Server→Agent data-revocation command. It is retained until the
 * Agent confirms that the local revoke intent and cleanup have completed. */
export const dataDeliveryRevocations = pgTable(
  "data_delivery_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .references(() => jobs.id, { onDelete: "cascade" })
      .notNull(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    reasonCode: varchar("reason_code", { length: 128 }).notNull(),
    destroyRestrictedWorkRoot: boolean("destroy_restricted_work_root").notNull().default(false),
    revokedEpoch: integer("revoked_epoch").notNull().default(0),
    acknowledgedAt: timestamp("acknowledged_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pendingAgentIdx: index("data_delivery_revocations_pending_agent_idx").on(
      t.agentId,
      t.acknowledgedAt,
      t.createdAt,
    ),
    jobReasonUnique: uniqueIndex("data_delivery_revocations_job_reason_idx").on(
      t.jobId,
      t.reasonCode,
    ),
  }),
);

/** Durable Server→Agent scheduler-cancellation command. A row remains pending
 * until the target Agent has durably fenced the job and converged its local
 * scheduler state. */
export const jobCancellations = pgTable(
  "job_cancellations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .references(() => jobs.id, { onDelete: "cascade" })
      .notNull(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    revokedEpoch: integer("revoked_epoch").notNull().default(0),
    acknowledgedAt: timestamp("acknowledged_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pendingAgentIdx: index("job_cancellations_pending_agent_idx").on(
      t.agentId,
      t.acknowledgedAt,
      t.createdAt,
    ),
    jobUnique: uniqueIndex("job_cancellations_job_idx").on(t.jobId),
    revokedEpochCheck: check("job_cancellations_revoked_epoch_check", sql`${t.revokedEpoch} >= 0`),
  }),
);

export const jobWorkRootReleases = pgTable(
  "job_work_root_releases",
  {
    jobId: uuid("job_id")
      .primaryKey()
      .references(() => jobs.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    acknowledgedAt: timestamp("acknowledged_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    pendingAgentIdx: index("job_work_root_releases_pending_agent_idx").on(
      t.agentId,
      t.acknowledgedAt,
      t.createdAt,
    ),
  }),
);

export const authzShadowDiffs = pgTable(
  "authz_shadow_diffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: varchar("actor_email", { length: 255 }),
    resourceType: varchar("resource_type", { length: 128 }).notNull(),
    resourceId: varchar("resource_id", { length: 512 }).notNull(),
    permission: varchar("permission", { length: 128 }).notNull(),
    localAllowed: boolean("local_allowed").notNull(),
    spiceAllowed: boolean("spice_allowed").notNull(),
    spiceError: text("spice_error"),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    resourcePermissionIdx: index("authz_shadow_diffs_resource_permission_idx").on(
      t.resourceType,
      t.resourceId,
      t.permission,
    ),
    createdAtIdx: index("authz_shadow_diffs_created_at_idx").on(t.createdAt),
  }),
);

export const agents = pgTable(
  "agents",
  {
    agentId: varchar("agent_id", { length: 255 }).primaryKey(),
    siteName: varchar("site_name", { length: 255 }).notNull(),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id),
    siteId: varchar("site_id", { length: 255 }),
    clusterId: varchar("cluster_id", { length: 255 }),
    topology: jsonb("topology").$type<Record<string, unknown>>().notNull().default({}),
    schedulerType: varchar("scheduler_type", { length: 50 }).notNull(),
    schedulerVersion: varchar("scheduler_version", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("offline"),
    lastHeartbeat: timestamp("last_heartbeat"),
    computeHealthCapable: boolean("compute_health_capable").notNull().default(false),
    computeHealthStatus: varchar("compute_health_status", { length: 20 })
      .notNull()
      .default("unknown"),
    computeHealthObservedAt: timestamp("compute_health_observed_at"),
    computeHealthReason: varchar("compute_health_reason", { length: 64 }),
    computeHealthNodeCount: integer("compute_health_node_count"),
    computeHealthOperationalNodeCount: integer("compute_health_operational_node_count"),
    cpuUsagePercent: integer("cpu_usage_percent"),
    memoryUsedMb: bigint("memory_used_mb", { mode: "number" }),
    memoryTotalMb: bigint("memory_total_mb", { mode: "number" }),
    maxConcurrentJobs: integer("max_concurrent_jobs").notNull().default(100),
    /**
     * Migration 0013 — heartbeat-populated queue depth and historical
     * 95th-percentile wait time. Used directly by the scheduler scoring
     * layer (`toAgentCandidate`) and the CP-Console `QueueDepthSamplerPort`.
     */
    queueDepth: integer("queue_depth").notNull().default(0),
    historicalP95WaitSec: integer("historical_p95_wait_sec").notNull().default(0),
    rootMode: boolean("root_mode").notNull().default(false),
    sandboxReadiness: varchar("sandbox_readiness", { length: 20 }).notNull().default("critical"),
    sandboxCapabilities: jsonb("sandbox_capabilities")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    sandboxRuntimeCache: jsonb("sandbox_runtime_cache")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    restrictedDataIsolation: boolean("restricted_data_isolation").notNull().default(false),
    registeredAt: timestamp("registered_at").defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index("agents_status_idx").on(t.status),
    providerOrgIdx: index("agents_provider_org_idx").on(t.providerOrgId),
    siteClusterIdx: index("agents_site_cluster_idx").on(t.siteId, t.clusterId),
    statusCheck: check(
      "agents_status_check",
      sql`${t.status} IN ('online', 'offline', 'unhealthy')`,
    ),
    computeHealthStatusCheck: check(
      "agents_compute_health_status_check",
      sql`${t.computeHealthStatus} IN ('unknown', 'ready', 'unavailable')`,
    ),
    computeHealthNodeCountsCheck: check(
      "agents_compute_health_node_counts_check",
      sql`
        (${t.computeHealthNodeCount} IS NULL OR ${t.computeHealthNodeCount} >= 0)
        AND (${t.computeHealthOperationalNodeCount} IS NULL OR ${t.computeHealthOperationalNodeCount} >= 0)
        AND (
          ${t.computeHealthNodeCount} IS NULL
          OR ${t.computeHealthOperationalNodeCount} IS NULL
          OR ${t.computeHealthOperationalNodeCount} <= ${t.computeHealthNodeCount}
        )
      `,
    ),
    sandboxReadinessCheck: check(
      "agents_sandbox_readiness_check",
      sql`${t.sandboxReadiness} IN ('ready', 'degraded', 'critical')`,
    ),
  }),
);

export const agentRegistrationIntents = pgTable(
  "agent_registration_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 }).notNull(),
    siteName: varchar("site_name", { length: 255 }).notNull(),
    providerOrgId: uuid("provider_org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    revokedAt: timestamp("revoked_at"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    activeAgentIdx: uniqueIndex("agent_registration_intents_active_agent_idx")
      .on(t.agentId)
      .where(sql`${t.usedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    providerIdx: index("agent_registration_intents_provider_idx").on(t.providerOrgId),
    activeIdx: index("agent_registration_intents_active_idx").on(
      t.providerOrgId,
      t.expiresAt,
      t.usedAt,
      t.revokedAt,
    ),
  }),
);

export const schedulerQueues = pgTable(
  "scheduler_queues",
  {
    queueId: varchar("queue_id", { length: 255 }).primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    providerOrgId: uuid("provider_org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    visibleOrgIds: jsonb("visible_org_ids").$type<string[]>().notNull().default([]),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    schedulerType: varchar("scheduler_type", { length: 50 }).notNull(),
    targetMode: varchar("target_mode", { length: 16 }).notNull().default("named"),
    queueName: varchar("queue_name", { length: 255 }),
    qos: varchar("qos", { length: 255 }),
    enabled: boolean("enabled").notNull().default(true),
    policyTags: jsonb("policy_tags").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    providerIdx: index("scheduler_queues_provider_idx").on(t.providerOrgId),
    agentIdx: index("scheduler_queues_agent_idx").on(t.agentId),
    enabledIdx: index("scheduler_queues_enabled_idx").on(t.enabled),
    agentQueueQosIdx: uniqueIndex("scheduler_queues_agent_queue_qos_idx").on(
      t.agentId,
      t.queueName,
      t.qos,
    ),
    targetModeCheck: check(
      "scheduler_queues_target_mode_check",
      sql`${t.targetMode} IN ('default', 'named')`,
    ),
    targetQueueNameCheck: check(
      "scheduler_queues_target_queue_name_check",
      sql`(${t.targetMode} = 'default' AND ${t.queueName} IS NULL) OR (${t.targetMode} = 'named' AND ${t.queueName} IS NOT NULL)`,
    ),
  }),
);

export const agentSchedulerQueueSnapshots = pgTable(
  "agent_scheduler_queue_snapshots",
  {
    agentId: varchar("agent_id", { length: 255 })
      .primaryKey()
      .references(() => agents.agentId, { onDelete: "cascade" }),
    queueInventoryV1: boolean("queue_inventory_v1").notNull().default(false),
    status: varchar("status", { length: 32 }).notNull().default("unknown"),
    defaultQueueName: varchar("default_queue_name", { length: 255 }),
    reason: varchar("reason", { length: 64 }),
    observedAt: timestamp("observed_at"),
    lastAttemptAt: timestamp("last_attempt_at"),
    lastSuccessfulObservedAt: timestamp("last_successful_observed_at"),
    lastNoGoAt: timestamp("last_no_go_at"),
    noGoReason: varchar("no_go_reason", { length: 64 }),
    recoveryStartedAt: timestamp("recovery_started_at"),
    recoveredAt: timestamp("recovered_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    statusCheck: check(
      "agent_scheduler_queue_snapshots_status_check",
      sql`${t.status} IN ('unknown', 'available', 'unavailable', 'stale', 'unsupported')`,
    ),
    reasonCheck: check(
      "agent_scheduler_queue_snapshots_reason_check",
      sql`${t.reason} IS NULL OR ${t.reason} IN ('command_failed', 'invalid_output', 'multiple_default_queues', 'default_queue_missing', 'unsupported_scheduler', 'stale', 'unknown')`,
    ),
    noGoReasonCheck: check(
      "agent_scheduler_queue_snapshots_no_go_reason_check",
      sql`${t.noGoReason} IS NULL OR ${t.noGoReason} IN ('command_failed', 'invalid_output', 'multiple_default_queues', 'default_queue_missing', 'unsupported_scheduler', 'stale', 'unknown')`,
    ),
  }),
);

export const agentSchedulerQueues = pgTable(
  "agent_scheduler_queues",
  {
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    queueName: varchar("queue_name", { length: 255 }).notNull(),
    queueType: varchar("queue_type", { length: 32 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    state: varchar("state", { length: 32 }).notNull(),
    acceptsSubmissions: boolean("accepts_submissions").notNull(),
    hasComputeTargets: boolean("has_compute_targets"),
    observedAt: timestamp("observed_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.agentId, t.queueName],
      name: "agent_scheduler_queues_pkey",
    }),
    defaultQueueIdx: uniqueIndex("agent_scheduler_queues_one_default_idx")
      .on(t.agentId)
      .where(sql`${t.isDefault}`),
    stateCheck: check(
      "agent_scheduler_queues_state_check",
      sql`${t.state} IN ('up', 'down', 'unknown')`,
    ),
    typeCheck: check(
      "agent_scheduler_queues_type_check",
      sql`${t.queueType} IN ('partition', 'execution', 'route', 'namespace', 'unknown')`,
    ),
  }),
);

export const clusterFileRoots = pgTable(
  "cluster_file_roots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: varchar("label", { length: 255 }).notNull(),
    providerOrgId: uuid("provider_org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    agentId: varchar("agent_id", { length: 255 }).references(() => agents.agentId, {
      onDelete: "cascade",
    }),
    path: text("path").notNull(),
    capacityBytes: bigint("capacity_bytes", { mode: "number" }),
    visibleOrgIds: jsonb("visible_org_ids").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    providerIdx: index("cluster_file_roots_provider_idx").on(t.providerOrgId),
    agentIdx: index("cluster_file_roots_agent_idx").on(t.agentId),
    enabledIdx: index("cluster_file_roots_enabled_idx").on(t.enabled),
    providerAgentPathIdx: uniqueIndex("cluster_file_roots_provider_agent_path_idx").on(
      t.providerOrgId,
      t.agentId,
      t.path,
    ),
  }),
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    command: text("command").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    dispatchEpoch: integer("dispatch_epoch").notNull().default(0),
    revokedEpoch: integer("revoked_epoch").notNull().default(0),
    agentId: varchar("agent_id", { length: 255 }).references(() => agents.agentId),
    schedulerJobId: varchar("scheduler_job_id", { length: 255 }),
    node: text("scheduler_node"),
    reason: text("scheduler_reason"),
    cpus: integer("cpus").notNull(),
    memoryMb: bigint("memory_mb", { mode: "number" }).notNull(),
    gpus: integer("gpus").default(0),
    wallTimeSec: bigint("wall_time_sec", { mode: "number" }),
    workingDir: text("working_dir"),
    envVars: jsonb("env_vars").$type<Record<string, string>>(),
    exitCode: integer("exit_code"),
    errorMessage: text("error_message"),
    collectedOutputs: jsonb("collected_outputs").$type<Record<string, string>>(),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    /**
     * Workflow-runtime-populated app template key. Mirrors
     * `metering_usage_raw.app_template_key` so CP-Console "top apps" can
     * group jobs without joining the metering table.
     */
    appTemplateKey: varchar("app_template_key", { length: 255 }),
    softwareRequirements:
      jsonb("software_requirements").$type<
        Array<{ name: string; version?: string; installable?: boolean }>
      >(),
    usecasePackageId: uuid("usecase_package_id").references(() => usecasePackages.id),
    usecasePackageName: varchar("usecase_package_name", { length: 255 }),
    usecasePackageVersion: varchar("usecase_package_version", { length: 50 }),
    usecaseInputs: jsonb("usecase_inputs").$type<Record<string, unknown>>(),
    inputStaging:
      jsonb("input_staging").$type<
        Array<{ fileMetadataId: string; stagePath: string; sourceUrl?: string }>
      >(),
    expectedOutputs:
      jsonb("expected_outputs").$type<
        Array<{ descriptor: string; path: string; isBatch: boolean; pathsOnly?: boolean }>
      >(),
    fileOutputDescriptors: jsonb("file_output_descriptors").$type<string[]>(),
    stdinText: text("stdin_text"),
    queueId: varchar("queue_id", { length: 255 }).references(() => schedulerQueues.queueId),
    queueTargetMode: varchar("queue_target_mode", { length: 16 }),
    schedulerQueueName: varchar("scheduler_queue_name", { length: 255 }),
    queueObservedAt: timestamp("queue_observed_at"),
    /**
     * Migration 0013 — submit-time snapshot of `users.org_id`. Stored on the
     * job row so CP-scoped queries (`completedSince`, `topUsersByJobs`,
     * `topAppsByJobs`) can `inArray(jobs.org_id, orgIds)` directly without a
     * users join. NULL on legacy rows until ops backfills.
     */
    orgId: uuid("org_id").references(() => orgs.id),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id),
    /**
     * full 8-stage placement audit trail.
     *
     * Stamped by the orchestrator after `runWithTrace` completes (whether or
     * not an agent was selected) so the Web "Placement trace" tab and the CP
     * Console can explain post-hoc why each candidate was kept or dropped.
     *
     * Shape matches `@kuintessence/shared` `PlacementTrace`. Stored as JSONB
     * rather than a separate table so the trace travels with the job in a
     * single SELECT and a job that has no trace simply has NULL.
     */
    placementTrace: jsonb("placement_trace").$type<unknown>(),
    sandboxExecution: jsonb("sandbox_execution").$type<unknown>(),
    restrictedNoEgress: boolean("restricted_no_egress").notNull().default(false),
  },
  (t) => ({
    statusIdx: index("jobs_status_idx").on(t.status),
    agentStatusIdx: index("jobs_agent_status_idx").on(t.agentId, t.status),
    submittedByIdx: index("jobs_submitted_by_idx").on(t.submittedBy, t.submittedAt),
    orgStatusCompletedIdx: index("jobs_org_status_completed_idx").on(
      t.orgId,
      t.status,
      t.completedAt,
    ),
    providerOrgIdx: index("jobs_provider_org_idx").on(t.providerOrgId),
    queueIdx: index("jobs_queue_idx").on(t.queueId),
    usecasePackageIdx: index("jobs_usecase_package_idx").on(t.usecasePackageId),
    orgAppCompletedIdx: index("jobs_org_app_completed_idx").on(
      t.orgId,
      t.appTemplateKey,
      t.completedAt,
    ),
    queueTargetModeCheck: check(
      "jobs_queue_target_mode_check",
      sql`${t.queueTargetMode} IS NULL OR ${t.queueTargetMode} IN ('default', 'named')`,
    ),
    statusCheck: check(
      "jobs_status_check",
      sql`${t.status} IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
  }),
);

export const agentJobStatusEvents = pgTable(
  "agent_job_status_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    jobId: uuid("job_id")
      .references(() => jobs.id, { onDelete: "cascade" })
      .notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    processedAt: timestamp("processed_at").defaultNow().notNull(),
  },
  (t) => ({
    agentEventIdx: uniqueIndex("agent_job_status_events_agent_event_idx").on(t.agentId, t.eventId),
    jobIdx: index("agent_job_status_events_job_idx").on(t.jobId),
  }),
);

/**
 * Durable claim ledger for low-cardinality queue observability events.
 * Retention of high-volume agent_metrics must not reset these counters.
 */
export const queueObservabilityEvents = pgTable(
  "queue_observability_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    metric: varchar("metric", { length: 64 }).notNull(),
    failureCode: varchar("failure_code", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    agentEventMetricIdx: uniqueIndex("queue_observability_events_agent_event_metric_idx").on(
      t.agentId,
      t.eventId,
      t.metric,
    ),
  }),
);

/** Persisted Prometheus counter source, keyed only by fixed metric/code enums. */
export const queueObservabilityCounters = pgTable(
  "queue_observability_counters",
  {
    metric: varchar("metric", { length: 64 }).notNull(),
    failureCode: varchar("failure_code", { length: 64 }).notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.metric, t.failureCode],
      name: "queue_observability_counters_pkey",
    }),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor: varchar("actor", { length: 255 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    target: varchar("target", { length: 255 }).notNull(),
    diff: jsonb("diff").$type<{ before?: unknown; after?: unknown }>(),
    /**
     * Migration 0013 — write-time snapshot of the acting user's org. Lets
     * `AuditServicePort.search` filter by `inArray(audit_log.org_id, orgIds)`
     * directly without a users-by-actor subquery. NULL on legacy rows until
     * ops backfills.
     */
    orgId: uuid("org_id").references(() => orgs.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    actorCreatedIdx: index("audit_log_actor_created_idx").on(t.actor, t.createdAt),
    orgCreatedIdx: index("audit_log_org_created_idx").on(t.orgId, t.createdAt),
  }),
);

export const appTemplates = pgTable(
  "app_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    version: varchar("version", { length: 50 }).notNull(),
    description: text("description"),
    /** Spack spec or container image reference, e.g. "wrf@4.4 +netcdf". */
    spec: varchar("spec", { length: 500 }).notNull(),
    /** "spack" | "oci" | "module". */
    specKind: varchar("spec_kind", { length: 20 }).notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameVersionIdx: index("app_templates_name_version_idx").on(t.name, t.version),
    specKindCheck: check(
      "app_templates_spec_kind_check",
      sql`${t.specKind} IN ('spack', 'oci', 'module')`,
    ),
  }),
);

export const usecasePackages = pgTable(
  "usecase_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    version: varchar("version", { length: 50 }).notNull(),
    description: text("description"),
    /** Structured UsecasePackage (UsecaseSpec/SoftwareSpec + materials + valueOutputs),
     * validated by UsecasePackageSchema at the service boundary. */
    spec: jsonb("spec").notNull(),
    /** Hash of canonical JSON `spec`; release-backed rows must always have one. */
    specDigest: varchar("spec_digest", { length: 71 }),
    /** Ownership is explicit so an org publisher cannot mutate another namespace. */
    namespace: varchar("namespace", { length: 20 }).notNull().default("platform"),
    ownerSubject: varchar("owner_subject", { length: 255 }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    ownerOrgId: uuid("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    /** Set only for catalog rows pinned by a signed ecosystem release. */
    immutableAt: timestamp("immutable_at"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameVersionIdx: index("usecase_packages_name_version_idx").on(t.name, t.version),
    specDigestIdx: index("usecase_packages_spec_digest_idx").on(t.specDigest),
    ownerIdx: index("usecase_packages_owner_idx").on(t.namespace, t.ownerOrgId, t.ownerUserId),
    namespaceCheck: check(
      "usecase_packages_namespace_check",
      sql`${t.namespace} IN ('platform', 'org', 'user')`,
    ),
  }),
);

/**
 * Content-addressed usecase revisions. A signed release points at this row,
 * never at a mutable logical package payload.
 */
export const usecasePackageRevisions = pgTable(
  "usecase_package_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id")
      .references(() => usecasePackages.id, { onDelete: "cascade" })
      .notNull(),
    revision: integer("revision").notNull(),
    spec: jsonb("spec").notNull(),
    specDigest: varchar("spec_digest", { length: 71 }).notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    immutableAt: timestamp("immutable_at").defaultNow().notNull(),
  },
  (t) => ({
    packageRevisionIdx: uniqueIndex("usecase_package_revisions_package_revision_idx").on(
      t.packageId,
      t.revision,
    ),
    packageDigestIdx: uniqueIndex("usecase_package_revisions_package_digest_idx").on(
      t.packageId,
      t.specDigest,
    ),
    digestIdx: index("usecase_package_revisions_digest_idx").on(t.specDigest),
  }),
);

export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    version: varchar("version", { length: 50 }).notNull(),
    description: text("description"),
    /** YAML content of the workflow spec. */
    yamlContent: text("yaml_content").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    nameVersionIdx: index("workflow_templates_name_version_idx").on(t.name, t.version),
  }),
);

export const softwareAssets = pgTable(
  "software_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: varchar("kind", { length: 32 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    version: varchar("version", { length: 100 }).notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    lifecycle: varchar("lifecycle", { length: 32 }).notNull().default("draft"),
    visibility: varchar("visibility", { length: 32 }).notNull().default("private"),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    ownerOrgId: uuid("owner_org_id").references(() => orgs.id),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id),
    supplierUserId: uuid("supplier_user_id").references(() => users.id),
    supplierOrgId: uuid("supplier_org_id").references(() => orgs.id),
    officialForkOfAssetId: uuid("official_fork_of_asset_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    trustedForGlobalUse: boolean("trusted_for_global_use").notNull().default(false),
    reviewState: jsonb("review_state").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    kindNameVersionIdx: index("software_assets_kind_name_version_idx").on(
      t.kind,
      t.name,
      t.version,
    ),
    lifecycleIdx: index("software_assets_lifecycle_idx").on(t.lifecycle),
    providerIdx: index("software_assets_provider_idx").on(t.providerOrgId),
    sourceIdx: index("software_assets_source_idx").on(t.source),
    officialForkIdx: index("software_assets_official_fork_idx").on(t.officialForkOfAssetId),
    kindCheck: check(
      "software_assets_kind_check",
      sql`${t.kind} IN ('spack-package', 'usecase', 'workflow-template', 'sandbox-script')`,
    ),
    lifecycleCheck: check(
      "software_assets_lifecycle_check",
      sql`${t.lifecycle} IN ('draft', 'submitted', 'approved', 'forked', 'published', 'hidden', 'deprecated', 'revoked', 'archived')`,
    ),
    visibilityCheck: check(
      "software_assets_visibility_check",
      sql`${t.visibility} IN ('private', 'shared-to-orgs', 'platform-public', 'pending-review', 'hidden')`,
    ),
    sourceCheck: check(
      "software_assets_source_check",
      sql`${t.source} IN ('official-upstream', 'platform-fork', 'cp-private', 'cp-shared', 'sp-draft', 'sp-published')`,
    ),
  }),
);

export const softwareAssetRevisions = pgTable(
  "software_asset_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .references(() => softwareAssets.id, { onDelete: "cascade" })
      .notNull(),
    revision: integer("revision").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    recipeSha256: varchar("recipe_sha256", { length: 64 }),
    contentSha256: varchar("content_sha256", { length: 64 }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    assetRevisionIdx: uniqueIndex("software_asset_revisions_asset_revision_idx").on(
      t.assetId,
      t.revision,
    ),
    assetIdx: index("software_asset_revisions_asset_idx").on(t.assetId),
  }),
);

/**
 * A signed, immutable ecosystem manifest. The manifest is retained verbatim so
 * an activated release can always be audited and re-verified without relying
 * on a mutable OCI tag.
 */
export const ecosystemReleases = pgTable(
  "ecosystem_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseKey: varchar("release_key", { length: 255 }).notNull(),
    version: varchar("version", { length: 100 }).notNull(),
    artifactDigest: varchar("artifact_digest", { length: 71 }).notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    signature: text("signature").notNull(),
    signingKeyId: varchar("signing_key_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("staged"),
    importedBy: varchar("imported_by", { length: 255 }).notNull(),
    importedAt: timestamp("imported_at").defaultNow().notNull(),
    activatedBy: varchar("activated_by", { length: 255 }),
    activatedAt: timestamp("activated_at"),
    deactivatedAt: timestamp("deactivated_at"),
    failureReason: text("failure_reason"),
  },
  (t) => ({
    releaseVersionIdx: uniqueIndex("ecosystem_releases_key_version_idx").on(
      t.releaseKey,
      t.version,
    ),
    artifactDigestIdx: uniqueIndex("ecosystem_releases_artifact_digest_idx").on(t.artifactDigest),
    releaseStatusIdx: index("ecosystem_releases_key_status_idx").on(t.releaseKey, t.status),
    statusCheck: check(
      "ecosystem_releases_status_check",
      sql`${t.status} IN ('staged', 'active', 'inactive', 'failed')`,
    ),
  }),
);

/**
 * Validated release entries are staged here before an activation transaction
 * materializes platform-owned assets. This prevents an invalid import from
 * modifying the active software catalog.
 */
export const ecosystemReleaseAssets = pgTable(
  "ecosystem_release_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .references(() => ecosystemReleases.id, { onDelete: "cascade" })
      .notNull(),
    ecosystemKey: varchar("ecosystem_key", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    version: varchar("version", { length: 100 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    licensePolicy: jsonb("license_policy").$type<Record<string, unknown>>().notNull(),
    /** Canonical digest of the signed manifest asset entry. */
    manifestEntryDigest: varchar("manifest_entry_digest", { length: 71 }).notNull().default(""),
    assetId: uuid("asset_id").references(() => softwareAssets.id, { onDelete: "restrict" }),
    assetRevisionId: uuid("asset_revision_id").references(() => softwareAssetRevisions.id, {
      onDelete: "restrict",
    }),
    /** Immutable executable-catalog row created for a bundle usecase entry. */
    usecasePackageId: uuid("usecase_package_id").references(() => usecasePackages.id, {
      onDelete: "restrict",
    }),
    /** Content-addressed revision that binds the package to its signed entry. */
    usecasePackageRevisionId: uuid("usecase_package_revision_id").references(
      () => usecasePackageRevisions.id,
      { onDelete: "restrict" },
    ),
    /** Digest declared in the signed entry and verified against the revision. */
    usecaseSpecDigest: varchar("usecase_spec_digest", { length: 71 }),
    /** Immutable executable-catalog row created for a bundle workflow entry. */
    workflowTemplateId: uuid("workflow_template_id").references(() => workflowTemplates.id, {
      onDelete: "restrict",
    }),
    materializedAt: timestamp("materialized_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    releaseKeyIdx: uniqueIndex("ecosystem_release_assets_release_key_idx").on(
      t.releaseId,
      t.ecosystemKey,
    ),
    releaseAssetIdx: uniqueIndex("ecosystem_release_assets_release_asset_idx").on(
      t.releaseId,
      t.assetId,
    ),
    assetRevisionIdx: index("ecosystem_release_assets_asset_revision_idx").on(
      t.assetId,
      t.assetRevisionId,
    ),
    usecasePackageIdx: uniqueIndex("ecosystem_release_assets_usecase_package_idx").on(
      t.releaseId,
      t.usecasePackageId,
    ),
    usecasePackageRevisionIdx: uniqueIndex(
      "ecosystem_release_assets_usecase_package_revision_idx",
    ).on(t.releaseId, t.usecasePackageRevisionId),
    manifestEntryDigestIdx: uniqueIndex("ecosystem_release_assets_manifest_entry_digest_idx").on(
      t.releaseId,
      t.manifestEntryDigest,
    ),
    workflowTemplateIdx: uniqueIndex("ecosystem_release_assets_workflow_template_idx").on(
      t.releaseId,
      t.workflowTemplateId,
    ),
    materializationCheck: check(
      "ecosystem_release_assets_materialization_check",
      sql`(${t.assetId} IS NULL AND ${t.assetRevisionId} IS NULL AND ${t.materializedAt} IS NULL) OR (${t.assetId} IS NOT NULL AND ${t.assetRevisionId} IS NOT NULL AND ${t.materializedAt} IS NOT NULL)`,
    ),
    kindCheck: check(
      "ecosystem_release_assets_kind_check",
      sql`${t.kind} IN ('data-product', 'spack-package', 'usecase', 'workflow-template', 'sandbox-script')`,
    ),
  }),
);

/**
 * Only references and human-readable summaries are recorded here. License
 * contracts, entitlement files, keys, and licensed bytes are intentionally
 * never stored by the platform.
 */
export const licenseEntitlementClaims = pgTable(
  "license_entitlement_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    licenseSubject: varchar("license_subject", { length: 255 }).notNull(),
    assetId: uuid("asset_id").references(() => softwareAssets.id, { onDelete: "set null" }),
    entitlement: varchar("entitlement", { length: 32 }).notNull(),
    claimantKind: varchar("claimant_kind", { length: 20 }).notNull(),
    claimantId: varchar("claimant_id", { length: 255 }).notNull(),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id, { onDelete: "set null" }),
    evidenceReference: varchar("evidence_reference", { length: 2048 }).notNull(),
    evidenceSummary: text("evidence_summary").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    submittedBy: varchar("submitted_by", { length: 255 }).notNull(),
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
    reviewedBy: varchar("reviewed_by", { length: 255 }),
    reviewedAt: timestamp("reviewed_at"),
    decisionReason: text("decision_reason"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => ({
    claimantStatusIdx: index("license_entitlement_claims_claimant_status_idx").on(
      t.claimantKind,
      t.claimantId,
      t.status,
    ),
    subjectStatusIdx: index("license_entitlement_claims_subject_status_idx").on(
      t.licenseSubject,
      t.status,
    ),
    entitlementCheck: check(
      "license_entitlement_claims_entitlement_check",
      sql`${t.entitlement} IN ('provider-source-install', 'consumer-use')`,
    ),
    claimantCheck: check(
      "license_entitlement_claims_claimant_kind_check",
      sql`${t.claimantKind} IN ('org', 'user')`,
    ),
    statusCheck: check(
      "license_entitlement_claims_status_check",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'revoked', 'expired')`,
    ),
  }),
);

/** Metadata-only mapping for restricted provider-local materials such as VASP POTCAR. */
export const licensedMaterialMappings = pgTable(
  "licensed_material_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerOrgId: uuid("provider_org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    selector: varchar("selector", { length: 255 }).notNull(),
    assetId: uuid("asset_id").references(() => softwareAssets.id, { onDelete: "restrict" }),
    licenseSubject: varchar("license_subject", { length: 255 }),
    materialName: varchar("material_name", { length: 255 }).notNull(),
    materialVersion: varchar("material_version", { length: 100 }).notNull(),
    elementSet: jsonb("element_set").$type<string[]>().notNull(),
    fingerprint: varchar("fingerprint", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    auditMetadata: jsonb("audit_metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => ({
    selectorIdx: uniqueIndex("licensed_material_mappings_provider_agent_selector_idx").on(
      t.providerOrgId,
      t.agentId,
      t.selector,
    ),
    materialLookupIdx: index("licensed_material_mappings_lookup_idx").on(
      t.providerOrgId,
      t.assetId,
      t.materialName,
      t.materialVersion,
      t.status,
    ),
    statusCheck: check(
      "licensed_material_mappings_status_check",
      sql`${t.status} IN ('active', 'revoked')`,
    ),
  }),
);

export const softwareAssetGrants = pgTable(
  "software_asset_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .references(() => softwareAssets.id, { onDelete: "cascade" })
      .notNull(),
    subjectKind: varchar("subject_kind", { length: 32 }).notNull(),
    subjectId: varchar("subject_id", { length: 255 }).notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    inheritedFromAssetId: uuid("inherited_from_asset_id").references(() => softwareAssets.id),
    reason: text("reason"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    assetSubjectIdx: uniqueIndex("software_asset_grants_asset_subject_idx").on(
      t.assetId,
      t.subjectKind,
      t.subjectId,
    ),
    subjectIdx: index("software_asset_grants_subject_idx").on(t.subjectKind, t.subjectId),
    subjectCheck: check(
      "software_asset_grants_subject_check",
      sql`${t.subjectKind} IN ('user', 'org', 'provider-org', 'platform')`,
    ),
  }),
);

export const softwareAccessRequests = pgTable(
  "software_access_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .references(() => softwareAssets.id, { onDelete: "cascade" })
      .notNull(),
    capability: varchar("capability", { length: 32 }).notNull(),
    requesterUserId: varchar("requester_user_id", { length: 255 }).notNull(),
    requesterOrgId: uuid("requester_org_id").references(() => orgs.id),
    subjectKind: varchar("subject_kind", { length: 32 }).notNull(),
    subjectId: varchar("subject_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    reason: text("reason"),
    decisionReason: text("decision_reason"),
    decidedBy: varchar("decided_by", { length: 255 }),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    assetStatusIdx: index("software_access_requests_asset_status_idx").on(t.assetId, t.status),
    requesterIdx: index("software_access_requests_requester_idx").on(t.requesterUserId, t.status),
    subjectIdx: index("software_access_requests_subject_idx").on(
      t.subjectKind,
      t.subjectId,
      t.status,
    ),
    capabilityCheck: check(
      "software_access_requests_capability_check",
      sql`${t.capability} IN ('view', 'use', 'install')`,
    ),
    subjectCheck: check(
      "software_access_requests_subject_check",
      sql`${t.subjectKind} IN ('user', 'org')`,
    ),
    statusCheck: check(
      "software_access_requests_status_check",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'canceled')`,
    ),
  }),
);

export const softwarePolicyOverlays = pgTable(
  "software_policy_overlays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: varchar("scope", { length: 20 }).notNull(),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id),
    clusterId: varchar("cluster_id", { length: 255 }),
    agentId: varchar("agent_id", { length: 255 }).references(() => agents.agentId, {
      onDelete: "cascade",
    }),
    installMode: varchar("install_mode", { length: 64 })
      .notNull()
      .default("explicit-install-grant"),
    allowList: jsonb("allow_list").$type<string[]>().notNull().default([]),
    denyList: jsonb("deny_list").$type<string[]>().notNull().default([]),
    lockEnabled: boolean("lock_enabled").notNull().default(false),
    trustedPublicAutoInstall: boolean("trusted_public_auto_install").notNull().default(false),
    usecaseDefaultAllow: boolean("usecase_default_allow").notNull().default(true),
    usecaseAllowList: jsonb("usecase_allow_list").$type<string[]>().notNull().default([]),
    usecaseDenyList: jsonb("usecase_deny_list").$type<string[]>().notNull().default([]),
    mirrors: jsonb("mirrors")
      .$type<Array<{ name: string; url: string; priority?: number }>>()
      .notNull()
      .default([]),
    preinstallList: jsonb("preinstall_list").$type<string[]>().notNull().default([]),
    version: varchar("version", { length: 64 }).notNull().default("v0"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    providerIdx: index("software_policy_overlays_provider_idx").on(t.providerOrgId),
    agentIdx: index("software_policy_overlays_agent_idx").on(t.agentId),
    scopeProviderAgentIdx: uniqueIndex("software_policy_overlays_scope_provider_agent_idx").on(
      t.scope,
      t.providerOrgId,
      t.clusterId,
      t.agentId,
    ),
    scopeCheck: check(
      "software_policy_overlays_scope_check",
      sql`${t.scope} IN ('provider', 'cluster', 'agent')`,
    ),
    installModeCheck: check(
      "software_policy_overlays_install_mode_check",
      sql`${t.installMode} IN ('preinstalled-only', 'trusted-public-auto-install', 'explicit-install-grant')`,
    ),
  }),
);

export const preinstalledSoftwareMappings = pgTable(
  "preinstalled_software_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    localSpec: varchar("local_spec", { length: 500 }).notNull(),
    assetId: uuid("asset_id")
      .references(() => softwareAssets.id, { onDelete: "cascade" })
      .notNull(),
    confidence: varchar("confidence", { length: 32 }).notNull().default("declared"),
    auditedBy: uuid("audited_by").references(() => users.id),
    auditedAt: timestamp("audited_at"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    agentLocalSpecIdx: uniqueIndex("preinstalled_software_mappings_agent_local_spec_idx").on(
      t.agentId,
      t.localSpec,
    ),
    assetIdx: index("preinstalled_software_mappings_asset_idx").on(t.assetId),
    confidenceCheck: check(
      "preinstalled_software_mappings_confidence_check",
      sql`${t.confidence} IN ('declared', 'metadata-match', 'hash-match', 'platform-locked')`,
    ),
  }),
);

export const softwareMirrorCache = pgTable(
  "software_mirror_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").references(() => softwareAssets.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("missing"),
    sourceUrl: text("source_url"),
    localUrl: text("local_url"),
    sha256: varchar("sha256", { length: 64 }),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    cachedAt: timestamp("cached_at"),
    error: text("error"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    assetKindIdx: index("software_mirror_cache_asset_kind_idx").on(t.assetId, t.kind),
    statusIdx: index("software_mirror_cache_status_idx").on(t.status),
    kindCheck: check(
      "software_mirror_cache_kind_check",
      sql`${t.kind} IN ('recipe', 'metadata', 'source', 'buildcache')`,
    ),
    statusCheck: check(
      "software_mirror_cache_status_check",
      sql`${t.status} IN ('cached', 'missing', 'syncing', 'failed')`,
    ),
  }),
);

export const softwareConcretizeCache = pgTable(
  "software_concretize_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id").references(() => softwareAssets.id, { onDelete: "cascade" }),
    rootSpec: varchar("root_spec", { length: 500 }).notNull(),
    contextKey: varchar("context_key", { length: 255 }).notNull(),
    dag: jsonb("dag").$type<Record<string, unknown>>().notNull(),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
  },
  (t) => ({
    contextIdx: uniqueIndex("software_concretize_cache_context_idx").on(t.rootSpec, t.contextKey),
    assetIdx: index("software_concretize_cache_asset_idx").on(t.assetId),
  }),
);

export const agentSoftware = pgTable(
  "agent_software",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    softwareName: varchar("software_name", { length: 255 }).notNull(),
    softwareVersion: varchar("software_version", { length: 50 }).notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => ({
    agentNameIdx: index("agent_software_agent_name_idx").on(t.agentId, t.softwareName),
  }),
);

export const usageQuotas = pgTable(
  "usage_quotas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** scope: 'user' or 'org' */
    scope: varchar("scope", { length: 20 }).notNull(),
    scopeId: uuid("scope_id").notNull(),
    remainingCreditUnits: integer("remaining_credit_units").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    scopeIdx: index("usage_quotas_scope_idx").on(t.scope, t.scopeId),
    scopeCheck: check("usage_quotas_scope_check", sql`${t.scope} IN ('user', 'org')`),
  }),
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    submittedBy: uuid("submitted_by").references(() => users.id),
    status: varchar("status", { length: 20 }).notNull().default("submitted"),
    stepJobs: jsonb("step_jobs").$type<Record<string, string>>().notNull().default({}),
    input: jsonb("input").$type<{
      yaml: string;
      role: string;
      orgId?: string | null;
      placementConfig?: Record<string, unknown>;
    }>(),
    /** Per-node `{status, values}` result; may be null before execution completes. */
    result: jsonb("result").$type<{
      status: Record<string, string>;
      values: Record<
        string,
        {
          status: string;
          values: Record<string, unknown>;
          failure?: { message: string; jobId?: string; exitCode?: number };
        }
      >;
    }>(),
    /** Run node/edge graph for the run-detail React Flow view. */
    graph: jsonb("graph").$type<{
      nodes: Array<{ id: string; name: string; kind: string }>;
      edges: Array<{ source: string; target: string; when?: string }>;
    }>(),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
    queuedAt: timestamp("queued_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    cancelRequestedAt: timestamp("cancel_requested_at"),
    executorId: varchar("executor_id", { length: 120 }),
    leaseExpiresAt: timestamp("lease_expires_at"),
    attempt: integer("attempt").notNull().default(0),
  },
  (t) => ({
    submittedByIdx: index("workflow_runs_submitted_by_idx").on(t.submittedBy),
    statusCheck: check(
      "workflow_runs_status_check",
      sql`${t.status} IN ('submitted', 'queued', 'awaiting_approval', 'running', 'cancelling', 'completed', 'failed', 'cancelled')`,
    ),
  }),
);

export const workflowDrafts = pgTable(
  "workflow_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    yaml: text("yaml").notNull(),
    placementConfig: jsonb("placement_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    ownerUpdatedIdx: index("workflow_drafts_owner_updated_idx").on(t.ownerId, t.updatedAt),
  }),
);

/**
 * per-Agent client certificate ledger for mTLS.
 *
 * One row per issued cert. Re-issuing for the same `agentId` does NOT delete
 * old rows; the old cert can be marked revoked via `revokedAt`. The mTLS
 * verifier matches incoming client certs by `fingerprintSha256` and rejects
 * revoked rows.
 *
 * Revocation uses the single-Server lookup backed by this table.
 * CRL/OCSP distribution is not implemented.
 */
export const agentCerts = pgTable(
  "agent_certs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    /** Hex-encoded SHA-256 fingerprint of the DER cert, lowercase, no colons. */
    fingerprintSha256: varchar("fingerprint_sha256", { length: 64 }).notNull().unique(),
    /** Subject CN as encoded in the cert; expected to equal agentId. */
    subjectCn: varchar("subject_cn", { length: 255 }).notNull(),
    /** PEM-encoded signed certificate (no key). */
    certPem: text("cert_pem").notNull(),
    issuedAt: timestamp("issued_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    issuedBy: uuid("issued_by").references(() => users.id),
  },
  (t) => ({
    agentIdx: index("agent_certs_agent_idx").on(t.agentId),
    fingerprintIdx: index("agent_certs_fingerprint_idx").on(t.fingerprintSha256),
  }),
);

/**
 * desensitization framework (PRD F22.14 / F22.15).
 *
 * `desensitize_alias_map` stores the (alias_id, salt, original_value) tuple
 * the apply middleware writes whenever it produces a new alias. The F22.15
 * one-shot reverse-alias export endpoint reads from this table and returns a
 * short-TTL signed JWT to the requesting platform_admin.
 *
 * Same `(salt, original_value)` always yields the same `aliasId`, so the
 * primary key acts as the natural dedup key. `lastSeenAt` is bumped on every
 * apply so operators can distinguish stale aliases from active ones.
 */
export const desensitizeAliasMap = pgTable(
  "desensitize_alias_map",
  {
    aliasId: varchar("alias_id", { length: 64 }).primaryKey(),
    salt: varchar("salt", { length: 128 }).notNull(),
    originalValue: text("original_value").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  },
  (t) => ({
    saltIdx: index("desensitize_alias_map_salt_idx").on(t.salt),
  }),
);

/**
 * `desensitize_config` stores the configurable rules (scope = global / provider
 * / cluster + optional scopeId, fieldPath, action). The decision engine merges
 * matching rows for a given (provider, cluster, fieldPath) input — cluster
 * overrides provider overrides global. Hard limits (e.g. a cluster forcing a
 * stricter action) cannot be loosened by lower-priority rows.
 *
 * `scope` is "global" (scopeId NULL), "provider" (scopeId = providerId), or
 * "cluster" (scopeId = clusterId). The decision engine treats these as a
 * priority ladder.
 */
export const desensitizeConfig = pgTable(
  "desensitize_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: varchar("scope", { length: 20 }).notNull(),
    /** null for `global`, providerId for `provider`, clusterId for `cluster`. */
    scopeId: varchar("scope_id", { length: 255 }),
    fieldPath: varchar("field_path", { length: 255 }).notNull(),
    action: varchar("action", { length: 20 }).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    scopeIdx: index("desensitize_config_scope_idx").on(t.scope, t.scopeId),
    scopeCheck: check(
      "desensitize_config_scope_check",
      sql`${t.scope} IN ('global', 'provider', 'cluster')`,
    ),
    actionCheck: check(
      "desensitize_config_action_check",
      sql`${t.action} IN ('passthrough', 'hash', 'alias', 'redact', 'hide')`,
    ),
  }),
);

/**
 * singleton SSO/OIDC configuration (PRD F1.1 / F1.3).
 *
 * Only one logical config row exists; the `singletonId` column is fixed
 * to the literal string `'default'` and marked unique so any second row
 * collides at the DB layer instead of relying on application logic.
 *
 * `clientSecretEncrypted` stores the AES-GCM ciphertext (base64); see
 * `packages/server/src/auth/secret-cipher.ts` for the format. The Server never
 * persists the plaintext.
 *
 * `groupMapping` is a flat `{groupName: roleName}` JSONB record. The
 * OIDC callback resolves the highest-priority role from the user's
 * group claims via `shared.resolveRoleFromGroups()`.
 *
 * `providerType` supports `'oidc'`; `'saml'` and `'ldap'` are reserved
 * placeholders so the column can stay stable when those are added.
 */
export const ssoConfig = pgTable(
  "sso_config",
  {
    singletonId: varchar("singleton_id", { length: 16 }).primaryKey().default("default"),
    enabled: integer("enabled").notNull().default(0),
    providerType: varchar("provider_type", { length: 20 }).notNull().default("oidc"),
    providerDisplayName: varchar("provider_display_name", { length: 80 }).notNull().default(""),
    loginWelcomeZh: varchar("login_welcome_zh", { length: 240 }).notNull().default(""),
    loginWelcomeEn: varchar("login_welcome_en", { length: 240 }).notNull().default(""),
    issuerUrl: text("issuer_url").notNull().default(""),
    clientId: text("client_id").notNull().default(""),
    /** Base64-encoded AES-GCM ciphertext of the OIDC client_secret. Empty when unset. */
    clientSecretEncrypted: text("client_secret_encrypted").notNull().default(""),
    redirectUri: text("redirect_uri").notNull().default(""),
    groupMapping: jsonb("group_mapping").$type<Record<string, string>>().notNull().default({}),
    autoCreateUsers: integer("auto_create_users").notNull().default(1),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: varchar("updated_by", { length: 255 }),
  },
  (t) => ({
    providerTypeCheck: check(
      "sso_config_provider_type_check",
      sql`${t.providerType} IN ('oidc', 'saml', 'ldap')`,
    ),
    singletonCheck: check("sso_config_singleton_check", sql`${t.singletonId} = 'default'`),
  }),
);

/**
 * Platform-wide visual and user-facing identity configuration.
 *
 * The singleton keeps branding independent from the authentication provider;
 * authentication can be disabled without losing the platform's configured
 * name or assets. Empty locale fields are intentional and resolve to the
 * built-in Web defaults, which keeps old rows and old deployments compatible.
 */
export const platformBranding = pgTable(
  "platform_branding",
  {
    singletonId: varchar("singleton_id", { length: 16 }).primaryKey().default("default"),
    locales: jsonb("locales")
      .$type<{
        zh: { name: string; title: string; subtitle: string; welcome: string };
        en: { name: string; title: string; subtitle: string; welcome: string };
      }>()
      .notNull()
      .default({
        zh: { name: "", title: "", subtitle: "", welcome: "" },
        en: { name: "", title: "", subtitle: "", welcome: "" },
      }),
    logoUrl: text("logo_url").notNull().default(""),
    faviconUrl: text("favicon_url").notNull().default(""),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: varchar("updated_by", { length: 255 }),
  },
  (t) => ({
    singletonCheck: check("platform_branding_singleton_check", sql`${t.singletonId} = 'default'`),
  }),
);

/**
 * SSH credential vault (PRD F17).
 *
 * Replaces the not-for-production `SSH_CRED_<AGENT_ID>` env resolver. One row
 * per agent: host/port/username are stored in the clear (not secret, useful for
 * audit); the authentication material (password / private key / passphrase) is
 * encrypted at rest as a JSON blob via `secret-cipher` under the dedicated
 * `kq-ssh-cred-v1` domain label, so an SSO-key compromise cannot read it.
 * One credential set is stored per agent, gated at the gateway by org_admin+ RBAC.
 */
export const sshCredentials = pgTable("ssh_credentials", {
  agentId: varchar("agent_id", { length: 255 }).primaryKey(),
  host: text("host").notNull(),
  port: integer("port").notNull().default(22),
  username: text("username").notNull(),
  /** Base64 AES-GCM ciphertext of `{ password?, privateKey?, passphrase? }`. Empty when unset. */
  secretEncrypted: text("secret_encrypted").notNull().default(""),
  /** Base64 SHA-256 host-key pin (not secret); empty = host key unverified. */
  hostKeySha256: varchar("host_key_sha256", { length: 255 }).notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: varchar("updated_by", { length: 255 }),
});

/**
 * SSH session recording index (PRD F17).
 *
 * One row per finished recording, written when the gateway flushes a session.
 * The transcript bytes live in object storage at `storage_key`; this table is
 * the searchable metadata so an admin can browse recordings (without knowing
 * the session id up front) and a retention job can find old ones. No secrets.
 */
export const sshRecordings = pgTable(
  "ssh_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 }).notNull(),
    sessionId: varchar("session_id", { length: 255 }).notNull(),
    actorUser: varchar("actor_user", { length: 255 }).notNull(),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at").notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    reason: varchar("reason", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    agentSessionIdx: uniqueIndex("ssh_recordings_agent_session_idx").on(t.agentId, t.sessionId),
    endedAtIdx: index("ssh_recordings_ended_at_idx").on(t.endedAt),
  }),
);

/**
 * software governance policies (PRD F19).
 *
 * One row per (scope, agentId) tuple. `scope` is `'global'` (agentId NULL),
 * `'org'` (agentId NULL, scopeId set elsewhere — TODO when org-scoping
 * lands), or `'agent'` (agentId set). The push side reads the most-specific
 * matching row at dispatch time and stamps a monotonic `version` so the
 * agent can dedupe re-broadcasts.
 *
 * `mirrors`, `allowList`, `denyList`, and `preinstallList` are JSONB
 * arrays — schema validation lives in @kuintessence/shared
 * (SpackPolicySchema, MirrorSpecSchema). Storing them as JSONB rather
 * than separate tables keeps the policy push payload to one row read.
 */
export const softwarePolicies = pgTable(
  "software_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** When scope='agent', the target agent. Otherwise NULL. */
    agentId: varchar("agent_id", { length: 255 }).references(() => agents.agentId, {
      onDelete: "cascade",
    }),
    scope: varchar("scope", { length: 20 }).notNull().default("agent"),
    allowList: jsonb("allow_list").$type<string[]>().notNull().default([]),
    denyList: jsonb("deny_list").$type<string[]>().notNull().default([]),
    lockEnabled: boolean("lock_enabled").notNull().default(false),
    mirrors: jsonb("mirrors")
      .$type<Array<{ name: string; url: string; priority?: number }>>()
      .notNull()
      .default([]),
    preinstallList: jsonb("preinstall_list").$type<string[]>().notNull().default([]),
    /** Monotonic version stamp; agent skip-applies same-version pushes. */
    version: varchar("version", { length: 64 }).notNull().default("v0"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    scopeAgentIdx: uniqueIndex("software_policies_scope_agent_idx").on(t.scope, t.agentId),
    scopeCheck: check(
      "software_policies_scope_check",
      sql`${t.scope} IN ('global', 'org', 'agent')`,
    ),
  }),
);

/**
 * per-agent installed Spack spec ledger (PRD F19.5).
 *
 * Heartbeat ingest replaces the rows for a given agent on every refresh
 * (delete-stale + upsert by hash). The `hash` column is the Spack DAG
 * hash and is the natural primary identity per spec; `(agentId, hash)`
 * forms the unique key.
 */
export const agentInstalledSoftware = pgTable(
  "agent_installed_software",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    version: varchar("version", { length: 100 }).notNull(),
    /** `gcc@13.2.0` etc. NULL when Spack omitted compiler info. */
    compiler: varchar("compiler", { length: 100 }),
    /** Spack DAG hash — the natural identity for a spec install. */
    hash: varchar("hash", { length: 64 }).notNull(),
    /** Canonical name@version[%compiler] string. */
    spec: varchar("spec", { length: 500 }).notNull(),
    reportedAt: timestamp("reported_at").defaultNow().notNull(),
  },
  (t) => ({
    agentHashIdx: uniqueIndex("agent_installed_software_agent_hash_idx").on(t.agentId, t.hash),
    agentNameIdx: index("agent_installed_software_agent_name_idx").on(t.agentId, t.name),
  }),
);

export const softwareOperations = pgTable(
  "software_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    requestedBy: varchar("requested_by", { length: 255 }),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    idempotencyItemIndex: integer("idempotency_item_index"),
    idempotencyItemCount: integer("idempotency_item_count"),
    action: varchar("action", { length: 32 }).notNull(),
    spec: varchar("spec", { length: 500 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("queued"),
    stdout: text("stdout"),
    stderr: text("stderr"),
    exitCode: integer("exit_code"),
    error: text("error"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    agentStatusIdx: index("software_operations_agent_status_idx").on(t.agentId, t.status),
    requestedAtIdx: index("software_operations_requested_at_idx").on(t.requestedAt),
    requestIdempotencyIdx: uniqueIndex("software_operations_request_idempotency_idx").on(
      t.requestedBy,
      t.idempotencyKey,
      t.idempotencyItemIndex,
    ),
    actionCheck: check(
      "software_operations_action_check",
      sql`${t.action} IN ('install', 'uninstall', 'load', 'import_preinstalled')`,
    ),
    statusCheck: check(
      "software_operations_status_check",
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'rejected')`,
    ),
  }),
);

/**
 * append-only metrics series, TimescaleDB-friendly.
 *
 * Schema is intentionally a generic (agent_id, metric, value, ts) shape so
 * a future TimescaleDB hypertable conversion is a one-line `SELECT
 * create_hypertable(...)` — no column reshuffle. `payload` carries the
 * sub-fields a metric needs (e.g. for `gpu`: index, model, mem_used_mb,
 * mem_total_mb, util_percent — one row per GPU per heartbeat).
 *
 * Current usage:
 *  - metric='disk_used_percent' → value=0..100, payload={}
 *  - metric='scheduler_queued_jobs' → value=count, payload={}
 *  - metric='gpu' → value=util_percent, payload={index, model, memUsedMb, memTotalMb}
 *
 * TODO: 7-day retention via a daily DELETE WHERE ts < now() - '7 days'
 * cron, or TimescaleDB compression policy when the hypertable lands.
 */
export const agentMetrics = pgTable(
  "agent_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    metric: varchar("metric", { length: 64 }).notNull(),
    value: doublePrecision("value").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    ts: timestamp("ts").defaultNow().notNull(),
  },
  (t) => ({
    agentMetricTsIdx: index("agent_metrics_agent_metric_ts_idx").on(t.agentId, t.metric, t.ts),
    tsIdx: index("agent_metrics_ts_idx").on(t.ts),
  }),
);

export const schedulingPreferences = pgTable(
  "scheduling_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: varchar("scope", { length: 20 }).notNull(),
    // null for global; orgId for org; userId for user
    scopeId: uuid("scope_id"),
    name: varchar("name", { length: 255 }).notNull().default("default"),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    scopeIdx: index("scheduling_preferences_scope_idx").on(t.scope, t.scopeId),
    scopeCheck: check(
      "scheduling_preferences_scope_check",
      sql`${t.scope} IN ('global', 'org', 'user')`,
    ),
  }),
);

/**
 * NetDrive file-metadata ledger (PRD F18).
 *
 * One row per durable, named user-owned blob. The bytes live in MinIO/S3
 * under the synthetic `storage_key` (a UUID under a `netdrive/` prefix);
 * the table holds the user-visible `(owner_id, path)` pair plus integrity
 * fields so a future cross-site replicator and download flow can verify
 * what they fetched matches what was committed.
 *
 * Soft-delete via `deleted_at` keeps the (owner_id, path) "unique-by-live"
 * invariant simple to enforce in the service layer (filter `deletedAt IS
 * NULL` everywhere) and lets a future undelete / metering use case read
 * tombstones without resurrecting them by accident.
 */
export const netdriveFiles = pgTable(
  "netdrive_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    path: text("path").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    /** Hex SHA-256 of the file body — 64 lowercase chars. */
    sha256: varchar("sha256", { length: 64 }).notNull(),
    contentType: varchar("content_type", { length: 255 })
      .notNull()
      .default("application/octet-stream"),
    /** Object-store ETag the client echoed on commit (S3 weak ETag). */
    etag: varchar("etag", { length: 255 }),
    /** Synthetic MinIO/S3 object key under the bucket. */
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    mtime: timestamp("mtime").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** Soft-delete tombstone. NULL for live rows. */
    deletedAt: timestamp("deleted_at"),
  },
  (t) => ({
    ownerPathIdx: index("netdrive_files_owner_path_idx").on(t.ownerId, t.path),
    ownerCreatedIdx: index("netdrive_files_owner_created_idx").on(t.ownerId, t.createdAt),
  }),
);

/**
 * NetDrive replica status ledger.
 *
 * One row per (file, destination site). The actual copy may live in an Agent
 * cache, regional MinIO, or another future storage backend; this table records
 * only the scheduler-visible presence and the latest replication state.
 */
export const netdriveReplicas = pgTable(
  "netdrive_replicas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .references(() => netdriveFiles.id, { onDelete: "cascade" })
      .notNull(),
    siteId: varchar("site_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("available"),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    errorMessage: text("error_message"),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    fileSiteUnique: uniqueIndex("netdrive_replicas_file_site_unique").on(t.fileId, t.siteId),
    siteStatusIdx: index("netdrive_replicas_site_status_idx").on(t.siteId, t.status),
    fileIdx: index("netdrive_replicas_file_idx").on(t.fileId),
    statusCheck: check(
      "netdrive_replicas_status_check",
      sql`${t.status} IN ('pending', 'syncing', 'available', 'failed')`,
    ),
  }),
);

export const dataAssets = pgTable(
  "data_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    ownerOrgId: uuid("owner_org_id").references(() => orgs.id, { onDelete: "set null" }),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id, { onDelete: "set null" }),
    ownerKind: varchar("owner_kind", { length: 32 }).notNull().default("user"),
    kind: varchar("kind", { length: 32 }).notNull().default("scientific-dataset"),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    lifecycle: varchar("lifecycle", { length: 32 }).notNull().default("draft"),
    visibility: varchar("visibility", { length: 32 }).notNull().default("private"),
    accessMode: varchar("access_mode", { length: 32 }).notNull().default("request"),
    sensitivity: varchar("sensitivity", { length: 32 }).notNull().default("internal"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index("data_assets_owner_idx").on(t.ownerUserId, t.ownerOrgId),
    providerIdx: index("data_assets_provider_idx").on(t.providerOrgId),
    lifecycleIdx: index("data_assets_lifecycle_idx").on(t.lifecycle),
    kindCheck: check(
      "data_assets_kind_check",
      sql`${t.kind} IN ('training-dataset', 'scientific-dataset', 'reference-data', 'model-artifact', 'pseudopotential', 'licensed-material')`,
    ),
    lifecycleCheck: check(
      "data_assets_lifecycle_check",
      sql`${t.lifecycle} IN ('draft', 'reviewing', 'published', 'deprecated', 'revoked')`,
    ),
    visibilityCheck: check(
      "data_assets_visibility_check",
      sql`${t.visibility} IN ('public', 'organization', 'private')`,
    ),
    accessModeCheck: check(
      "data_assets_access_mode_check",
      sql`${t.accessMode} IN ('open', 'request', 'entitlement')`,
    ),
    sensitivityCheck: check(
      "data_assets_sensitivity_check",
      sql`${t.sensitivity} IN ('open', 'internal', 'restricted', 'regulated')`,
    ),
    ownerCheck: check(
      "data_assets_owner_check",
      sql`(${t.ownerKind} = 'user' AND ${t.ownerUserId} IS NOT NULL AND ${t.ownerOrgId} IS NULL AND ${t.providerOrgId} IS NULL) OR (${t.ownerKind} = 'org' AND ${t.ownerUserId} IS NULL AND ${t.ownerOrgId} IS NOT NULL AND ${t.providerOrgId} IS NULL) OR (${t.ownerKind} = 'provider' AND ${t.ownerUserId} IS NULL AND ${t.ownerOrgId} IS NULL AND ${t.providerOrgId} IS NOT NULL) OR (${t.ownerKind} = 'platform' AND ${t.ownerUserId} IS NULL AND ${t.ownerOrgId} IS NULL AND ${t.providerOrgId} IS NULL)`,
    ),
  }),
);

export const dataAssetVersions = pgTable(
  "data_asset_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataAssetId: uuid("data_asset_id")
      .references(() => dataAssets.id, { onDelete: "cascade" })
      .notNull(),
    version: varchar("version", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    contentHash: varchar("content_hash", { length: 128 }),
    manifestDigest: varchar("manifest_digest", { length: 128 }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    format: varchar("format", { length: 128 }),
    schemaUri: text("schema_uri"),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    immutableAt: timestamp("immutable_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    assetVersionIdx: uniqueIndex("data_asset_versions_asset_version_idx").on(
      t.dataAssetId,
      t.version,
    ),
    statusIdx: index("data_asset_versions_status_idx").on(t.dataAssetId, t.status),
    statusCheck: check(
      "data_asset_versions_status_check",
      sql`${t.status} IN ('draft', 'validating', 'ready', 'failed', 'deprecated', 'revoked')`,
    ),
    immutableStatusCheck: check(
      "data_asset_versions_immutable_status_check",
      sql`${t.status} IN ('draft', 'validating', 'failed') OR ${t.immutableAt} IS NOT NULL`,
    ),
    sizeCheck: check(
      "data_asset_versions_size_bytes_check",
      sql`${t.sizeBytes} IS NULL OR ${t.sizeBytes} >= 0`,
    ),
  }),
);

export const dataUploadSessions = pgTable(
  "data_upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataAssetId: uuid("data_asset_id")
      .references(() => dataAssets.id, { onDelete: "cascade" })
      .notNull(),
    targetVersion: varchar("target_version", { length: 128 }).notNull(),
    ownerUserId: uuid("owner_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    locationKind: varchar("location_kind", { length: 32 }).notNull(),
    objectPath: text("object_path").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    expectedSizeBytes: bigint("expected_size_bytes", { mode: "number" }).notNull(),
    expectedContentType: varchar("expected_content_type", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    expiresAt: timestamp("expires_at").notNull(),
    committedVersionId: uuid("committed_version_id").references(() => dataAssetVersions.id, {
      onDelete: "set null",
    }),
    committedSha256: varchar("committed_sha256", { length: 128 }),
    committedEtag: varchar("committed_etag", { length: 255 }),
    commitMetadata: jsonb("commit_metadata").$type<Record<string, unknown>>().notNull().default({}),
    committedAt: timestamp("committed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    assetVersionStatusIdx: index("data_upload_sessions_asset_version_status_idx").on(
      t.dataAssetId,
      t.targetVersion,
      t.status,
    ),
    ownerStatusIdx: index("data_upload_sessions_owner_status_idx").on(t.ownerUserId, t.status),
    expectedSizeCheck: check(
      "data_upload_sessions_expected_size_check",
      sql`${t.expectedSizeBytes} > 0`,
    ),
    locationKindCheck: check(
      "data_upload_sessions_location_kind_check",
      sql`${t.locationKind} IN ('platform-object', 'user-private-object')`,
    ),
    statusCheck: check(
      "data_upload_sessions_status_check",
      sql`${t.status} IN ('pending', 'completed', 'expired', 'failed')`,
    ),
  }),
);

export const dataLocations = pgTable(
  "data_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataAssetVersionId: uuid("data_asset_version_id")
      .references(() => dataAssetVersions.id, { onDelete: "cascade" })
      .notNull(),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id, { onDelete: "set null" }),
    siteId: varchar("site_id", { length: 255 }),
    agentId: varchar("agent_id", { length: 255 }).references(() => agents.agentId, {
      onDelete: "set null",
    }),
    managedRootId: uuid("managed_root_id").references(() => clusterFileRoots.id, {
      onDelete: "set null",
    }),
    relativePath: text("relative_path"),
    kind: varchar("kind", { length: 32 }).notNull(),
    uri: text("uri"),
    status: varchar("status", { length: 32 }).notNull().default("available"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    versionUriIdx: uniqueIndex("data_locations_version_uri_idx").on(t.dataAssetVersionId, t.uri),
    versionRootPathIdx: uniqueIndex("data_locations_version_root_path_idx").on(
      t.dataAssetVersionId,
      t.managedRootId,
      t.relativePath,
    ),
    siteStatusIdx: index("data_locations_site_status_idx").on(t.siteId, t.status),
    agentIdx: index("data_locations_agent_idx").on(t.agentId),
    kindCheck: check(
      "data_locations_kind_check",
      sql`${t.kind} IN ('platform-object', 'user-private-object', 'cp-local')`,
    ),
    statusCheck: check(
      "data_locations_status_check",
      sql`${t.status} IN ('available', 'unavailable', 'deleted')`,
    ),
    sourceCheck: check(
      "data_locations_source_check",
      sql`(${t.kind} = 'cp-local' AND ${t.managedRootId} IS NOT NULL AND ${t.relativePath} IS NOT NULL AND ${t.uri} IS NULL) OR (${t.kind} IN ('platform-object', 'user-private-object') AND ${t.uri} IS NOT NULL AND ${t.managedRootId} IS NULL AND ${t.relativePath} IS NULL)`,
    ),
  }),
);

export const dataAssetFiles = pgTable(
  "data_asset_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataAssetVersionId: uuid("data_asset_version_id")
      .references(() => dataAssetVersions.id, { onDelete: "cascade" })
      .notNull(),
    netdriveFileId: uuid("netdrive_file_id").references(() => netdriveFiles.id, {
      onDelete: "set null",
    }),
    locationId: uuid("location_id").references(() => dataLocations.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    digest: varchar("digest", { length: 128 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mediaType: varchar("media_type", { length: 255 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    versionPathIdx: uniqueIndex("data_asset_files_version_path_idx").on(
      t.dataAssetVersionId,
      t.path,
    ),
    locationIdx: index("data_asset_files_location_idx").on(t.locationId),
    netdriveIdx: index("data_asset_files_netdrive_idx").on(t.netdriveFileId),
    sizeCheck: check("data_asset_files_size_bytes_check", sql`${t.sizeBytes} >= 0`),
  }),
);

export const dataAssetManifestEntries = pgTable(
  "data_asset_manifest_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataAssetVersionId: uuid("data_asset_version_id")
      .references(() => dataAssetVersions.id, { onDelete: "cascade" })
      .notNull(),
    dataAssetFileId: uuid("data_asset_file_id").references(() => dataAssetFiles.id, {
      onDelete: "set null",
    }),
    entryPath: text("entry_path").notNull(),
    digest: varchar("digest", { length: 128 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mediaType: varchar("media_type", { length: 255 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    versionEntryIdx: uniqueIndex("data_asset_manifest_entries_version_entry_idx").on(
      t.dataAssetVersionId,
      t.entryPath,
    ),
    fileIdx: index("data_asset_manifest_entries_file_idx").on(t.dataAssetFileId),
    sizeCheck: check("data_asset_manifest_entries_size_bytes_check", sql`${t.sizeBytes} >= 0`),
  }),
);

export const dataAssetImports = pgTable(
  "data_asset_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetAssetId: uuid("target_asset_id")
      .references(() => dataAssets.id, { onDelete: "cascade" })
      .notNull(),
    targetVersion: varchar("target_version", { length: 128 }).notNull(),
    sourceKind: varchar("source_kind", { length: 32 }).notNull(),
    sourceNetdriveFileId: uuid("source_netdrive_file_id").references(() => netdriveFiles.id, {
      onDelete: "set null",
    }),
    sourceDataAssetVersionId: uuid("source_data_asset_version_id").references(
      () => dataAssetVersions.id,
      { onDelete: "set null" },
    ),
    sourceManagedRootId: uuid("source_managed_root_id").references(() => clusterFileRoots.id, {
      onDelete: "set null",
    }),
    sourceRelativePath: text("source_relative_path"),
    requesterUserId: uuid("requester_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    requesterKeyIdx: uniqueIndex("data_asset_imports_requester_key_idx").on(
      t.requesterUserId,
      t.idempotencyKey,
    ),
    targetIdx: index("data_asset_imports_target_idx").on(t.targetAssetId, t.targetVersion),
    statusIdx: index("data_asset_imports_status_idx").on(t.status, t.createdAt),
    sourceKindCheck: check(
      "data_asset_imports_source_kind_check",
      sql`${t.sourceKind} IN ('netdrive', 'data-market', 'cp-local')`,
    ),
    sourceCheck: check(
      "data_asset_imports_source_check",
      sql`(${t.sourceKind} = 'netdrive' AND ${t.sourceNetdriveFileId} IS NOT NULL AND ${t.sourceDataAssetVersionId} IS NULL AND ${t.sourceManagedRootId} IS NULL AND ${t.sourceRelativePath} IS NULL) OR (${t.sourceKind} = 'data-market' AND ${t.sourceNetdriveFileId} IS NULL AND ${t.sourceDataAssetVersionId} IS NOT NULL AND ${t.sourceManagedRootId} IS NULL AND ${t.sourceRelativePath} IS NULL) OR (${t.sourceKind} = 'cp-local' AND ${t.sourceNetdriveFileId} IS NULL AND ${t.sourceDataAssetVersionId} IS NULL AND ${t.sourceManagedRootId} IS NOT NULL AND ${t.sourceRelativePath} IS NOT NULL)`,
    ),
    statusCheck: check(
      "data_asset_imports_status_check",
      sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'canceled')`,
    ),
  }),
);

export const dataScanRequests = pgTable(
  "data_scan_requests",
  {
    requestId: uuid("request_id").primaryKey(),
    importId: uuid("import_id")
      .references(() => dataAssetImports.id, { onDelete: "cascade" })
      .notNull()
      .unique(),
    assetId: uuid("asset_id")
      .references(() => dataAssets.id, { onDelete: "cascade" })
      .notNull(),
    versionId: uuid("version_id")
      .references(() => dataAssetVersions.id, { onDelete: "cascade" })
      .notNull(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    providerOrgId: uuid("provider_org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    managedRootId: uuid("managed_root_id")
      .references(() => clusterFileRoots.id, { onDelete: "restrict" })
      .notNull(),
    relativePath: text("relative_path").notNull(),
    deadlineAt: timestamp("deadline_at").notNull(),
    attempt: integer("attempt").notNull().default(0),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    attestationPayload: text("attestation_payload"),
    attestationSignature: text("attestation_signature"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    agentPendingIdx: index("data_scan_requests_agent_pending_idx").on(
      t.agentId,
      t.status,
      t.deadlineAt,
    ),
    statusCheck: check(
      "data_scan_requests_status_check",
      sql`${t.status} IN ('pending', 'completed', 'failed')`,
    ),
    attemptCheck: check("data_scan_requests_attempt_check", sql`${t.attempt} >= 0`),
  }),
);

export const dataReplicas = pgTable(
  "data_replicas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataAssetVersionId: uuid("data_asset_version_id")
      .references(() => dataAssetVersions.id, { onDelete: "cascade" })
      .notNull(),
    sourceLocationId: uuid("source_location_id").references(() => dataLocations.id, {
      onDelete: "set null",
    }),
    targetLocationId: uuid("target_location_id").references(() => dataLocations.id, {
      onDelete: "set null",
    }),
    targetSiteId: varchar("target_site_id", { length: 255 }).notNull(),
    manifestDigest: varchar("manifest_digest", { length: 128 }),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    bytesCopied: bigint("bytes_copied", { mode: "number" }).notNull().default(0),
    errorMessage: text("error_message"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    verifiedAt: timestamp("verified_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    versionTargetIdx: uniqueIndex("data_replicas_version_target_site_idx").on(
      t.dataAssetVersionId,
      t.targetSiteId,
    ),
    statusIdx: index("data_replicas_status_idx").on(t.status, t.targetSiteId),
    statusCheck: check(
      "data_replicas_status_check",
      sql`${t.status} IN ('pending', 'syncing', 'available', 'failed', 'stale', 'deleted', 'mismatch', 'expired')`,
    ),
    availableVerificationCheck: check(
      "data_replicas_available_verification_check",
      sql`${t.status} <> 'available' OR (${t.manifestDigest} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL)`,
    ),
    bytesCopiedCheck: check("data_replicas_bytes_copied_check", sql`${t.bytesCopied} >= 0`),
  }),
);

export const dataAccessPolicies = pgTable(
  "data_access_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataAssetId: uuid("data_asset_id")
      .references(() => dataAssets.id, { onDelete: "cascade" })
      .notNull(),
    dataAssetVersionId: uuid("data_asset_version_id").references(() => dataAssetVersions.id, {
      onDelete: "cascade",
    }),
    subjectKind: varchar("subject_kind", { length: 32 }).notNull(),
    subjectId: varchar("subject_id", { length: 255 }).notNull(),
    effect: varchar("effect", { length: 16 }).notNull().default("allow"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    accessMode: varchar("access_mode", { length: 32 }).notNull().default("request"),
    sensitivity: varchar("sensitivity", { length: 32 }).notNull().default("internal"),
    downloadPolicy: varchar("download_policy", { length: 16 }).notNull().default("deny"),
    derivePolicy: varchar("derive_policy", { length: 16 }).notNull().default("deny"),
    redistributionPolicy: varchar("redistribution_policy", { length: 16 })
      .notNull()
      .default("deny"),
    crossCenterReplicationPolicy: varchar("cross_center_replication_policy", { length: 16 })
      .notNull()
      .default("deny"),
    retentionPolicy: varchar("retention_policy", { length: 32 })
      .notNull()
      .default("source-controlled"),
    expiresAt: timestamp("expires_at"),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    reason: text("reason"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    assetSubjectIdx: uniqueIndex("data_access_policies_asset_subject_idx").on(
      t.dataAssetId,
      t.dataAssetVersionId,
      t.subjectKind,
      t.subjectId,
    ),
    subjectIdx: index("data_access_policies_subject_idx").on(t.subjectKind, t.subjectId, t.status),
    subjectCheck: check(
      "data_access_policies_subject_check",
      sql`${t.subjectKind} IN ('user', 'org', 'provider-org', 'platform')`,
    ),
    effectCheck: check("data_access_policies_effect_check", sql`${t.effect} IN ('allow', 'deny')`),
    accessModeCheck: check(
      "data_access_policies_access_mode_check",
      sql`${t.accessMode} IN ('open', 'request', 'entitlement')`,
    ),
    sensitivityCheck: check(
      "data_access_policies_sensitivity_check",
      sql`${t.sensitivity} IN ('open', 'internal', 'restricted', 'regulated')`,
    ),
    downloadPolicyCheck: check(
      "data_access_policies_download_policy_check",
      sql`${t.downloadPolicy} IN ('allow', 'deny')`,
    ),
    derivePolicyCheck: check(
      "data_access_policies_derive_policy_check",
      sql`${t.derivePolicy} IN ('allow', 'deny')`,
    ),
    redistributionPolicyCheck: check(
      "data_access_policies_redistribution_policy_check",
      sql`${t.redistributionPolicy} IN ('allow', 'deny')`,
    ),
    crossCenterReplicationPolicyCheck: check(
      "data_access_policies_cross_center_replication_policy_check",
      sql`${t.crossCenterReplicationPolicy} IN ('allow', 'deny')`,
    ),
    retentionPolicyCheck: check(
      "data_access_policies_retention_policy_check",
      sql`${t.retentionPolicy} IN ('source-controlled', 'retain', 'delete-on-expiry')`,
    ),
    statusCheck: check(
      "data_access_policies_status_check",
      sql`${t.status} IN ('active', 'disabled', 'revoked')`,
    ),
  }),
);

export const dataGrants = pgTable(
  "data_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataAssetId: uuid("data_asset_id")
      .references(() => dataAssets.id, { onDelete: "cascade" })
      .notNull(),
    dataAssetVersionId: uuid("data_asset_version_id").references(() => dataAssetVersions.id, {
      onDelete: "cascade",
    }),
    subjectKind: varchar("subject_kind", { length: 32 }).notNull(),
    subjectId: varchar("subject_id", { length: 255 }).notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    reason: text("reason"),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    startsAt: timestamp("starts_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    assetSubjectIdx: uniqueIndex("data_grants_asset_subject_idx").on(
      t.dataAssetId,
      t.dataAssetVersionId,
      t.subjectKind,
      t.subjectId,
    ),
    subjectIdx: index("data_grants_subject_idx").on(t.subjectKind, t.subjectId, t.status),
    statusIdx: index("data_grants_status_expiry_idx").on(t.status, t.expiresAt),
    subjectCheck: check(
      "data_grants_subject_check",
      sql`${t.subjectKind} IN ('user', 'org', 'provider-org', 'platform')`,
    ),
    statusCheck: check(
      "data_grants_status_check",
      sql`${t.status} IN ('active', 'revoked', 'expired')`,
    ),
    lifetimeCheck: check(
      "data_grants_lifetime_check",
      sql`${t.expiresAt} IS NULL OR ${t.expiresAt} > ${t.startsAt}`,
    ),
  }),
);

export const dataAccessRequests = pgTable(
  "data_access_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataAssetId: uuid("data_asset_id")
      .references(() => dataAssets.id, { onDelete: "cascade" })
      .notNull(),
    dataAssetVersionId: uuid("data_asset_version_id").references(() => dataAssetVersions.id, {
      onDelete: "cascade",
    }),
    capability: varchar("capability", { length: 32 }).notNull(),
    requesterUserId: uuid("requester_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    requesterOrgId: uuid("requester_org_id").references(() => orgs.id, { onDelete: "set null" }),
    subjectKind: varchar("subject_kind", { length: 32 }).notNull(),
    subjectId: varchar("subject_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    reason: text("reason"),
    decisionReason: text("decision_reason"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    assetStatusIdx: index("data_access_requests_asset_status_idx").on(t.dataAssetId, t.status),
    requesterIdx: index("data_access_requests_requester_idx").on(t.requesterUserId, t.status),
    subjectIdx: index("data_access_requests_subject_idx").on(t.subjectKind, t.subjectId, t.status),
    capabilityCheck: check(
      "data_access_requests_capability_check",
      sql`${t.capability} IN ('view', 'use', 'download', 'derive', 'manage')`,
    ),
    subjectCheck: check(
      "data_access_requests_subject_check",
      sql`${t.subjectKind} IN ('user', 'org')`,
    ),
    statusCheck: check(
      "data_access_requests_status_check",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'canceled', 'expired')`,
    ),
  }),
);

export const jobDataBindings = pgTable(
  "job_data_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .references(() => jobs.id, { onDelete: "cascade" })
      .notNull(),
    inputDescriptor: varchar("input_descriptor", { length: 255 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    assetId: uuid("asset_id"),
    versionId: uuid("version_id"),
    manifestDigest: varchar("manifest_digest", { length: 128 }),
    selectedEntries: jsonb("selected_entries").$type<string[]>().notNull().default([]),
    allowedLocationIds: jsonb("allowed_location_ids").$type<string[]>().notNull().default([]),
    stagePath: varchar("stage_path", { length: 2048 }),
    deliveryPolicy: jsonb("delivery_policy")
      .$type<{
        download: "allow" | "deny";
        derive: "allow" | "deny";
        redistribution: "allow" | "deny";
        crossCenterReplication: "allow" | "deny";
        retention: "source-controlled" | "retain" | "delete-on-expiry";
      }>()
      .notNull()
      .default({
        download: "deny",
        derive: "deny",
        redistribution: "deny",
        crossCenterReplication: "deny",
        retention: "source-controlled",
      }),
    assetKind: varchar("asset_kind", { length: 32 }),
    sensitivity: varchar("sensitivity", { length: 32 }),
    egressPolicy: varchar("egress_policy", { length: 16 }).notNull().default("deny"),
    authorizationSubjectIds: jsonb("authorization_subject_ids")
      .$type<AuthorizationSubjectId[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    jobDescriptorVersionIdx: uniqueIndex("job_data_bindings_job_descriptor_version_idx").on(
      t.jobId,
      t.inputDescriptor,
      t.versionId,
    ),
    jobIdx: index("job_data_bindings_job_idx").on(t.jobId),
    sourceCheck: check(
      "job_data_bindings_source_check",
      sql`${t.source} IN ('netdrive', 'data-market')`,
    ),
    assetKindCheck: check(
      "job_data_bindings_asset_kind_check",
      sql`${t.assetKind} IS NULL OR ${t.assetKind} IN ('training-dataset', 'scientific-dataset', 'reference-data', 'model-artifact', 'pseudopotential', 'licensed-material')`,
    ),
    sensitivityCheck: check(
      "job_data_bindings_sensitivity_check",
      sql`${t.sensitivity} IS NULL OR ${t.sensitivity} IN ('open', 'internal', 'restricted', 'regulated')`,
    ),
    egressPolicyCheck: check(
      "job_data_bindings_egress_policy_check",
      sql`${t.egressPolicy} IN ('allow', 'deny')`,
    ),
    dataMarketCheck: check(
      "job_data_bindings_data_market_check",
      sql`(${t.source} = 'netdrive' AND ${t.assetId} IS NULL AND ${t.versionId} IS NULL AND ${t.manifestDigest} IS NULL) OR (${t.source} = 'data-market' AND ${t.assetId} IS NOT NULL AND ${t.versionId} IS NOT NULL AND ${t.manifestDigest} IS NOT NULL)`,
    ),
  }),
);

/**
 * NetDrive transfer log (migration 0014).
 *
 * Replaces the cp-bindings approximation that summed `netdrive_files.size`
 * by `created_at` (which conflated upload bytes with all-direction transfer
 * bytes). NetDriveService now appends one row per finalized op so byte
 * accounting on the CP Console reflects real upload + download (and, when
 * wired, mirror) traffic. Insertions are best-effort — the user-facing
 * NetDrive request is never failed because the audit insert tripped.
 *
 * `direction`:
 *   - 'upload'   — client→object-store finalize via commitFile()
 *   - 'download' — Server→client presigned-GET via mintDownloadUrl()
 *   - 'mirror'   — cross-site replication (TODO: no call site yet)
 *
 * `siteId` is only meaningful for `direction='mirror'` (destination site).
 *
 * FKs are `ON DELETE SET NULL` so soft-deleting a file or removing a user
 * preserves the historical row for audit, even if the joined entity is
 * gone. The downside is the dashboard can show an orphaned NULL — that is
 * acceptable; the alternative (cascade) would lose real bytes-transferred
 * data.
 */
export const netdriveTransferLog = pgTable(
  "netdrive_transfer_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id").references(() => netdriveFiles.id, { onDelete: "set null" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "set null" }),
    direction: varchar("direction", { length: 10 }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    siteId: varchar("site_id", { length: 255 }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    netdriveFileIds: jsonb("netdrive_file_ids").$type<string[]>().notNull().default([]),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  },
  (t) => ({
    orgTimeIdx: index("netdrive_transfer_log_org_time_idx").on(t.orgId, t.occurredAt),
    actorTimeIdx: index("netdrive_transfer_log_actor_time_idx").on(t.actorId, t.occurredAt),
    jobTimeIdx: index("netdrive_transfer_log_job_time_idx").on(t.jobId, t.occurredAt),
    workflowRunTimeIdx: index("netdrive_transfer_log_workflow_run_time_idx").on(
      t.workflowRunId,
      t.occurredAt,
    ),
    directionCheck: check(
      "netdrive_transfer_log_direction_check",
      sql`${t.direction} IN ('upload', 'download', 'mirror')`,
    ),
  }),
);

export const fileTransferAuditConfig = pgTable(
  "file_transfer_audit_config",
  {
    singletonId: varchar("singleton_id", { length: 16 }).primaryKey().default("default"),
    userPlatformRetentionDays: integer("user_platform_retention_days").notNull().default(365),
    platformClusterRetentionDays: integer("platform_cluster_retention_days").notNull().default(180),
    downloadEvidenceMode: varchar("download_evidence_mode", { length: 32 })
      .notNull()
      .default("controlled_gateway"),
    policyVersion: integer("policy_version").notNull().default(1),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: varchar("updated_by", { length: 255 }),
  },
  (t) => ({
    singletonCheck: check(
      "file_transfer_audit_config_singleton_check",
      sql`${t.singletonId} = 'default'`,
    ),
    userRetentionCheck: check(
      "file_transfer_audit_config_user_retention_check",
      sql`${t.userPlatformRetentionDays} BETWEEN 1 AND 3650`,
    ),
    clusterRetentionCheck: check(
      "file_transfer_audit_config_cluster_retention_check",
      sql`${t.platformClusterRetentionDays} BETWEEN 1 AND 3650`,
    ),
    downloadModeCheck: check(
      "file_transfer_audit_config_download_mode_check",
      sql`${t.downloadEvidenceMode} IN ('controlled_gateway', 'direct_authorization_only')`,
    ),
    policyVersionCheck: check(
      "file_transfer_audit_config_policy_version_check",
      sql`${t.policyVersion} >= 1`,
    ),
  }),
);

export const storageQuotaPolicies = pgTable(
  "storage_quota_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: varchar("scope", { length: 32 }).notNull(),
    scopeId: varchar("scope_id", { length: 255 }).notNull(),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id, { onDelete: "cascade" }),
    defaultQuotaBytes: bigint("default_quota_bytes", { mode: "number" }).notNull(),
    maxQuotaBytes: bigint("max_quota_bytes", { mode: "number" }),
    requestMode: varchar("request_mode", { length: 16 }).notNull().default("manual"),
    autoApproveLimitBytes: bigint("auto_approve_limit_bytes", { mode: "number" }),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    scopeUnique: uniqueIndex("storage_quota_policies_scope_unique").on(t.scope, t.scopeId),
    providerIdx: index("storage_quota_policies_provider_idx").on(t.providerOrgId),
    scopeCheck: check(
      "storage_quota_policies_scope_check",
      sql`${t.scope} IN ('cloud', 'cluster_root')`,
    ),
    requestModeCheck: check(
      "storage_quota_policies_request_mode_check",
      sql`${t.requestMode} IN ('auto', 'manual', 'disabled')`,
    ),
  }),
);

export const storageQuotaRequests = pgTable(
  "storage_quota_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    scope: varchar("scope", { length: 32 }).notNull(),
    scopeId: varchar("scope_id", { length: 255 }).notNull(),
    requestedQuotaBytes: bigint("requested_quota_bytes", { mode: "number" }).notNull(),
    requestedExpiresAt: timestamp("requested_expires_at"),
    reason: text("reason").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userTimeIdx: index("storage_quota_requests_user_time_idx").on(t.userId, t.createdAt),
    scopeStatusIdx: index("storage_quota_requests_scope_status_idx").on(
      t.scope,
      t.scopeId,
      t.status,
    ),
    scopeCheck: check(
      "storage_quota_requests_scope_check",
      sql`${t.scope} IN ('cloud', 'cluster_root')`,
    ),
    statusCheck: check(
      "storage_quota_requests_status_check",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')`,
    ),
  }),
);

export const storageQuotaGrants = pgTable(
  "storage_quota_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    scope: varchar("scope", { length: 32 }).notNull(),
    scopeId: varchar("scope_id", { length: 255 }).notNull(),
    quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull(),
    source: varchar("source", { length: 16 }).notNull(),
    requestId: uuid("request_id").references(() => storageQuotaRequests.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    startsAt: timestamp("starts_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    userScopeIdx: index("storage_quota_grants_user_scope_idx").on(t.userId, t.scope, t.scopeId),
    expiryIdx: index("storage_quota_grants_expiry_idx").on(t.expiresAt),
    scopeCheck: check(
      "storage_quota_grants_scope_check",
      sql`${t.scope} IN ('cloud', 'cluster_root')`,
    ),
    sourceCheck: check(
      "storage_quota_grants_source_check",
      sql`${t.source} IN ('manual', 'temporary', 'auto', 'request')`,
    ),
  }),
);

export const fileTransfers = pgTable(
  "file_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    direction: varchar("direction", { length: 32 }).notNull(),
    source: text("source").notNull(),
    target: text("target").notNull(),
    sourceFileId: uuid("source_file_id").references(() => netdriveFiles.id, {
      onDelete: "set null",
    }),
    agentId: varchar("agent_id", { length: 255 }),
    siteId: varchar("site_id", { length: 255 }),
    totalBytes: bigint("total_bytes", { mode: "number" }),
    copiedBytes: bigint("copied_bytes", { mode: "number" }).notNull().default(0),
    state: varchar("state", { length: 32 }).notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    error: text("error"),
    clusterRootId: uuid("cluster_root_id").references(() => clusterFileRoots.id, {
      onDelete: "set null",
    }),
    clusterRootRevision: timestamp("cluster_root_revision"),
    rootPolicyChangedAt: timestamp("root_policy_changed_at"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    netdriveFileIds: jsonb("netdrive_file_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userCreatedIdx: index("file_transfers_user_created_idx").on(t.userId, t.createdAt),
    stateIdx: index("file_transfers_state_idx").on(t.state),
    clusterRootStateIdx: index("file_transfers_cluster_root_state_idx").on(
      t.clusterRootId,
      t.state,
    ),
    jobIdx: index("file_transfers_job_idx").on(t.jobId),
    workflowRunIdx: index("file_transfers_workflow_run_idx").on(t.workflowRunId),
    directionCheck: check(
      "file_transfers_direction_check",
      sql`${t.direction} IN ('cloud_to_cluster', 'cluster_to_cloud')`,
    ),
    stateCheck: check(
      "file_transfers_state_check",
      sql`${t.state} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
  }),
);

export const sandboxRuntimeProfiles = pgTable(
  "sandbox_runtime_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    language: varchar("language", { length: 20 }).notNull(),
    languageVersion: varchar("language_version", { length: 100 }).notNull(),
    ociDigest: varchar("oci_digest", { length: 71 }),
    sifDigest: varchar("sif_digest", { length: 71 }),
    signature: text("signature").notNull(),
    dependencies: jsonb("dependencies")
      .$type<Array<{ name: string; version: string; license?: string }>>()
      .notNull()
      .default([]),
    documentation: jsonb("documentation").$type<Record<string, string>>().notNull().default({}),
    adapters: jsonb("adapters").$type<string[]>().notNull().default([]),
    securityRequirements: jsonb("security_requirements").$type<Record<string, unknown>>().notNull(),
    lifecycle: varchar("lifecycle", { length: 20 }).notNull().default("draft"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    languageLifecycleIdx: index("sandbox_runtime_profiles_language_lifecycle_idx").on(
      t.language,
      t.lifecycle,
    ),
    ociDigestIdx: uniqueIndex("sandbox_runtime_profiles_oci_digest_idx").on(t.ociDigest),
    sifDigestIdx: uniqueIndex("sandbox_runtime_profiles_sif_digest_idx").on(t.sifDigest),
    languageCheck: check(
      "sandbox_runtime_profiles_language_check",
      sql`${t.language} IN ('python', 'nodejs', 'bash')`,
    ),
    lifecycleCheck: check(
      "sandbox_runtime_profiles_lifecycle_check",
      sql`${t.lifecycle} IN ('draft', 'active', 'deprecated', 'revoked')`,
    ),
    digestCheck: check(
      "sandbox_runtime_profiles_digest_check",
      sql`${t.ociDigest} IS NOT NULL OR ${t.sifDigest} IS NOT NULL`,
    ),
  }),
);

/** Binds a logical sandbox contract to a provider's verified concrete image. */
export const sandboxRuntimeContractBindings = pgTable(
  "sandbox_runtime_contract_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerOrgId: uuid("provider_org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    agentId: varchar("agent_id", { length: 255 }).references(() => agents.agentId, {
      onDelete: "cascade",
    }),
    clusterId: varchar("cluster_id", { length: 255 }),
    agentScopeKey: varchar("agent_scope_key", { length: 255 }).notNull().default(""),
    clusterScopeKey: varchar("cluster_scope_key", { length: 255 }).notNull().default(""),
    runtimeContractRef: varchar("runtime_contract_ref", { length: 255 }).notNull(),
    runtimeProfileId: uuid("runtime_profile_id")
      .references(() => sandboxRuntimeProfiles.id, { onDelete: "restrict" })
      .notNull(),
    runtimeDigest: varchar("runtime_digest", { length: 71 }).notNull(),
    attestationKeyId: varchar("attestation_key_id", { length: 255 }),
    attestationSignature: text("attestation_signature"),
    attestedAt: timestamp("attested_at"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    boundBy: varchar("bound_by", { length: 255 }).notNull(),
    boundAt: timestamp("bound_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => ({
    bindingIdx: uniqueIndex("sandbox_runtime_contract_bindings_scope_contract_idx").on(
      t.providerOrgId,
      t.agentScopeKey,
      t.clusterScopeKey,
      t.runtimeContractRef,
    ),
    lookupIdx: index("sandbox_runtime_contract_bindings_lookup_idx").on(
      t.providerOrgId,
      t.runtimeContractRef,
      t.status,
    ),
    statusCheck: check(
      "sandbox_runtime_contract_bindings_status_check",
      sql`${t.status} IN ('active', 'revoked')`,
    ),
  }),
);

export const clusterExecutionAccounts = pgTable(
  "cluster_execution_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerOrgId: uuid("provider_org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    backendType: varchar("backend_type", { length: 20 }).notNull(),
    username: varchar("username", { length: 255 }),
    uid: integer("uid"),
    gid: integer("gid"),
    schedulerAccount: varchar("scheduler_account", { length: 255 }),
    allowedQueues: jsonb("allowed_queues").$type<string[]>().notNull().default([]),
    namespace: varchar("namespace", { length: 255 }),
    serviceAccount: varchar("service_account", { length: 255 }),
    quotaPolicy: jsonb("quota_policy").$type<Record<string, string>>().notNull().default({}),
    sharedService: boolean("shared_service").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    providerAgentIdx: index("cluster_execution_accounts_provider_agent_idx").on(
      t.providerOrgId,
      t.agentId,
    ),
    unixIdentityIdx: uniqueIndex("cluster_execution_accounts_unix_identity_idx").on(
      t.agentId,
      t.uid,
    ),
    k8sIdentityIdx: uniqueIndex("cluster_execution_accounts_k8s_identity_idx").on(
      t.agentId,
      t.namespace,
      t.serviceAccount,
    ),
    backendCheck: check(
      "cluster_execution_accounts_backend_check",
      sql`(${t.backendType} = 'unix' AND ${t.username} IS NOT NULL AND ${t.uid} > 0 AND ${t.gid} > 0) OR (${t.backendType} = 'kubernetes' AND ${t.namespace} IS NOT NULL AND ${t.serviceAccount} IS NOT NULL)`,
    ),
  }),
);

export const userClusterAccountMappings = pgTable(
  "user_cluster_account_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    accountId: uuid("account_id")
      .references(() => clusterExecutionAccounts.id, { onDelete: "cascade" })
      .notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    isDefault: boolean("is_default").notNull().default(false),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => ({
    userAccountIdx: uniqueIndex("user_cluster_account_mappings_user_account_idx").on(
      t.userId,
      t.accountId,
    ),
    userStatusIdx: index("user_cluster_account_mappings_user_status_idx").on(t.userId, t.status),
    statusCheck: check(
      "user_cluster_account_mappings_status_check",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'revoked', 'expired')`,
    ),
  }),
);

export const accountAssignmentDelegations = pgTable("account_assignment_delegations", {
  providerOrgId: uuid("provider_org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  delegated: boolean("delegated").notNull().default(false),
  updatedBy: uuid("updated_by")
    .references(() => users.id)
    .notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const scriptAttestations = pgTable(
  "script_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetRevisionId: uuid("asset_revision_id")
      .references(() => softwareAssetRevisions.id, { onDelete: "cascade" })
      .notNull(),
    scriptSha256: varchar("script_sha256", { length: 64 }).notNull(),
    runtimeProfileId: uuid("runtime_profile_id")
      .references(() => sandboxRuntimeProfiles.id, { onDelete: "restrict" })
      .notNull(),
    runtimeDigest: varchar("runtime_digest", { length: 71 }).notNull(),
    scope: varchar("scope", { length: 20 }).notNull(),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id, {
      onDelete: "cascade",
    }),
    scanResultHash: varchar("scan_result_hash", { length: 64 }).notNull(),
    allowedIdentities: jsonb("allowed_identities")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    signedBy: uuid("signed_by")
      .references(() => users.id)
      .notNull(),
    signedAt: timestamp("signed_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => ({
    revisionScopeIdx: index("script_attestations_revision_scope_idx").on(
      t.assetRevisionId,
      t.scope,
      t.providerOrgId,
      t.status,
    ),
    scopeCheck: check(
      "script_attestations_scope_check",
      sql`(${t.scope} = 'platform' AND ${t.providerOrgId} IS NULL) OR (${t.scope} = 'provider' AND ${t.providerOrgId} IS NOT NULL)`,
    ),
    statusCheck: check(
      "script_attestations_status_check",
      sql`${t.status} IN ('active', 'revoked', 'expired')`,
    ),
  }),
);

export const workflowArtifacts = pgTable(
  "workflow_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowRunId: uuid("workflow_run_id")
      .references(() => workflowRuns.id, { onDelete: "cascade" })
      .notNull(),
    producerNodeId: varchar("producer_node_id", { length: 255 }).notNull(),
    descriptor: varchar("descriptor", { length: 255 }).notNull(),
    ioType: varchar("io_type", { length: 20 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    durability: varchar("durability", { length: 20 }).notNull(),
    netdriveFileId: uuid("netdrive_file_id").references(() => netdriveFiles.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    persistentAt: timestamp("persistent_at"),
  },
  (t) => ({
    runNodeDescriptorIdx: uniqueIndex("workflow_artifacts_run_node_descriptor_idx").on(
      t.workflowRunId,
      t.producerNodeId,
      t.descriptor,
    ),
    hashIdx: index("workflow_artifacts_hash_idx").on(t.contentHash),
    durabilityIdx: index("workflow_artifacts_durability_idx").on(t.durability, t.createdAt),
    ioTypeCheck: check(
      "workflow_artifacts_io_type_check",
      sql`${t.ioType} IN ('Text', 'JSON', 'File', 'FileBatch')`,
    ),
    durabilityCheck: check(
      "workflow_artifacts_durability_check",
      sql`${t.durability} IN ('Ephemeral', 'Checkpoint', 'Persistent')`,
    ),
  }),
);

export const artifactReplicas = pgTable(
  "artifact_replicas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .references(() => workflowArtifacts.id, { onDelete: "cascade" })
      .notNull(),
    agentId: varchar("agent_id", { length: 255 })
      .references(() => agents.agentId, { onDelete: "cascade" })
      .notNull(),
    siteId: varchar("site_id", { length: 255 }).notNull(),
    clusterId: varchar("cluster_id", { length: 255 }).notNull(),
    storageKind: varchar("storage_kind", { length: 20 }).notNull(),
    storageRef: text("storage_ref").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    verifiedAt: timestamp("verified_at"),
    expiresAt: timestamp("expires_at"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    artifactAgentIdx: uniqueIndex("artifact_replicas_artifact_agent_idx").on(
      t.artifactId,
      t.agentId,
      t.storageKind,
    ),
    localityStatusIdx: index("artifact_replicas_locality_status_idx").on(
      t.siteId,
      t.clusterId,
      t.status,
    ),
    expiryIdx: index("artifact_replicas_expiry_idx").on(t.status, t.expiresAt),
    storageKindCheck: check(
      "artifact_replicas_storage_kind_check",
      sql`${t.storageKind} IN ('agent-local', 'netdrive')`,
    ),
    statusCheck: check(
      "artifact_replicas_status_check",
      sql`${t.status} IN ('pending', 'available', 'persisting', 'failed', 'expired')`,
    ),
  }),
);

export const placementPlans = pgTable(
  "placement_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowRunId: uuid("workflow_run_id")
      .references(() => workflowRuns.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    plannerMode: varchar("planner_mode", { length: 20 }).notNull(),
    trigger: varchar("trigger", { length: 100 }).notNull(),
    nodes: jsonb("nodes").$type<Array<Record<string, unknown>>>().notNull(),
    objective: jsonb("objective").$type<Record<string, number>>().notNull(),
    budgetCap: doublePrecision("budget_cap"),
    budgetStatus: varchar("budget_status", { length: 32 }).notNull().default("within-cap"),
    supersedesPlanId: uuid("supersedes_plan_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    runVersionIdx: uniqueIndex("placement_plans_run_version_idx").on(t.workflowRunId, t.version),
    runCreatedIdx: index("placement_plans_run_created_idx").on(t.workflowRunId, t.createdAt),
    modeCheck: check(
      "placement_plans_mode_check",
      sql`${t.plannerMode} IN ('Global', 'Lookahead', 'Greedy')`,
    ),
    budgetStatusCheck: check(
      "placement_plans_budget_status_check",
      sql`${t.budgetStatus} IN ('within-cap', 'awaiting-approval', 'approved')`,
    ),
  }),
);

export const scriptExecutionStats = pgTable(
  "script_execution_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetRevisionId: uuid("asset_revision_id").references(() => softwareAssetRevisions.id, {
      onDelete: "cascade",
    }),
    inlineScriptHash: varchar("inline_script_hash", { length: 64 }),
    runtimeProfileId: uuid("runtime_profile_id")
      .references(() => sandboxRuntimeProfiles.id, { onDelete: "cascade" })
      .notNull(),
    inputSizeBucket: varchar("input_size_bucket", { length: 32 }).notNull(),
    sampleCount: integer("sample_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    averageOutputBytes: doublePrecision("average_output_bytes").notNull().default(0),
    averageOutputRatio: doublePrecision("average_output_ratio").notNull().default(0),
    averagePredictionError: doublePrecision("average_prediction_error").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    revisionRuntimeBucketIdx: uniqueIndex("script_execution_stats_revision_runtime_bucket_idx")
      .on(t.assetRevisionId, t.runtimeProfileId, t.inputSizeBucket)
      .where(sql`${t.assetRevisionId} IS NOT NULL`),
    inlineRuntimeBucketIdx: uniqueIndex("script_execution_stats_inline_runtime_bucket_idx")
      .on(t.inlineScriptHash, t.runtimeProfileId, t.inputSizeBucket)
      .where(sql`${t.inlineScriptHash} IS NOT NULL`),
    sourceCheck: check(
      "script_execution_stats_source_check",
      sql`(${t.assetRevisionId} IS NOT NULL AND ${t.inlineScriptHash} IS NULL) OR (${t.assetRevisionId} IS NULL AND ${t.inlineScriptHash} IS NOT NULL)`,
    ),
  }),
);

export const sandboxPolicyOverlays = pgTable(
  "sandbox_policy_overlays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: varchar("scope", { length: 20 }).notNull(),
    providerOrgId: uuid("provider_org_id").references(() => orgs.id, {
      onDelete: "cascade",
    }),
    clusterId: varchar("cluster_id", { length: 255 }),
    agentId: varchar("agent_id", { length: 255 }).references(() => agents.agentId, {
      onDelete: "cascade",
    }),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    updatedBy: uuid("updated_by")
      .references(() => users.id)
      .notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    platformScopeIdx: uniqueIndex("sandbox_policy_overlays_platform_scope_idx")
      .on(t.scope)
      .where(sql`${t.scope} = 'platform'`),
    providerScopeIdx: uniqueIndex("sandbox_policy_overlays_provider_scope_idx")
      .on(t.providerOrgId)
      .where(sql`${t.scope} = 'provider'`),
    clusterScopeIdx: uniqueIndex("sandbox_policy_overlays_cluster_scope_idx")
      .on(t.providerOrgId, t.clusterId)
      .where(sql`${t.scope} = 'cluster'`),
    agentScopeIdx: uniqueIndex("sandbox_policy_overlays_agent_scope_idx")
      .on(t.agentId)
      .where(sql`${t.scope} = 'agent'`),
    providerIdx: index("sandbox_policy_overlays_provider_idx").on(t.providerOrgId),
    agentIdx: index("sandbox_policy_overlays_agent_idx").on(t.agentId),
    scopeCheck: check(
      "sandbox_policy_overlays_scope_check",
      sql`${t.scope} IN ('platform', 'provider', 'cluster', 'agent')`,
    ),
  }),
);

// Registry artifact registry (migration 0011). Wired here per the
// schema-registry.ts header comment so consumers can `import {
// ociRepository, ... } from "@kuintessence/db"` like the rest of the schema.
export {
  auditRelease,
  bytea,
  ociBlob,
  ociManifest,
  ociRepository,
  ociTag,
  ociUploadSession,
  spackPackage,
} from "./schema-registry";
