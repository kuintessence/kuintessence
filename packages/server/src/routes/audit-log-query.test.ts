import { expect, test } from "bun:test";
import { AuditLogQuerySchema, auditSearchPattern } from "./audit-log-query";

test("audit pagination rejects invalid limits, offsets, dates and reversed ranges", () => {
  for (const value of [
    { limit: "NaN" },
    { offset: "-1" },
    { limit: "0" },
    { limit: "1001" },
    { from: "yesterday" },
    { from: "2026-11-18T00:00:00Z", to: "2026-11-17T00:00:00Z" },
  ]) {
    expect(AuditLogQuerySchema.safeParse(value).success).toBe(false);
  }
  expect(
    AuditLogQuerySchema.parse({ search: " job.submit ", offset: "25", limit: "25" }),
  ).toMatchObject({ search: "job.submit", offset: 25, limit: 25 });
  expect(AuditLogQuerySchema.parse({})).toMatchObject({ limit: 100, offset: 0 });
});

test("audit keyword search treats SQL pattern characters literally", () => {
  expect(auditSearchPattern("job_100%\\run")).toBe("%job\\_100\\%\\\\run%");
});
