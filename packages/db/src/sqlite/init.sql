-- Initial schema for Agent local SQLite database.
-- Source of truth: packages/db/src/sqlite/schema.ts
-- Applied at Agent startup via runSqliteMigrations(db).

CREATE TABLE IF NOT EXISTS queued_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER
);

CREATE TABLE IF NOT EXISTS local_jobs (
  job_id TEXT PRIMARY KEY,
  scheduler_job_id TEXT,
  scheduler_submission_tag TEXT,
  restricted_work_root INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  command TEXT NOT NULL,
  cpus INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,
  gpus INTEGER,
  wall_time_sec INTEGER,
  exit_code INTEGER,
  submitted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Local workflow-run state for the all-in-one binary's WorkflowRunStore.
-- step_jobs / result hold JSON encoded by the store class (TEXT, like
-- outbound_job_status.payload). Lets the local runner persist run state with
-- no Server/Postgres.
CREATE TABLE IF NOT EXISTS local_workflow_runs (
  run_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  submitted_by TEXT NOT NULL,
  status TEXT NOT NULL,
  step_jobs TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Read-only cache of software detected locally (spack / environment-modules)
-- by the all-in-one binary. Materialized view only — never authoritative
-- install state. Refreshed by the kernel's LocalSoftwareCatalog.
CREATE TABLE IF NOT EXISTS local_software (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  spec TEXT NOT NULL,
  source TEXT NOT NULL,
  detected_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS local_software_name_idx ON local_software (name);

-- Outbound queue: job status updates produced while the Server stream is offline.
-- Replayed on reconnect in (created_at, id) order. Server treats duplicate
-- updates idempotently, so re-delivery is safe.
CREATE TABLE IF NOT EXISTS outbound_job_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbound_job_status_created_at_idx
  ON outbound_job_status (created_at);

CREATE TABLE IF NOT EXISTS outbound_queue_validation_shadow_rejection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  failure_code TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS outbound_queue_validation_shadow_rejection_event_id_idx
  ON outbound_queue_validation_shadow_rejection (event_id);
CREATE INDEX IF NOT EXISTS outbound_queue_validation_shadow_rejection_created_at_idx
  ON outbound_queue_validation_shadow_rejection (created_at);

-- Outbound queue: heartbeat snapshots produced while the Server stream is offline.
CREATE TABLE IF NOT EXISTS outbound_heartbeat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbound_heartbeat_created_at_idx
  ON outbound_heartbeat (created_at);

-- Outbound queue: Spack software operation results produced while the Server
-- stream is offline. Replayed on reconnect in (created_at, id) order.
CREATE TABLE IF NOT EXISTS outbound_software_operation_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbound_software_operation_result_created_at_idx
  ON outbound_software_operation_result (created_at);

-- Active remote jobs that were submitted to the scheduler by the Agent but
-- have not reached a terminal scheduler state yet. On Agent process restart,
-- the stream recreates runners from these rows and resumes polling by
-- scheduler_job_id instead of submitting duplicates.
CREATE TABLE IF NOT EXISTS active_remote_jobs (
  job_id TEXT PRIMARY KEY,
  scheduler_job_id TEXT NOT NULL,
  spec TEXT NOT NULL,
  expected_outputs TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS active_remote_jobs_scheduler_job_id_idx
  ON active_remote_jobs (scheduler_job_id);

-- Cleanup intents are recorded before a data delivery or licensed readonly
-- mount changes the filesystem. They contain only job-owned target paths and
-- operation kinds, never object URLs or provider-local restricted sources.
CREATE TABLE IF NOT EXISTS job_cleanup_intents (
  job_id TEXT PRIMARY KEY,
  data_deliveries TEXT NOT NULL,
  licensed_mounts TEXT NOT NULL,
  scheduler_job_id TEXT,
  scheduler_submission_tag TEXT,
  scheduler_account TEXT,
  scheduler_namespace TEXT,
  restricted_work_root INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoke_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS job_cleanup_intents_created_at_idx
  ON job_cleanup_intents (created_at);

-- A revoke fence deliberately outlives cleanup work. It prevents a delayed
-- DispatchJob from being accepted after the Agent has cleaned the job state.
CREATE TABLE IF NOT EXISTS job_revocation_tombstones (
  job_id TEXT PRIMARY KEY,
  revoked_epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS job_revocation_tombstones_updated_at_idx
  ON job_revocation_tombstones (updated_at);

-- Inbound dispatch ack tracking. A row is inserted with acked_at=NULL the
-- moment the Agent receives a DispatchJob from the Server. The row is updated
-- with acked_at=now() once the runner has produced its first status update.
-- On reconnect, rows where acked_at IS NULL are replayed (idempotent on the
-- Server side) so a disconnect between dispatch-receive and ack-send does not
-- cause Server to re-dispatch the same job twice.
CREATE TABLE IF NOT EXISTS inbound_dispatch_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS inbound_dispatch_pending_received_at_idx
  ON inbound_dispatch_pending (received_at);
CREATE INDEX IF NOT EXISTS inbound_dispatch_pending_acked_at_idx
  ON inbound_dispatch_pending (acked_at);

-- Consumed Sandbox signature nonces. The primary key makes replay rejection
-- atomic across Agent restarts; expired entries are reclaimed opportunistically.
CREATE TABLE IF NOT EXISTS sandbox_replay_nonces (
  nonce TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sandbox_replay_nonces_expires_at_idx
  ON sandbox_replay_nonces (expires_at);
