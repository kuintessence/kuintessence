import { describe, expect, test } from "bun:test";
import { formatJobRows } from "./list";

describe("formatJobRows", () => {
  test("renders a header + one tab-separated row per job", () => {
    const out = formatJobRows([
      { id: "12345", name: "wrf", status: "running", submittedAt: "2026-05-30T10:00:00" },
      { id: "12346", name: "mesh", status: "queued" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("ID\tNAME\tSTATUS\tSUBMITTED");
    expect(lines[1]).toBe("12345\twrf\trunning\t2026-05-30T10:00:00");
    // a missing submit time renders as a dash, not "undefined"
    expect(lines[2]).toBe("12346\tmesh\tqueued\t—");
  });

  test("reports an empty list distinctly", () => {
    expect(formatJobRows([])).toBe("No jobs found.");
  });
});
