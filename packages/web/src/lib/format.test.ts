import { describe, expect, test } from "vitest";
import { relativeFromNow, statusLabel, statusToBadgeVariant } from "./format";

const NOW = new Date("2026-04-27T12:00:00Z");

describe("relativeFromNow", () => {
  test("localizes Chinese timestamps and preserves future clock-skew handling", () => {
    expect(relativeFromNow(new Date(NOW.getTime() - 5_000).toISOString(), NOW, "zh-CN")).toBe(
      "刚刚",
    );
    expect(relativeFromNow(new Date(NOW.getTime() - 300_000).toISOString(), NOW, "zh")).toBe(
      "5 分钟前",
    );
    expect(relativeFromNow(new Date(NOW.getTime() + 60_000).toISOString(), NOW, "zh")).toBe("刚刚");
  });
  test('returns "—" for null/undefined input', () => {
    expect(relativeFromNow(null, NOW)).toBe("—");
    expect(relativeFromNow(undefined, NOW)).toBe("—");
  });

  test('returns "just now" within 60s', () => {
    expect(relativeFromNow(new Date(NOW.getTime() - 5_000).toISOString(), NOW)).toBe("just now");
    expect(relativeFromNow(new Date(NOW.getTime() - 59_000).toISOString(), NOW)).toBe("just now");
  });

  test("clock-skew (future) does not crash", () => {
    expect(relativeFromNow(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe("just now");
  });

  test("uses date-fns formatDistanceToNowStrict beyond 1 minute", () => {
    expect(relativeFromNow(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe(
      "5 minutes ago",
    );
    expect(relativeFromNow(new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString(), NOW)).toBe(
      "2 hours ago",
    );
  });

  test("returns the input verbatim when not parseable", () => {
    expect(relativeFromNow("not-a-date", NOW)).toBe("not-a-date");
  });
});

describe("statusToBadgeVariant", () => {
  test.each([
    ["PENDING", "pending"],
    ["pending", "pending"],
    ["QUEUED", "pending"],
    ["awaiting_approval", "pending"],
    ["RUNNING", "running"],
    ["starting", "running"],
    ["SUCCEEDED", "succeeded"],
    ["completed", "succeeded"],
    ["DONE", "succeeded"],
    ["FAILED", "failed"],
    ["error", "failed"],
    ["CANCELLED", "cancelled"],
    ["canceled", "cancelled"],
    ["STOPPED", "cancelled"],
    ["unknown-state", "default"],
  ])('"%s" -> "%s"', (input, expected) => {
    expect(statusToBadgeVariant(input)).toBe(expected);
  });
});

describe("statusLabel", () => {
  test("makes budget approval status readable in both languages", () => {
    expect(statusLabel("awaiting_approval", "zh")).toBe("等待审批");
    expect(statusLabel("AWAITING_APPROVAL", "en")).toBe("Awaiting approval");
  });
  test("normalizes scheduler status aliases for Chinese readers", () => {
    for (const status of ["SUCCEEDED", "completed", "done"]) {
      expect(statusLabel(status, "zh-CN")).toBe("已完成");
    }
    expect(statusLabel("RUNNING", "zh")).toBe("运行中");
    expect(statusLabel("online", "zh")).toBe("在线");
    expect(statusLabel("vendor-state", "zh")).toBe("Vendor-state");
  });
  test("title-cases single words", () => {
    expect(statusLabel("running")).toBe("Running");
    expect(statusLabel("FAILED")).toBe("Failed");
  });

  test("preserves length", () => {
    expect(statusLabel("succeeded")).toHaveLength("succeeded".length);
  });
});
