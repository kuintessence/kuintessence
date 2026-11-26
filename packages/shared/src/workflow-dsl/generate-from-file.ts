import { parse } from "csv-parse/sync";
import type { GenRule } from "./generate";

export function generateFromFile(
  rule: Extract<GenRule, { kind: "FromFile" }>,
  text: string,
): unknown[] {
  let rows: unknown;
  switch (rule.format) {
    case "JSON":
      rows = JSON.parse(text);
      break;
    case "JSONL":
      rows = text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
      break;
    case "CSV":
      rows = parse(text, {
        bom: true,
        skip_empty_lines: true,
        columns: (headers: string[]) => {
          if (headers.some((h) => !h) || new Set(headers).size !== headers.length)
            throw new Error("CSV requires unique nonempty column names");
          return headers;
        },
      });
      break;
  }
  if (!Array.isArray(rows)) throw new Error("Generate file must contain an array of records");
  const fields = Object.entries(rule.mapping ?? {});
  if (rows.length * Math.max(1, fields.length) > 1_000_000)
    throw new Error("Generate file exceeds the one-million value limit");
  if (!fields.length) return rows;
  return rows.map((row) =>
    Object.fromEntries(
      fields.map(([target, source]) => {
        if (!row || typeof row !== "object" || !Object.hasOwn(row, source))
          throw new Error(`Generate file is missing field "${source}"`);
        return [target, row[source]];
      }),
    ),
  );
}
