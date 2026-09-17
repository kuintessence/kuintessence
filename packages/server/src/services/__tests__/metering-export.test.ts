import { describe, expect, it } from "bun:test";
import type { QueryResult } from "../metering";
import { exportCsv, rowToCsv, suggestedFilename } from "../metering-export";

const baseResult: QueryResult = {
  total: 2,
  rows: [
    {
      groupKey: "user-1",
      cpuCoreSeconds: 100,
      gpuSeconds: 0,
      memoryMbSeconds: 1000,
      storageMbSeconds: 0,
      networkEgressMb: 0,
      jobCount: 1,
    },
    {
      groupKey: 'user "tricky", with comma',
      cpuCoreSeconds: 200,
      gpuSeconds: 50,
      memoryMbSeconds: 2000,
      storageMbSeconds: 0,
      networkEgressMb: 1.5,
      jobCount: 2,
    },
  ],
};

describe("exportCsv", () => {
  it("emits a header row plus data rows", () => {
    const csv = exportCsv(baseResult);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "groupKey,cpuCoreSeconds,gpuSeconds,memoryMbSeconds,storageMbSeconds,networkEgressMb,jobCount",
    );
    expect(lines.length).toBe(3);
  });

  it("escapes commas and quotes per RFC 4180", () => {
    const row = baseResult.rows[1];
    if (!row) throw new Error("missing fixture row");
    const line = rowToCsv(row);
    expect(line).toContain('"user ""tricky"", with comma"');
  });

  it("renders numeric fields without quoting", () => {
    const row = baseResult.rows[0];
    if (!row) throw new Error("missing fixture row");
    const line = rowToCsv(row);
    expect(line).toBe("user-1,100,0,1000,0,0,1");
  });
});

describe("suggestedFilename", () => {
  it("encodes from/to dates in ISO yyyy-mm-dd form", () => {
    const f = suggestedFilename(
      "csv",
      new Date("2026-04-01T00:00:00Z"),
      new Date("2026-04-30T23:59:59Z"),
    );
    expect(f).toBe("metering-2026-04-01_2026-04-30.csv");
  });
});
