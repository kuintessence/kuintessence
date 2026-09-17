import { describe, expect, test } from "vitest";
import {
  activeJobCount,
  activeWorkflowCount,
  bucketHourly,
  isPlatformBootstrap,
  type JobRow,
  onlineAgentCount,
} from "./dashboard-data";

describe("activeJobCount", () => {
  test("returns 0 for undefined / empty input", () => {
    expect(activeJobCount(undefined)).toBe(0);
    expect(activeJobCount([])).toBe(0);
  });

  test("counts non-terminal statuses (case-insensitive)", () => {
    const jobs: JobRow[] = [
      { id: "a", name: "a", status: "pending", submittedAt: "" },
      { id: "b", name: "b", status: "RUNNING", submittedAt: "" },
      { id: "c", name: "c", status: "Succeeded", submittedAt: "" },
      { id: "d", name: "d", status: "FAILED", submittedAt: "" },
      { id: "e", name: "e", status: "CANCELLED", submittedAt: "" },
      { id: "f", name: "f", status: "completed", submittedAt: "" },
    ];
    expect(activeJobCount(jobs)).toBe(2);
  });
});

describe("activeWorkflowCount", () => {
  test("counts non-terminal runs", () => {
    expect(
      activeWorkflowCount([
        { id: "1", name: "x", status: "RUNNING", createdAt: "" },
        { id: "2", name: "y", status: "SUCCEEDED", createdAt: "" },
        { id: "3", name: "z", status: "PENDING", createdAt: "" },
        { id: "4", name: "done", status: "completed", createdAt: "" },
      ]),
    ).toBe(2);
  });

  test("undefined returns 0", () => {
    expect(activeWorkflowCount(undefined)).toBe(0);
  });
});

describe("onlineAgentCount", () => {
  test("counts only ONLINE (case-insensitive)", () => {
    expect(
      onlineAgentCount([
        {
          agentId: "a",
          siteName: "A",
          schedulerType: "slurm",
          schedulerVersion: "23",
          status: "online",
        },
        {
          agentId: "b",
          siteName: "B",
          schedulerType: "k8s",
          schedulerVersion: "1.30",
          status: "OFFLINE",
        },
        {
          agentId: "c",
          siteName: "C",
          schedulerType: "slurm",
          schedulerVersion: "23",
          status: "Online",
        },
      ]),
    ).toBe(2);
  });
  test("undefined returns 0", () => {
    expect(onlineAgentCount(undefined)).toBe(0);
  });
});

describe("isPlatformBootstrap", () => {
  test("true when both are empty / undefined", () => {
    expect(isPlatformBootstrap(undefined, undefined)).toBe(true);
    expect(isPlatformBootstrap([], [])).toBe(true);
  });
  test("false when either has items", () => {
    expect(
      isPlatformBootstrap([{ id: "a", name: "a", status: "PENDING", submittedAt: "" }], []),
    ).toBe(false);
    expect(
      isPlatformBootstrap([], [{ id: "a", name: "a", status: "RUNNING", createdAt: "" }]),
    ).toBe(false);
  });
});

describe("bucketHourly", () => {
  const NOW = new Date("2026-04-27T12:30:00Z");

  test("returns exactly 24 buckets anchored on the hour", () => {
    const buckets = bucketHourly([], NOW);
    expect(buckets).toHaveLength(24);
    // Last bucket is the hour we're in.
    const last = buckets[23];
    expect(last).toBeDefined();
    if (!last) return;
    expect(new Date(last.hour).getMinutes()).toBe(0);
    // First bucket is 23 hours before the anchor.
    const first = buckets[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(new Date(last.hour).getTime() - new Date(first.hour).getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
  });

  test("counts a job into the right bucket", () => {
    const job: JobRow = {
      id: "1",
      name: "x",
      status: "PENDING",
      submittedAt: "2026-04-27T11:45:00Z", // one hour ago — bucket 22
    };
    const buckets = bucketHourly([job], NOW);
    expect(buckets[22]?.count).toBe(1);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  test("ignores jobs older than the 24h window", () => {
    const ancient: JobRow = {
      id: "old",
      name: "old",
      status: "SUCCEEDED",
      submittedAt: "2026-04-26T08:00:00Z", // > 24h ago
    };
    const buckets = bucketHourly([ancient], NOW);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(0);
  });

  test("ignores unparseable timestamps", () => {
    const garbage: JobRow = { id: "x", name: "x", status: "PENDING", submittedAt: "not-a-date" };
    const buckets = bucketHourly([garbage], NOW);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(0);
  });

  test("undefined input still returns 24 zeroed buckets", () => {
    const buckets = bucketHourly(undefined, NOW);
    expect(buckets).toHaveLength(24);
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });
});
