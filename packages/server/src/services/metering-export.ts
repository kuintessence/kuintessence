// CSV export of metering query results.

import type { QueryResult, QueryResultRow } from "./metering";

const CSV_HEADER = [
  "groupKey",
  "cpuCoreSeconds",
  "gpuSeconds",
  "memoryMbSeconds",
  "storageMbSeconds",
  "networkEgressMb",
  "jobCount",
];

function csvEscape(value: string | number): string {
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowToCsv(row: QueryResultRow): string {
  return [
    row.groupKey,
    row.cpuCoreSeconds,
    row.gpuSeconds,
    row.memoryMbSeconds,
    row.storageMbSeconds,
    row.networkEgressMb,
    row.jobCount,
  ]
    .map(csvEscape)
    .join(",");
}

export function exportCsv(result: QueryResult): string {
  const lines = [CSV_HEADER.join(","), ...result.rows.map(rowToCsv)];
  return `${lines.join("\n")}\n`;
}

export function suggestedFilename(format: "csv" | "parquet", from: Date, to: Date): string {
  const ts = `${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`;
  return `metering-${ts}.${format}`;
}
