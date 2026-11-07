import { z } from "zod";
import { CommercialTerminalSchema } from "./commercial";
import { FederationExecutionTerminalEvidenceSchema } from "./terminal-evidence";

export const FederationTerminalProposalSchema = z.strictObject({
  payload: CommercialTerminalSchema,
  evidence: FederationExecutionTerminalEvidenceSchema,
  providerJws: z.string().min(1).max(524288),
});
export type FederationTerminalProposal = z.infer<typeof FederationTerminalProposalSchema>;
