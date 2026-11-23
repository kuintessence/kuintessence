import {
  ByteWriter,
  type ColumnSource,
  ParquetWriter,
  schemaFromColumnData,
} from "hyparquet-writer";

import type { QueryResult, QueryResultRow } from "./metering";

const COLUMNS = [
  "groupKey",
  "cpuCoreSeconds",
  "gpuSeconds",
  "memoryMbSeconds",
  "storageMbSeconds",
  "networkEgressMb",
  "jobCount",
] as const;

function csvEscape(value: string | number): string {
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowToCsv(row: QueryResultRow): string {
  return COLUMNS.map((key) => csvEscape(row[key])).join(",");
}

function columns(rows: QueryResultRow[]): ColumnSource[] {
  return COLUMNS.map((name) => ({
    name,
    type: name === "groupKey" ? "STRING" : "DOUBLE",
    data: rows.map((row) => row[name]),
  }));
}

export async function* exportChunks(
  format: "csv" | "json" | "parquet",
  pages: AsyncIterable<QueryResult>,
) {
  const encode = new TextEncoder();
  if (format === "parquet") {
    const buffer = new ByteWriter();
    const writer = new ParquetWriter({
      writer: buffer,
      schema: schemaFromColumnData({ columnData: columns([]) }),
    });
    for await (const { rows } of pages) {
      if (!rows.length) continue;
      await writer.write({ columnData: columns(rows) });
      yield buffer.getBytes().slice();
      buffer.index = 0;
    }
    await writer.finish();
    yield buffer.getBytes().slice();
    return;
  }
  let first = true;
  let total = 0;
  yield encode.encode(format === "csv" ? `${COLUMNS.join(",")}\n` : '{"rows":[');
  for await (const page of pages) {
    total = page.total;
    if (!page.rows.length) continue;
    yield encode.encode(
      format === "csv"
        ? `${page.rows.map(rowToCsv).join("\n")}\n`
        : (first ? "" : ",") + page.rows.map((row) => JSON.stringify(row)).join(","),
    );
    first = false;
  }
  if (format === "json") yield encode.encode(`],"total":${total}}`);
}

export function suggestedFilename(format: "csv" | "parquet", from: Date, to: Date): string {
  const ts = `${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`;
  return `metering-${ts}.${format}`;
}
