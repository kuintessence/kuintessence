import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Persistent outbound queue for AgentStream job-status updates.
 *
 * Used when the bidirectional connectRPC stream to the Server is offline:
 * the Agent enqueues each JobStatusReport here so it can be replayed
 * (in `created_at` order, ties broken by `id`) once the stream reconnects.
 *
 * Server-side dedupe is idempotent (see server/src/services/job-service.ts), so
 * replaying a row that the Server already saw is safe.
 */
export const outboundJobStatus = sqliteTable(
  "outbound_job_status",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id").notNull(),
    /** Full JobStatusReport JSON payload (status, schedulerJobId, exitCode, message). */
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Wall-clock ms timestamp when the report was produced. */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    createdAtIdx: index("outbound_job_status_created_at_idx").on(t.createdAt),
  }),
);

export const outboundQueueValidationShadowRejection = sqliteTable(
  "outbound_queue_validation_shadow_rejection",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    failureCode: text("failure_code").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    eventIdIdx: uniqueIndex("outbound_queue_validation_shadow_rejection_event_id_idx").on(
      t.eventId,
    ),
    createdAtIdx: index("outbound_queue_validation_shadow_rejection_created_at_idx").on(
      t.createdAt,
    ),
  }),
);

/**
 * Persistent outbound queue for periodic heartbeat snapshots produced
 * while the Server stream is offline. On reconnect, snapshots are replayed
 * in order so the Server can reconstruct CPU/MEM/job-count history.
 */
export const outboundHeartbeat = sqliteTable(
  "outbound_heartbeat",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Full Heartbeat-shaped snapshot: cpuUsagePercent, memoryUsedMb, runningJobs, queuedJobs, ... */
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Wall-clock ms timestamp when the snapshot was produced. */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    createdAtIdx: index("outbound_heartbeat_created_at_idx").on(t.createdAt),
  }),
);

/**
 * Persistent outbound queue for Spack software operation results produced
 * while the Server stream is offline. Results are replayed on reconnect in the
 * same ordering contract as job status and heartbeat rows.
 */
export const outboundSoftwareOperationResult = sqliteTable(
  "outbound_software_operation_result",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    operationId: text("operation_id").notNull(),
    /** Full SoftwareOperationResult-shaped JSON payload. */
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Wall-clock ms timestamp when the result was produced. */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    createdAtIdx: index("outbound_software_operation_result_created_at_idx").on(t.createdAt),
  }),
);

export const activeRemoteJobs = sqliteTable(
  "active_remote_jobs",
  {
    jobId: text("job_id").primaryKey(),
    schedulerJobId: text("scheduler_job_id").notNull(),
    spec: text("spec", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    expectedOutputs: text("expected_outputs", { mode: "json" })
      .$type<Record<string, unknown>[]>()
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    schedulerJobIdIdx: index("active_remote_jobs_scheduler_job_id_idx").on(t.schedulerJobId),
  }),
);

/**
 * Cleanup work registered before a Data Market delivery or licensed-material
 * mount changes the filesystem. Targets are Agent-owned job paths only: this
 * table intentionally never stores presigned URLs or restricted source paths.
 */
export const jobCleanupIntents = sqliteTable(
  "job_cleanup_intents",
  {
    jobId: text("job_id").primaryKey(),
    dataDeliveries: text("data_deliveries", { mode: "json" })
      .$type<Record<string, unknown>[]>()
      .notNull(),
    licensedMounts: text("licensed_mounts", { mode: "json" })
      .$type<Record<string, unknown>[]>()
      .notNull(),
    schedulerJobId: text("scheduler_job_id"),
    schedulerSubmissionTag: text("scheduler_submission_tag"),
    schedulerAccount: text("scheduler_account"),
    schedulerNamespace: text("scheduler_namespace"),
    restrictedWorkRoot: integer("restricted_work_root", { mode: "boolean" })
      .notNull()
      .default(false),
    revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
    revokeReason: text("revoke_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    createdAtIdx: index("job_cleanup_intents_created_at_idx").on(t.createdAt),
  }),
);

/**
 * Durable dispatch fence. Cleanup intents are removed after successful local
 * cleanup, but a late DispatchJob must still be rejected after a revocation.
 */
export const jobRevocationTombstones = sqliteTable(
  "job_revocation_tombstones",
  {
    jobId: text("job_id").primaryKey(),
    revokedEpoch: integer("revoked_epoch").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    updatedAtIdx: index("job_revocation_tombstones_updated_at_idx").on(t.updatedAt),
  }),
);

export const queuedOperations = sqliteTable("queued_operations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  operationType: text("operation_type").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
});

export const localJobs = sqliteTable("local_jobs", {
  jobId: text("job_id").primaryKey(),
  schedulerJobId: text("scheduler_job_id"),
  /** Human-readable job name from the spec; nullable for legacy rows. */
  name: text("name"),
  status: text("status").notNull().default("pending"),
  command: text("command").notNull(),
  cpus: integer("cpus").notNull(),
  memoryMb: integer("memory_mb").notNull(),
  /** GPU count requested; nullable for legacy rows (treated as 0). */
  gpus: integer("gpus"),
  /** Wall-clock time limit in seconds; nullable when unset (no/default limit). */
  wallTimeSec: integer("wall_time_sec"),
  exitCode: integer("exit_code"),
  submittedAt: integer("submitted_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const agentConfig = sqliteTable("agent_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Local workflow-run state for the all-in-one binary's `WorkflowRunStore`
 * (`@kuintessence/shared`). Persists run rows without a Server/Postgres.
 *
 * `stepJobs` (step→job UUID map) and `result` (terminal per-node result)
 * are TEXT columns holding JSON encoded/decoded by `SqliteWorkflowRunStore` —
 * same manual-JSON convention as `outbound_job_status.payload`.
 */
export const localWorkflowRuns = sqliteTable("local_workflow_runs", {
  runId: text("run_id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  submittedBy: text("submitted_by").notNull(),
  /** "running" while active, then "succeeded" | "failed" once terminal. */
  status: text("status").notNull(),
  /** JSON-encoded step→job UUID map; defaults to "{}". */
  stepJobs: text("step_jobs").notNull().default("{}"),
  /** JSON-encoded terminal result, or null while the run is active. */
  result: text("result"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Read-only cache of software detected on the local host by the all-in-one
 * binary's probe of spack / environment-modules. Refreshed by the kernel's
 * LocalSoftwareCatalog; consumed by the local TUI software pane when running
 * without a Server. Purely a materialized view of what `spack find` / `module
 * avail` report — never authoritative install state.
 */
export const localSoftware = sqliteTable(
  "local_software",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Package name, e.g. "gromacs". */
    name: text("name").notNull(),
    /** Resolved version string, e.g. "2024.1". */
    version: text("version").notNull(),
    /** Full provider spec, e.g. "gromacs@2024.1" (spack) or a module name. */
    spec: text("spec").notNull(),
    /** Detection provider: "spack" | "module". */
    source: text("source").notNull(),
    /** Wall-clock ms timestamp of the probe that produced this row. */
    detectedAt: integer("detected_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    nameIdx: index("local_software_name_idx").on(t.name),
  }),
);

/**
 * Persistent record of every `DispatchJob` message the Agent has received
 * from the Server. Each row is created BEFORE the job is handed to the runner;
 * `acked_at` is set to NULL until the runner has produced its first status
 * update (queued / running / failed / completed).
 *
 * Purpose: survive an Agent crash or stream disconnect that happens after
 * the dispatch was received but before the corresponding `JobStatusReport`
 * was sent. On reconnect the Agent queries `acked_at IS NULL` and re-emits
 * an idempotent status update so the Server does not re-dispatch and the same
 * job is not run twice.
 *
 * `dispatch_id` is unique (the same DispatchJob is never persisted twice).
 * `job_id` is duplicated only across distinct dispatches for the same job
 * (extremely rare — defensive idempotency).
 */
export const inboundDispatchPending = sqliteTable(
  "inbound_dispatch_pending",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Stable identifier for this DispatchJob delivery (jobId fallback if proto lacks one). */
    dispatchId: text("dispatch_id").notNull().unique(),
    /** The job-id the dispatch refers to — used to query the local runner on reconnect. */
    jobId: text("job_id").notNull(),
    /** Full DispatchJob payload (name, command, cpus, memory, etc.) for diagnostic replay. */
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Wall-clock ms when the Agent received the dispatch. */
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * Wall-clock ms when the Agent emitted the first status update for this
     * dispatch. NULL means the ack is still owed and will be replayed on the
     * next successful reconnect.
     */
    ackedAt: integer("acked_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    receivedAtIdx: index("inbound_dispatch_pending_received_at_idx").on(t.receivedAt),
    ackedAtIdx: index("inbound_dispatch_pending_acked_at_idx").on(t.ackedAt),
  }),
);

export const sandboxReplayNonces = sqliteTable(
  "sandbox_replay_nonces",
  {
    nonce: text("nonce").primaryKey(),
    jobId: text("job_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    expiresAtIdx: index("sandbox_replay_nonces_expires_at_idx").on(t.expiresAt),
  }),
);
