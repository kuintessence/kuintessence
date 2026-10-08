/**
 * Formatting helpers shared across pages.
 *
 * Pure functions — no imports from React or query libs — so they're cheap to unit-test.
 */

import { formatDistanceStrict } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";

/**
 * Friendly relative time, e.g. "5 minutes ago".
 *
 * Uses `formatDistanceStrict(from, to)` (not `formatDistanceToNowStrict`) so the
 * `now` argument is honored — required for deterministic unit tests.
 *
 * @param iso  - ISO timestamp string.
 * @param now  - Reference instant; defaults to `new Date()`. Tests pin this for determinism.
 */
export function relativeFromNow(
  iso: string | undefined | null,
  now: Date = new Date(),
  language = "en",
): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffMs = now.getTime() - ts;
  const chinese = language.startsWith("zh");
  if (diffMs < 60_000) return chinese ? "刚刚" : "just now";
  return formatDistanceStrict(new Date(ts), now, {
    addSuffix: true,
    locale: chinese ? zhCN : enUS,
  });
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
  if (s === "PENDING" || s === "QUEUED" || s === "AWAITING_APPROVAL") return "pending";
  if (s === "RUNNING" || s === "STARTING") return "running";
  if (s === "SUCCEEDED" || s === "COMPLETED" || s === "DONE") return "succeeded";
  if (s === "FAILED" || s === "ERROR") return "failed";
  if (s === "CANCELLED" || s === "CANCELED" || s === "STOPPED") return "cancelled";
  return "default";
}

export function statusLabel(status: string, language = "en"): string {
  if (language.startsWith("zh")) {
    const labels: Record<string, string> = {
      pending: "等待中",
      submitted: "已提交",
      awaiting_approval: "等待审批",
      queued: "排队中",
      starting: "启动中",
      running: "运行中",
      succeeded: "已完成",
      completed: "已完成",
      done: "已完成",
      failed: "失败",
      error: "错误",
      cancelled: "已取消",
      canceled: "已取消",
      cancelling: "取消中",
      stopped: "已停止",
      online: "在线",
      offline: "离线",
    };
    const label = labels[status.toLowerCase()];
    if (label) return label;
  }
  if (status.toLowerCase() === "awaiting_approval") return "Awaiting approval";
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}
