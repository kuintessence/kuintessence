import { z } from "zod";
import { spackCompatibility } from "./spack-lock";
import { SpackMaterialDigestSchema } from "./spack-materials";

export const SpackSourceAuditReportSchema = z
  .strictObject({
    version: z.literal(1),
    validation: z.literal("isolated-source-audit"),
    manifestDigest: SpackMaterialDigestSchema,
    spackVersion: z.string().refine((value) => spackCompatibility(value) !== undefined),
    rootHash: z.string().regex(/^[a-z2-7]{32}$/),
    nodeCount: z.number().int().min(1).max(10_000),
    externalCount: z.number().int().min(0).max(10_000),
    verifiedNodeCount: z.number().int().min(0).max(10_000),
    passed: z.boolean(),
    issues: z
      .array(
        z.strictObject({
          severity: z.enum(["error", "warning"]),
          code: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z-]+$/),
          hash: z
            .string()
            .regex(/^[a-z2-7]{32}$/)
            .optional(),
        }),
      )
      .max(100),
  })
  .superRefine((value, ctx) => {
    const errors = value.issues.some((issue) => issue.severity === "error");
    if (
      value.externalCount > value.nodeCount ||
      value.verifiedNodeCount > value.nodeCount - value.externalCount ||
      (value.passed &&
        (errors || value.verifiedNodeCount !== value.nodeCount - value.externalCount)) ||
      (!value.passed && !errors)
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent Spack source audit result" });
  });

export type SpackSourceAuditReport = z.infer<typeof SpackSourceAuditReportSchema>;
export const SPACK_AUDIT_RESULT_PREFIX = "KQ_SPACK_AUDIT_RESULT:";

export const SpackAuditContextSchema = z.strictObject({
  siteProfileDigest: SpackMaterialDigestSchema,
  runtimeDigest: SpackMaterialDigestSchema,
});
export type SpackAuditContext = z.infer<typeof SpackAuditContextSchema>;
export const SpackSourceAuditEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.string().uuid(),
  spec: z.string().min(1).max(500),
  nativeLockDigest: SpackMaterialDigestSchema,
  context: SpackAuditContextSchema,
  report: SpackSourceAuditReportSchema,
});
export type SpackSourceAuditEnvelope = z.infer<typeof SpackSourceAuditEnvelopeSchema>;
export const SPACK_SOURCE_PROOF_PREFIX = "KQ_SPACK_SOURCE_PROOF:";
