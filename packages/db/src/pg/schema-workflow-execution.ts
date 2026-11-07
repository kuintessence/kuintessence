import type { FileInputValue, JobSubmission, WorkflowJournalEntry } from "@kuintessence/shared";
import type { FederationDelegation } from "@kuintessence/shared/federation";
import { sql } from "drizzle-orm";
import {
  check,
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
import { agents, jobs, workflowRuns } from "./schema";

export const jobDispatchOutbox = pgTable(
  "job_dispatch_outbox",
  {
    jobId: uuid("job_id")
      .primaryKey()
      .references(() => jobs.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.agentId),
    dispatchEpoch: integer("dispatch_epoch").notNull(),
    payloadBase64: text("payload_base64").notNull(),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (t) => [
    check("job_dispatch_outbox_epoch", sql`${t.dispatchEpoch} > 0`),
    index("job_dispatch_outbox_pending")
      .on(t.nextAttemptAt)
      .where(sql`${t.acknowledgedAt} IS NULL`),
  ],
);

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
    publishedFiles: jsonb("published_files").$type<Record<string, FileInputValue>>(),
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

/** An invocation fixes its remote identity before preparing the signed outbox message. */
export const workflowExecutionDelegations = pgTable(
  "workflow_execution_delegations",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowExecutionLeases.runId, { onDelete: "cascade" }),
    pathHash: varchar("path_hash", { length: 64 }).notNull(),
    path: text("path").notNull(),
    nodeId: text("node_id").notNull(),
    localSiteId: uuid("local_site_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    intentDigest: varchar("intent_digest", { length: 64 }).notNull(),
    request: jsonb("request").$type<FederationDelegation>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.pathHash] }),
    uniqueIndex("workflow_execution_delegation_operation").on(t.localSiteId, t.operationId),
    check(
      "workflow_execution_delegation_hash",
      sql`${t.pathHash} ~ '^[0-9a-f]{64}$' AND ${t.intentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workflow_execution_delegation_request",
      sql`${t.request}->>'operationId' = ${t.operationId}::text AND ${t.request}->>'senderSiteId' = ${t.localSiteId}::text`,
    ),
  ],
);
