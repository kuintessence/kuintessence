import { createHash } from "node:crypto";
import { toBinary } from "@bufbuild/protobuf";
import {
  type DispatchJob,
  DispatchJobSchema,
  dispatchIntent,
  renewableDispatchInputs,
} from "@kuintessence/proto";
import { z } from "zod";

export const FederationDispatchReceiptSchema = z.object({
  version: z.literal(1),
  epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  renewableInputs: z.array(z.number().int().nonnegative()),
  renewableSandboxSignature: z.boolean().optional(),
});

function digest(dispatch: DispatchJob, renewableInputs: number[], renewSandbox: boolean): string {
  const intent = dispatchIntent(dispatch, renewableInputs, renewSandbox);
  intent.envVars = Object.fromEntries(
    Object.entries(intent.envVars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256").update(toBinary(DispatchJobSchema, intent)).digest("hex");
}

/** Store an immutable fingerprint, not downloads, environment secrets or a reusable grant. */
export function federationDispatchReceipt(dispatch: DispatchJob) {
  const renewableInputs = renewableDispatchInputs(dispatch);
  const renewableSandboxSignature =
    dispatch.federationExecution && !!dispatch.sandboxExecution?.envelope;
  return {
    version: 1 as const,
    epoch: Number(dispatch.dispatchEpoch),
    digest: digest(dispatch, renewableInputs, renewableSandboxSignature),
    renewableInputs,
    renewableSandboxSignature,
  };
}

export function matchesFederationReceipt(
  dispatch: DispatchJob,
  receipt: z.infer<typeof FederationDispatchReceiptSchema>,
): boolean {
  return (
    dispatch.dispatchEpoch === BigInt(receipt.epoch) &&
    digest(dispatch, receipt.renewableInputs, receipt.renewableSandboxSignature === true) ===
      receipt.digest
  );
}

/** The scheduler also stores the full Job UUID; this short name separates dispatch epochs. */
export function federationSchedulerName(epoch: bigint): string {
  if (epoch < 0n || epoch > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid federation dispatch epoch");
  return `kf${epoch.toString(36)}`;
}
