import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  applyDataMarket0043StagePathBackfill,
  type DataMarket0043PreflightResult,
  type DataMarket0043UpgradePort,
  preflightDataMarket0043Upgrade,
} from "./data-market-0043-upgrade";

export const DATA_MARKET_0043_MIGRATION_TAG = "0043_light_cloak";
export const DATA_DELIVERY_0046_MIGRATION_TAG = "0046_grey_maddog";
export const AUTHORIZATION_SUBJECTS_0047_MIGRATION_TAG = "0047_whole_pepper_potts";
export const AUTHORIZATION_SUBJECTS_0048_MIGRATION_TAG = "0048_whole_firedrake";

export interface PgMigrationFile {
  tag: string;
  folderMillis: number;
  hash: string;
  statements: readonly string[];
}

export interface PgMigrationTransaction extends DataMarket0043UpgradePort {
  acquireMigrationLock(): Promise<void>;
  ensureMigrationJournal(): Promise<void>;
  getLatestAppliedMigrationMillis(): Promise<number | null>;
  lockDataMarket0043Rows(): Promise<void>;
  lockDataDelivery0046Rows(): Promise<void>;
  addDataDeliveryRevocationEpochNullable(): Promise<void>;
  backfillDataDeliveryRevocationEpoch(): Promise<number>;
  finalizeDataDeliveryRevocationEpoch(): Promise<void>;
  lockAuthorizationSubjectRows(): Promise<void>;
  canonicalizeAuthorizationSubjects(): Promise<AuthorizationSubjectBackfillResult>;
  executeMigrationStatement(statement: string): Promise<void>;
  recordMigration(migration: PgMigrationFile): Promise<void>;
}

export interface AuthorizationSubjectBackfillResult {
  converted: number;
  blockers: readonly AuthorizationSubjectBackfillBlocker[];
  terminalHistory: readonly AuthorizationSubjectTerminalHistory[];
}

export interface AuthorizationSubjectBackfillBlocker {
  bindingId: string;
  subjectId: string | null;
}

export interface AuthorizationSubjectTerminalHistory {
  bindingId: string;
  status: "completed" | "failed" | "cancelled";
}

export interface PgMigrationRunnerPort {
  transaction(callback: (transaction: PgMigrationTransaction) => Promise<void>): Promise<void>;
}

export class DataMarket0043PreflightError extends Error {
  constructor(readonly result: DataMarket0043PreflightResult) {
    super(
      `Data Market 0043 preflight blocked the migration (${result.blockers.length} descriptor conflict${result.blockers.length === 1 ? "" : "s"})`,
    );
    this.name = "DataMarket0043PreflightError";
  }
}

export class AuthorizationSubject0047PreflightError extends Error {
  constructor(readonly result: AuthorizationSubjectBackfillResult) {
    super(
      `Authorization subject 0047 preflight blocked the migration (${result.blockers.length} untyped or ambiguous subject${result.blockers.length === 1 ? "" : "s"})`,
    );
    this.name = "AuthorizationSubject0047PreflightError";
  }
}

export async function runPgMigrations(
  port: PgMigrationRunnerPort,
  migrations: readonly PgMigrationFile[],
): Promise<void> {
  await port.transaction(async (transaction) => {
    await transaction.acquireMigrationLock();
    await transaction.ensureMigrationJournal();
    const latestAppliedMillis = await transaction.getLatestAppliedMigrationMillis();
    const pendingMigrations = migrations.filter(
      (migration) => latestAppliedMillis === null || migration.folderMillis > latestAppliedMillis,
    );

    for (const migration of pendingMigrations) {
      if (migration.tag === DATA_MARKET_0043_MIGRATION_TAG) {
        await runDataMarket0043Migration(transaction, migration);
      } else if (migration.tag === DATA_DELIVERY_0046_MIGRATION_TAG) {
        await runDataDelivery0046Migration(transaction, migration);
      } else if (
        migration.tag === AUTHORIZATION_SUBJECTS_0047_MIGRATION_TAG ||
        migration.tag === AUTHORIZATION_SUBJECTS_0048_MIGRATION_TAG
      ) {
        await runAuthorizationSubjects0047Migration(transaction, migration);
      } else {
        await executeMigration(transaction, migration);
      }
    }
  });
}

async function runDataDelivery0046Migration(
  transaction: PgMigrationTransaction,
  migration: PgMigrationFile,
): Promise<void> {
  const [generatedAddRevocationEpoch, ...remainingStatements] = migration.statements;
  if (
    generatedAddRevocationEpoch?.trim() !==
    'ALTER TABLE "data_delivery_revocations" ADD COLUMN "revoked_epoch" integer NOT NULL;'
  ) {
    throw new Error("Unexpected generated 0046 revocation epoch statement");
  }

  await transaction.lockDataDelivery0046Rows();
  await transaction.addDataDeliveryRevocationEpochNullable();
  await transaction.backfillDataDeliveryRevocationEpoch();
  await transaction.finalizeDataDeliveryRevocationEpoch();
  await executeMigrationStatements(transaction, remainingStatements);
  await transaction.recordMigration(migration);
}

async function runAuthorizationSubjects0047Migration(
  transaction: PgMigrationTransaction,
  migration: PgMigrationFile,
): Promise<void> {
  await transaction.lockAuthorizationSubjectRows();
  await executeMigrationStatements(transaction, migration.statements);
  const result = await transaction.canonicalizeAuthorizationSubjects();
  if (result.blockers.length > 0) {
    throw new AuthorizationSubject0047PreflightError(result);
  }
  await transaction.recordMigration(migration);
}

async function runDataMarket0043Migration(
  transaction: PgMigrationTransaction,
  migration: PgMigrationFile,
): Promise<void> {
  await transaction.lockDataMarket0043Rows();
  const preflight = await preflightDataMarket0043Upgrade(transaction);
  if (!preflight.ready) {
    throw new DataMarket0043PreflightError(preflight);
  }

  await executeMigrationStatements(transaction, migration.statements);
  await applyDataMarket0043StagePathBackfill(transaction, preflight.stagePathBindings);
  await transaction.recordMigration(migration);
}

async function executeMigration(
  transaction: PgMigrationTransaction,
  migration: PgMigrationFile,
): Promise<void> {
  await executeMigrationStatements(transaction, migration.statements);
  await transaction.recordMigration(migration);
}

async function executeMigrationStatements(
  transaction: PgMigrationTransaction,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    if (statement.trim().length > 0) {
      await transaction.executeMigrationStatement(statement);
    }
  }
}

interface MigrationJournalEntry {
  tag: string;
  when: number;
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

export async function loadPgMigrationFiles(
  migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../migrations"),
): Promise<PgMigrationFile[]> {
  const journal = parseMigrationJournal(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  );
  return Promise.all(
    journal.entries.map(async (entry) => {
      const sql = await readFile(join(migrationsFolder, `${entry.tag}.sql`), "utf8");
      return {
        tag: entry.tag,
        folderMillis: entry.when,
        hash: createHash("sha256").update(sql).digest("hex"),
        statements: sql.split("--> statement-breakpoint"),
      };
    }),
  );
}

function parseMigrationJournal(value: string): MigrationJournal {
  const parsed: unknown = JSON.parse(value);
  if (!isMigrationJournal(parsed)) {
    throw new Error("Invalid Drizzle migration journal");
  }
  return parsed;
}

function isMigrationJournal(value: unknown): value is MigrationJournal {
  if (
    !value ||
    typeof value !== "object" ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  ) {
    return false;
  }
  return value.entries.every(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      "tag" in entry &&
      typeof entry.tag === "string" &&
      "when" in entry &&
      typeof entry.when === "number",
  );
}

class PostgresMigrationTransaction implements PgMigrationTransaction {
  constructor(private readonly sql: postgres.TransactionSql) {}

  async acquireMigrationLock(): Promise<void> {
    await this.sql`SELECT pg_advisory_xact_lock(hashtext('kuintessence:pg-migrations'))`;
  }

  async ensureMigrationJournal(): Promise<void> {
    await this.sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `;
  }

  async getLatestAppliedMigrationMillis(): Promise<number | null> {
    const rows = await this.sql<{ createdAt: number | string | null }[]>`
      SELECT created_at AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const latest = rows[0]?.createdAt;
    return latest === undefined || latest === null ? null : Number(latest);
  }

  async lockDataMarket0043Rows(): Promise<void> {
    await this.sql`SELECT pg_advisory_xact_lock(hashtext('kuintessence:data-market-0043'))`;
    await this.sql`LOCK TABLE data_replicas, job_data_bindings IN SHARE ROW EXCLUSIVE MODE`;
  }

  async lockDataDelivery0046Rows(): Promise<void> {
    await this.sql`SELECT pg_advisory_xact_lock(hashtext('kuintessence:data-delivery-0046'))`;
    await this.sql`LOCK TABLE data_delivery_revocations IN SHARE ROW EXCLUSIVE MODE`;
  }

  async addDataDeliveryRevocationEpochNullable(): Promise<void> {
    await this.sql`
      ALTER TABLE data_delivery_revocations
      ADD COLUMN revoked_epoch integer
    `;
  }

  async backfillDataDeliveryRevocationEpoch(): Promise<number> {
    const result = await this.sql`
      UPDATE data_delivery_revocations
      SET revoked_epoch = 0
      WHERE revoked_epoch IS NULL
    `;
    return result.count;
  }

  async finalizeDataDeliveryRevocationEpoch(): Promise<void> {
    await this.sql`
      ALTER TABLE data_delivery_revocations
      ALTER COLUMN revoked_epoch SET DEFAULT 0
    `;
    await this.sql`
      ALTER TABLE data_delivery_revocations
      ALTER COLUMN revoked_epoch SET NOT NULL
    `;
  }

  async lockAuthorizationSubjectRows(): Promise<void> {
    await this
      .sql`SELECT pg_advisory_xact_lock(hashtext('kuintessence:authorization-subjects-0047'))`;
    await this.sql`LOCK TABLE job_data_bindings, jobs IN SHARE ROW EXCLUSIVE MODE`;
  }

  async canonicalizeAuthorizationSubjects(): Promise<AuthorizationSubjectBackfillResult> {
    const blockers = await this.sql<AuthorizationSubjectBackfillBlocker[]>`
      SELECT binding.id AS "bindingId", NULL::text AS "subjectId"
      FROM job_data_bindings AS binding
      WHERE jsonb_typeof(binding.authorization_subject_ids) IS DISTINCT FROM 'array'

      UNION ALL

      SELECT binding.id AS "bindingId", NULL::text AS "subjectId"
      FROM job_data_bindings AS binding
      INNER JOIN jobs AS job ON job.id = binding.job_id
      WHERE binding.source = 'data-market'
        AND binding.authorization_subject_ids = '[]'::jsonb
        AND job.status IN ('pending', 'queued', 'running')
        AND job.submitted_by IS NULL
        AND job.org_id IS NULL

      UNION ALL

      SELECT
        binding.id AS "bindingId",
        CASE
          WHEN jsonb_typeof(subject.value) = 'string' THEN subject.value #>> '{}'
          ELSE NULL
        END AS "subjectId"
      FROM job_data_bindings AS binding
      INNER JOIN jobs AS job ON job.id = binding.job_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(binding.authorization_subject_ids) = 'array'
            THEN binding.authorization_subject_ids
          ELSE '[]'::jsonb
        END
      ) AS subject(value)
      WHERE jsonb_typeof(binding.authorization_subject_ids) = 'array'
        AND NOT (
        jsonb_typeof(subject.value) = 'string'
        AND (
          subject.value #>> '{}' ~ '^(user|organization):.+'
          OR (
            job.submitted_by IS NOT NULL
            AND subject.value #>> '{}' = job.submitted_by::text
            AND (job.org_id IS NULL OR subject.value #>> '{}' <> job.org_id::text)
          )
          OR (
            job.org_id IS NOT NULL
            AND subject.value #>> '{}' = job.org_id::text
            AND (job.submitted_by IS NULL OR subject.value #>> '{}' <> job.submitted_by::text)
          )
        )
      )
    `;
    if (blockers.length > 0) return { converted: 0, blockers, terminalHistory: [] };

    const terminalHistory = await this.sql<AuthorizationSubjectTerminalHistory[]>`
      SELECT binding.id AS "bindingId", job.status
      FROM job_data_bindings AS binding
      INNER JOIN jobs AS job ON job.id = binding.job_id
      WHERE binding.source = 'data-market'
        AND binding.authorization_subject_ids = '[]'::jsonb
        AND job.status IN ('completed', 'failed', 'cancelled')
        AND job.submitted_by IS NULL
        AND job.org_id IS NULL
      ORDER BY binding.id
    `;

    const backfilled = await this.sql`
      WITH derived_subjects AS (
        SELECT
          binding.id,
          subject.value,
          subject.ordinality
        FROM job_data_bindings AS binding
        INNER JOIN jobs AS job ON job.id = binding.job_id
        CROSS JOIN LATERAL (
          SELECT 'user:'::text || job.submitted_by::text AS value, 1 AS ordinality
          WHERE job.submitted_by IS NOT NULL

          UNION ALL

          SELECT 'organization:'::text || job.org_id::text AS value, 2 AS ordinality
          WHERE job.org_id IS NOT NULL
        ) AS subject
        WHERE binding.source = 'data-market'
          AND binding.authorization_subject_ids = '[]'::jsonb
      ),
      unique_subjects AS (
        SELECT id, value, MIN(ordinality) AS ordinality
        FROM derived_subjects
        GROUP BY id, value
      ),
      normalized AS (
        SELECT
          id,
          jsonb_agg(to_jsonb(value) ORDER BY ordinality) AS subjects
        FROM unique_subjects
        GROUP BY id
      )
      UPDATE job_data_bindings AS binding
      SET authorization_subject_ids = normalized.subjects
      FROM normalized
      WHERE binding.id = normalized.id
    `;

    const canonicalized = await this.sql`
      WITH canonical_subjects AS (
        SELECT
          binding.id,
          CASE
            WHEN subject.value #>> '{}' ~ '^(user|organization):.+' THEN subject.value #>> '{}'
            WHEN subject.value #>> '{}' = job.submitted_by::text
              THEN 'user:' || (subject.value #>> '{}')
            ELSE 'organization:' || (subject.value #>> '{}')
          END AS value,
          subject.ordinality,
          NOT (subject.value #>> '{}' ~ '^(user|organization):.+') AS is_bare
        FROM job_data_bindings AS binding
        INNER JOIN jobs AS job ON job.id = binding.job_id
        CROSS JOIN LATERAL jsonb_array_elements(binding.authorization_subject_ids)
          WITH ORDINALITY AS subject(value, ordinality)
      ),
      unique_subjects AS (
        SELECT id, value, MIN(ordinality) AS ordinality
        FROM canonical_subjects
        GROUP BY id, value
      ),
      subject_flags AS (
        SELECT id, bool_or(is_bare) AS has_bare_subject
        FROM canonical_subjects
        GROUP BY id
      ),
      normalized AS (
        SELECT
          unique_subjects.id,
          jsonb_agg(to_jsonb(unique_subjects.value) ORDER BY unique_subjects.ordinality) AS subjects,
          subject_flags.has_bare_subject
        FROM unique_subjects
        INNER JOIN subject_flags ON subject_flags.id = unique_subjects.id
        GROUP BY unique_subjects.id, subject_flags.has_bare_subject
      )
      UPDATE job_data_bindings AS binding
      SET authorization_subject_ids = normalized.subjects
      FROM normalized
      WHERE binding.id = normalized.id
        AND normalized.has_bare_subject
    `;
    return {
      converted: backfilled.count + canonicalized.count,
      blockers: [],
      terminalHistory,
    };
  }

  async markAvailableReplicasStale(): Promise<number> {
    const result = await this.sql`
      UPDATE data_replicas
      SET status = 'stale', updated_at = NOW()
      WHERE status = 'available'
    `;
    return result.count;
  }

  async listBindingsForStagePathPreflight() {
    return this.sql<{ id: string; jobId: string; inputDescriptor: string }[]>`
      SELECT id, job_id AS "jobId", input_descriptor AS "inputDescriptor"
      FROM job_data_bindings
      ORDER BY id
    `;
  }

  async listBindingsMissingStagePath() {
    return this.sql<{ id: string; jobId: string; inputDescriptor: string }[]>`
      SELECT id, job_id AS "jobId", input_descriptor AS "inputDescriptor"
      FROM job_data_bindings
      WHERE stage_path IS NULL
      ORDER BY id
    `;
  }

  async setStagePaths(bindings: readonly { id: string; stagePath: string }[]): Promise<void> {
    for (const binding of bindings) {
      await this.sql`
        UPDATE job_data_bindings
        SET stage_path = ${binding.stagePath}
        WHERE id = ${binding.id}
      `;
    }
  }

  async executeMigrationStatement(statement: string): Promise<void> {
    await this.sql.unsafe(statement);
  }

  async recordMigration(migration: PgMigrationFile): Promise<void> {
    await this.sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${migration.hash}, ${migration.folderMillis})
    `;
  }
}

class PostgresMigrationRunner implements PgMigrationRunnerPort {
  constructor(private readonly sql: postgres.Sql) {}

  async transaction(
    callback: (transaction: PgMigrationTransaction) => Promise<void>,
  ): Promise<void> {
    await this.sql.begin(async (sql) => callback(new PostgresMigrationTransaction(sql)));
  }
}

export async function migratePostgresDatabase(
  connectionString: string,
  migrations?: readonly PgMigrationFile[],
): Promise<void> {
  const sql = postgres(connectionString, { max: 1 });
  try {
    await runPgMigrations(
      new PostgresMigrationRunner(sql),
      migrations ?? (await loadPgMigrationFiles()),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set before running migrations");
  }
  await migratePostgresDatabase(connectionString);
}
