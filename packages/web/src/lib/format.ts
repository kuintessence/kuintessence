/**
 * Formatting helpers shared across pages.
 *
 * Pure functions — no imports from React or query libs — so they're cheap to unit-test.
 */

import { formatDistanceStrict } from "date-fns";

/**
 * Friendly relative time, e.g. "5 minutes ago".
 *
 * Uses `formatDistanceStrict(from, to)` (not `formatDistanceToNowStrict`) so the
 * `now` argument is honored — required for deterministic unit tests.
 *
 * @param iso  - ISO timestamp string.
 * @param now  - Reference instant; defaults to `new Date()`. Tests pin this for determinism.
 */
export function relativeFromNow(iso: string | undefined | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffMs = now.getTime() - ts;
  if (diffMs < 0) return "just now";
  if (diffMs < 60_000) return "just now";
  return `${formatDistanceStrict(new Date(ts), now)} ago`;
}

/**
 * Pretty-print a job/workflow status enum coming from the Server. Returns a token for
 * `<Badge variant={...}>` plus a humanized label.
 */
export type JobBadgeVariant =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "default";

export function statusToBadgeVariant(status: string): JobBadgeVariant {
  const s = status.toUpperCase();
  if (s === "PENDING" || s === "QUEUED") return "pending";
  if (s === "RUNNING" || s === "STARTING") return "running";
  if (s === "SUCCEEDED" || s === "COMPLETED" || s === "DONE") return "succeeded";
  if (s === "FAILED" || s === "ERROR") return "failed";
  if (s === "CANCELLED" || s === "CANCELED" || s === "STOPPED") return "cancelled";
  return "default";
}

export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}
