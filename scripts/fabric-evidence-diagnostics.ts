import { z } from "zod";

const ErrorName = z.enum([
  "Error",
  "EndorseError",
  "SubmitError",
  "CommitStatusError",
  "CommitError",
  "GatewayError",
  "ZodError",
  "AssertionError",
  "AttestationFailure",
]);
export const FabricEvidenceProbeFailureSchema = z.strictObject({
  error: ErrorName,
  code: z.number().int().min(0).max(16).nullable(),
});

/** Only fixed categories and gRPC status codes may leave the private probe directory. */
export function fabricEvidenceProbeFailure(error: unknown) {
  const candidate = z.object({ name: z.unknown(), code: z.unknown().optional() }).safeParse(error);
  const name = ErrorName.safeParse(candidate.success ? candidate.data.name : undefined);
  const code = FabricEvidenceProbeFailureSchema.shape.code.safeParse(
    candidate.success ? candidate.data.code : undefined,
  );
  return { error: name.success ? name.data : "Error", code: code.success ? code.data : null };
}
