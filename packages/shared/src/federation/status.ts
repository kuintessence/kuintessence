import { z } from "zod";
import { FederationError } from "./index";
import { FederationDigestSchema } from "./references";

const Identity = {
  protocolVersion: z.literal(1),
  queryId: z.uuid(),
  senderSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  operationId: z.uuid(),
  agreementRevisionId: z.uuid(),
  taskId: z.uuid(),
  attempt: z.number().int().min(1).max(2_147_483_647),
  reservationId: z.uuid(),
  requestDigest: FederationDigestSchema,
};

export const FederationStatusQuerySchema = z
  .strictObject({
    ...Identity,
    kind: z.literal("status-query"),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine((q) => {
    const lifetime = Date.parse(q.expiresAt) - Date.parse(q.issuedAt);
    return lifetime > 0 && lifetime <= 60_000 && q.senderSiteId !== q.recipientSiteId;
  }, "Status queries require distinct sites and a lifetime of at most one minute");
export type FederationStatusQuery = z.infer<typeof FederationStatusQuerySchema>;

/** Operational metadata only: no local identities, paths, raw errors, logs or result contents. */
export const FederationStatusReportSchema = z.strictObject({
  ...Identity,
  kind: z.literal("status-report"),
  queryDigest: FederationDigestSchema,
  observedAt: z.iso.datetime(),
  preparation: z
    .strictObject({
      state: z.enum(["waiting", "blocked", "resolved"]),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  workflow: z
    .strictObject({
      status: z.enum([
        "submitted",
        "queued",
        "awaiting_approval",
        "running",
        "cancelling",
        "completed",
        "failed",
        "cancelled",
      ]),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
});
export type FederationStatusReport = z.infer<typeof FederationStatusReportSchema>;

export function assertFederationStatusQueryFresh(query: FederationStatusQuery, now: Date) {
  if (
    !Number.isFinite(now.getTime()) ||
    Date.parse(query.issuedAt) > now.getTime() + 60_000 ||
    Date.parse(query.expiresAt) <= now.getTime()
  )
    throw new FederationError("AUTHORIZATION_EXPIRED");
}

export function assertFederationStatusReport(
  query: FederationStatusQuery,
  queryDigest: string,
  report: FederationStatusReport,
  now: Date,
) {
  assertFederationStatusQueryFresh(query, now);
  if (
    report.queryDigest !== queryDigest ||
    report.senderSiteId !== query.recipientSiteId ||
    report.recipientSiteId !== query.senderSiteId ||
    (
      [
        "queryId",
        "operationId",
        "agreementRevisionId",
        "taskId",
        "attempt",
        "reservationId",
        "requestDigest",
      ] as const
    ).some((field) => report[field] !== query[field]) ||
    Date.parse(report.observedAt) < Date.parse(query.issuedAt) - 60_000 ||
    Date.parse(report.observedAt) > now.getTime() + 60_000
  )
    throw new FederationError("INVALID_MESSAGE");
}
