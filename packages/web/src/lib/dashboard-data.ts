/**
 * Dashboard data aggregations.
 *
 * Pure helpers — no React, no fetch — so they can be unit-tested cheaply.
 */

export interface JobRow {
  id: string;
  name: string;
  status: string;
  submittedAt: string;
}

export interface WorkflowRunRow {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface AgentRow {
  agentId: string;
  siteName: string;
  schedulerType: string;
  schedulerVersion: string;
  status: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string;
  diff?: {
    before?: unknown;
    after?: unknown;
  } | null;
  createdAt: string;
}

const TERMINAL_JOB = new Set(["SUCCEEDED", "COMPLETED", "FAILED", "CANCELLED"]);
const TERMINAL_WORKFLOW = new Set(["SUCCEEDED", "COMPLETED", "FAILED", "CANCELLED"]);

export function activeJobCount(jobs: JobRow[] | undefined): number {
  if (!jobs) return 0;
  return jobs.filter((j) => !TERMINAL_JOB.has(j.status.toUpperCase())).length;
}

export function activeWorkflowCount(runs: WorkflowRunRow[] | undefined): number {
  if (!runs) return 0;
  return runs.filter((r) => !TERMINAL_WORKFLOW.has(r.status.toUpperCase())).length;
}

export function onlineAgentCount(agents: AgentRow[] | undefined): number {
  if (!agents) return 0;
  return agents.filter((a) => a.status.toUpperCase() === "ONLINE").length;
}

/**
 * Bucket job submissions into hourly counts over a rolling 24h window ending now.
 *
 * Returns 24 buckets, each `{ hour: ISO string anchor, count: number }`.
 */
export interface ThroughputBucket {
  hour: string;
  count: number;
}

export function bucketHourly(
  jobs: JobRow[] | undefined,
  now: Date = new Date(),
): ThroughputBucket[] {
  const buckets: ThroughputBucket[] = [];
  const anchor = new Date(now);
  anchor.setMinutes(0, 0, 0);

  const windowStart = anchor.getTime() - 23 * 60 * 60 * 1000;

  for (let i = 0; i < 24; i += 1) {
    const t = new Date(windowStart + i * 60 * 60 * 1000);
    buckets.push({ hour: t.toISOString(), count: 0 });
  }

  if (!jobs) return buckets;
  for (const j of jobs) {
    const ts = Date.parse(j.submittedAt);
    if (Number.isNaN(ts)) continue;
    if (ts < windowStart) continue;
    const offset = Math.floor((ts - windowStart) / (60 * 60 * 1000));
    if (offset < 0 || offset >= 24) continue;
    const bucket = buckets[offset];
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

export function isPlatformBootstrap(
  jobs: JobRow[] | undefined,
  workflows: WorkflowRunRow[] | undefined,
): boolean {
  return (jobs?.length ?? 0) === 0 && (workflows?.length ?? 0) === 0;
}
