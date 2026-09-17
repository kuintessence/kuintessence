import { describe, expect, test } from "vitest";
import { relativeFromNow, statusLabel, statusToBadgeVariant } from "./format";

const NOW = new Date("2026-04-27T12:00:00Z");

describe("relativeFromNow", () => {
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
  test("title-cases single words", () => {
    expect(statusLabel("running")).toBe("Running");
    expect(statusLabel("FAILED")).toBe("Failed");
  });

  test("preserves length", () => {
    expect(statusLabel("succeeded")).toHaveLength("succeeded".length);
  });
});
