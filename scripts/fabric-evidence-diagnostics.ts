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
const AdapterCode = z.enum([
  "POLICY_DENIED",
  "UNTRUSTED_IDENTITY",
  "OPERATION_CONFLICT",
  "INVALID_MESSAGE",
  "INVALID_RECOVERY",
  "INVALID_LEDGER_RESPONSE",
  "AUTHORIZATION_EXPIRED",
  "BUDGET_EXHAUSTED",
  "AGREEMENT_UNAVAILABLE",
  "ASSET_UNAVAILABLE",
  "LEDGER_REQUIRED",
  "DATA_WAITING",
  "LEDGER_UNAVAILABLE",
  "ADAPTER_BUSY",
  "UNSAFE_ADAPTER_SOCKET",
  "INVALID_ADAPTER_RESPONSE",
]);
export const FabricEvidenceProbeFailureSchema = z.strictObject({
  error: ErrorName,
  code: z.number().int().min(0).max(16).nullable(),
  adapterCode: AdapterCode.optional(),
});

/** Only fixed categories and gRPC status codes may leave the private probe directory. */
export function fabricEvidenceProbeFailure(error: unknown) {
  const candidate = z
    .object({ name: z.unknown(), code: z.unknown().optional(), message: z.unknown().optional() })
    .safeParse(error);
  const name = ErrorName.safeParse(candidate.success ? candidate.data.name : undefined);
  const code = FabricEvidenceProbeFailureSchema.shape.code.safeParse(
    candidate.success ? candidate.data.code : undefined,
  );
  const adapter = AdapterCode.safeParse(
    candidate.success ? (candidate.data.code ?? candidate.data.message) : undefined,
  );
  return {
    error: name.success ? name.data : "Error",
    code: code.success ? code.data : null,
    ...(adapter.success ? { adapterCode: adapter.data } : {}),
  };
}
