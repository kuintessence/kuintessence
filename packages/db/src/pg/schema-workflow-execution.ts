import type { JobSubmission, WorkflowJournalEntry } from "@kuintessence/shared";
import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { jobs, workflowRuns } from "./schema";

export const workflowExecutionLeases = pgTable(
  "workflow_execution_leases",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    token: uuid("token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    check("workflow_execution_lease_pair", sql`(${t.token} IS NULL) = (${t.expiresAt} IS NULL)`),
  ],
);

export const workflowExecutionJournal = pgTable(
  "workflow_execution_journal",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowExecutionLeases.runId, { onDelete: "cascade" }),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    key: text("key").notNull(),
    entry: jsonb("entry").$type<WorkflowJournalEntry>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.keyHash] }),
    check("workflow_execution_journal_hash", sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "workflow_execution_journal_kind",
      sql`${t.entry}->>'kind' IN ('definition', 'version', 'node')`,
    ),
  ],
);

/** A pending dispatch intent is committed with the Job, before contacting any Agent. */
export const workflowExecutionJobs = pgTable(
  "workflow_execution_jobs",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowExecutionLeases.runId, { onDelete: "cascade" }),
    pathHash: varchar("path_hash", { length: 64 }).notNull(),
    path: text("path").notNull(),
    nodeId: text("node_id").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    intent: jsonb("intent").$type<JobSubmission>().notNull(),
    dispatchState: varchar("dispatch_state", { length: 16 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.pathHash] }),
    uniqueIndex("workflow_execution_job_unique").on(t.jobId),
    check("workflow_execution_job_hash", sql`${t.pathHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "workflow_execution_job_dispatch_state",
      sql`${t.dispatchState} IN ('pending', 'acknowledged')`,
    ),
  ],
);
