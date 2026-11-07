import { z } from "zod";
import { CommercialUsageCorrectionEvidenceSchema, CommercialUsageSchema } from "./commercial";
import { FederationDigestSchema } from "./references";
import {
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
  hasFederationQueryWindow,
} from "./status";

export const CommercialUsageQuerySchema = z
  .strictObject({
    ...FederationStatusQuerySchema.shape,
    kind: z.literal("commercial-usage-query"),
    agreementDigest: FederationDigestSchema,
    afterNumber: z.number().int().min(0).max(2147483647),
    afterReportId: z.uuid().nullable(),
  })
  .refine(hasFederationQueryWindow, "Invalid query window")
  .refine(
    (value) => (value.afterNumber === 0) === (value.afterReportId === null),
    "Invalid usage cursor",
  );
export type CommercialUsageQuery = z.infer<typeof CommercialUsageQuerySchema>;

/** A fresh, bounded page of historical provider assertions, with no local Job IDs or evidence manifests. */
export const CommercialUsagePageSchema = z.strictObject({
  ...FederationStatusReportSchema.omit({ kind: true, preparation: true, workflow: true }).shape,
  kind: z.literal("commercial-usage-page"),
  agreementDigest: FederationDigestSchema,
  afterNumber: z.number().int().min(0).max(2147483647),
  reportingState: z.enum(["waiting", "pending", "missing_data", "needs_review", "reported"]),
  latestNumber: z.number().int().min(0).max(2147483647),
  item: z
    .strictObject({
      number: z.number().int().min(1).max(2147483647),
      report: CommercialUsageSchema,
      reportJws: z.string().min(1).max(131072),
      correctionEvidence: CommercialUsageCorrectionEvidenceSchema.nullable(),
    })
    .nullable(),
});
export type CommercialUsagePage = z.infer<typeof CommercialUsagePageSchema>;
