import { expect, test } from "bun:test";
import { generateFromFile } from "./generate-from-file";

test("CSV quoted values, JSON arrays and JSONL produce the same mapped records", () => {
  const input = {
    kind: "FromFile" as const,
    source: "upload" as const,
    mapping: { name: "column" },
  };
  for (const [format, text] of [
    ["CSV", 'column,z\r\n"a,b",0\r\n'],
    ["JSON", '[{"column":"a,b"}]'],
    ["JSONL", '{"column":"a,b"}\n'],
  ] as const)
    expect(generateFromFile({ ...input, format }, text)).toEqual([{ name: "a,b" }]);
  expect(() => generateFromFile({ ...input, format: "CSV" }, "column,column\nx,y")).toThrow();
  expect(() => generateFromFile({ ...input, format: "JSONL" }, '{"other":1}')).toThrow();
});
