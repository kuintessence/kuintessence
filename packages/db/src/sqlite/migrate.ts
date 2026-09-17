import type { Database } from "bun:sqlite";
import INIT_SQL from "./init.sql" with { type: "text" };

/** Columns added to `local_jobs` after its initial shape shipped. `CREATE TABLE
 *  IF NOT EXISTS` is a no-op on a pre-existing table, so a persisted
 *  `~/.kq/local.db` from an older kq wouldn't gain these — backfill them with
 *  idempotent ADD COLUMNs so an upgrade doesn't hit "no such column". */
const LOCAL_JOBS_ADDED_COLUMNS: ReadonlyArray<{ name: string; def: string }> = [
  { name: "name", def: "TEXT" },
  { name: "gpus", def: "INTEGER" },
  { name: "wall_time_sec", def: "INTEGER" },
];

const JOB_CLEANUP_INTENTS_ADDED_COLUMNS: ReadonlyArray<{ name: string; def: string }> = [
  { name: "scheduler_job_id", def: "TEXT" },
  { name: "scheduler_submission_tag", def: "TEXT" },
  { name: "scheduler_account", def: "TEXT" },
  { name: "scheduler_namespace", def: "TEXT" },
  { name: "restricted_work_root", def: "INTEGER NOT NULL DEFAULT 0" },
  { name: "revoked", def: "INTEGER NOT NULL DEFAULT 0" },
  { name: "revoke_reason", def: "TEXT" },
];

/** ADD COLUMN, treating SQLite's "duplicate column name" as the idempotent
 *  success case (the column already exists). Any other error propagates. */
function addColumnIfMissing(db: Database, table: string, column: string, def: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column name/i.test(err.message)) {
      throw err;
    }
  }
}

/**
 * Apply the SQLite schema to an Agent / all-in-one local database.
 * Idempotent: `CREATE TABLE IF NOT EXISTS` for the base shape, plus idempotent
 * ADD COLUMNs for fields added after a table first shipped (so an existing
 * local.db evolves on upgrade rather than failing on a missing column).
 */
export function runSqliteMigrations(db: Database): void {
  db.exec(INIT_SQL);
  for (const col of LOCAL_JOBS_ADDED_COLUMNS) {
    addColumnIfMissing(db, "local_jobs", col.name, col.def);
  }
  for (const col of JOB_CLEANUP_INTENTS_ADDED_COLUMNS) {
    addColumnIfMissing(db, "job_cleanup_intents", col.name, col.def);
  }
}
