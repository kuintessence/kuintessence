import { describe, expect, test } from "bun:test";
import { formatLocalStatus } from "./status";

describe("formatLocalStatus", () => {
  test("renders the scheduler status with the fields that are present", () => {
    const out = formatLocalStatus("12345", {
      status: "running",
      node: "node[01-04]",
      startedAt: "2026-05-30T11:00:00Z",
      reason: "None",
    });
    expect(out).toContain("Job 12345");
    expect(out).toContain("Status: running");
    expect(out).toContain("Node: node[01-04]");
    expect(out).toContain("Started: 2026-05-30T11:00:00Z");
    expect(out).toContain("Reason: None");
  });

  test("omits absent fields and shows an exit code + message on failure", () => {
    const out = formatLocalStatus("99", { status: "failed", exitCode: 137, message: "OOMKilled" });
    expect(out).toContain("Job 99");
    expect(out).toContain("Status: failed");
    expect(out).toContain("Exit code: 137");
    expect(out).toContain("OOMKilled");
    expect(out).not.toContain("Node:");
    expect(out).not.toContain("Started:");
  });
});
