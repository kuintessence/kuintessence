import { describe, expect, test } from "bun:test";
import {
  ageFromMs,
  asciiBar,
  formatAge,
  formatDuration,
  friendlyError,
  grepLines,
  jobElapsed,
  padCell,
  seenLabel,
  sparkline,
  statusColor,
  statusGlyph,
  summarizeStatuses,
  truncate,
} from "./format";

describe("statusGlyph / statusColor", () => {
  test("each status has a distinct glyph and colour", () => {
    expect(statusGlyph("running")).toBe("●");
    expect(statusGlyph("completed")).toBe("✓");
    expect(statusGlyph("failed")).toBe("✗");
    expect(statusGlyph("queued")).toBe("○");
    expect(statusGlyph("cancelled")).toBe("⊘");
    expect(statusGlyph("unknown")).toBe("?");

    expect(statusColor("running")).toBe("green");
    expect(statusColor("failed")).toBe("red");
    expect(statusColor("queued")).toBe("gray");
  });
});

describe("formatAge", () => {
  const now = Date.parse("2026-05-30T12:00:00Z");

  test("formats seconds/minutes/hours/days", () => {
    expect(formatAge("2026-05-30T11:59:30Z", now)).toBe("30s");
    expect(formatAge("2026-05-30T11:58:00Z", now)).toBe("2m");
    expect(formatAge("2026-05-30T09:00:00Z", now)).toBe("3h");
    expect(formatAge("2026-05-25T12:00:00Z", now)).toBe("5d");
  });

  test("missing or unparseable input yields a dash", () => {
    expect(formatAge(undefined, now)).toBe("—");
    expect(formatAge("not-a-date", now)).toBe("—");
  });

  test("future timestamps clamp to 0s", () => {
    expect(formatAge("2026-05-30T12:00:30Z", now)).toBe("0s");
  });

  test("ageFromMs formats an epoch-ms instant the same way", () => {
    const now = 1_000_000;
    expect(ageFromMs(now - 5_000, now)).toBe("5s");
    expect(ageFromMs(now - 120_000, now)).toBe("2m");
    expect(ageFromMs(now + 5_000, now)).toBe("0s");
  });
});

describe("formatDuration", () => {
  test("renders the most-significant two non-zero units", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(90)).toBe("1m30s");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(5400)).toBe("1h30m");
    expect(formatDuration(86400)).toBe("1d");
    expect(formatDuration(90000)).toBe("1d1h");
  });

  test("non-positive durations render as 0s", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("truncate / padCell", () => {
  test("truncate adds an ellipsis past the width", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello-world", 5)).toBe("hell…");
    expect(truncate("x", 1)).toBe("x");
    expect(truncate("xy", 1)).toBe("…");
    expect(truncate("xy", 0)).toBe("");
  });

  test("padCell fills to an exact width", () => {
    expect(padCell("ab", 5)).toBe("ab   ");
    expect(padCell("abcdef", 4)).toBe("abc…");
    expect(padCell("ab", 2)).toBe("ab");
  });
});

describe("asciiBar", () => {
  test("renders a proportional filled/empty meter", () => {
    expect(asciiBar(0, 100, 10)).toBe("░░░░░░░░░░");
    expect(asciiBar(50, 100, 10)).toBe("█████░░░░░");
    expect(asciiBar(100, 100, 10)).toBe("██████████");
  });

  test("clamps out-of-range and handles max<=0", () => {
    expect(asciiBar(150, 100, 10)).toBe("██████████");
    expect(asciiBar(-5, 100, 10)).toBe("░░░░░░░░░░");
    expect(asciiBar(5, 0, 10)).toBe("░░░░░░░░░░");
    expect(asciiBar(5, 100, 0)).toBe("");
  });
});

describe("summarizeStatuses", () => {
  test("totals and breaks down by status in a stable order", () => {
    expect(summarizeStatuses(["running", "running", "queued", "failed"])).toBe(
      "4 total · 2 running · 1 queued · 1 failed",
    );
  });

  test("preferred statuses lead; unknown ones follow alphabetically", () => {
    expect(summarizeStatuses(["weird", "completed", "running", "alpha"])).toBe(
      "4 total · 1 running · 1 completed · 1 alpha · 1 weird",
    );
  });

  test("an empty list reports only the total", () => {
    expect(summarizeStatuses([])).toBe("0 total");
  });
});

describe("grepLines", () => {
  test("keeps only lines containing the needle, case-insensitively", () => {
    expect(grepLines(["error here", "ok", "ERROR again"], "error")).toEqual([
      "error here",
      "ERROR again",
    ]);
  });

  test("an empty needle returns every line unchanged", () => {
    expect(grepLines(["a", "b"], "")).toEqual(["a", "b"]);
  });

  test("no match returns an empty list", () => {
    expect(grepLines(["a", "b"], "zzz")).toEqual([]);
  });
});

describe("jobElapsed", () => {
  test("uses completedAt when present (finished job)", () => {
    expect(jobElapsed("2023-11-14T22:13:20.000Z", "2023-11-14T23:13:20.000Z", 0)).toBe("1h");
  });

  test("falls back to now while still running", () => {
    const start = Date.parse("2023-11-14T22:13:20.000Z");
    expect(jobElapsed("2023-11-14T22:13:20.000Z", undefined, start + 300_000)).toBe("5m");
  });

  test("undefined when startedAt is missing or unparseable, or end precedes start", () => {
    expect(jobElapsed(undefined, undefined, 1000)).toBeUndefined();
    expect(jobElapsed("nope", undefined, 1000)).toBeUndefined();
    const start = Date.parse("2023-11-14T22:13:20.000Z");
    expect(jobElapsed("2023-11-14T22:13:20.000Z", undefined, start - 5000)).toBeUndefined();
  });
});

describe("seenLabel", () => {
  test("formats a heartbeat age, or '—' when absent/unparseable", () => {
    const now = 1_000_000;
    expect(seenLabel(undefined, now)).toBe("—");
    expect(seenLabel("nope", now)).toBe("—");
    expect(seenLabel(new Date(now - 300_000).toISOString(), now)).toBe("5m");
  });
});

describe("friendlyError", () => {
  test("maps a 401 to a re-login hint", () => {
    expect(friendlyError({ status: 401, message: "Unauthorized" })).toMatch(/kq login/);
  });

  test("maps a 403 to an access-denied hint", () => {
    expect(friendlyError({ status: 403, message: "Forbidden" })).toMatch(/denied|permission/i);
  });

  test("passes through ordinary error messages and strings", () => {
    expect(friendlyError(new Error("connect ECONNREFUSED"))).toBe("connect ECONNREFUSED");
    expect(friendlyError("boom")).toBe("boom");
    expect(friendlyError({ status: 500, message: "kaboom" })).toBe("kaboom");
  });
});

describe("sparkline", () => {
  test("maps values to 8 block levels by proportion of max", () => {
    expect(sparkline([0, 50, 100], 100)).toBe("▁▅█");
    expect(sparkline([0, 100], 100)).toBe("▁█");
  });

  test("clamps out-of-range and returns empty for no samples", () => {
    expect(sparkline([150], 100)).toBe("█");
    expect(sparkline([-10], 100)).toBe("▁");
    expect(sparkline([], 100)).toBe("");
  });
});
