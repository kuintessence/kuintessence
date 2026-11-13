import {
  type EvidenceAdvanceResult,
  type EvidenceProposalInput,
  EvidenceProposalInputSchema,
  FabricEvidenceAdvanceResultSchema,
  FabricProposalCheckpointSchema,
  FabricRecoveryTokenSchema,
} from "@kuintessence/shared/federation/ledger";
import { UnixFabricClient } from "./fabric-client";

export { FabricClientFailure as AttestationFailure } from "./fabric-client";

import type { z } from "zod";

export interface AttestationClient {
  prepare(input: EvidenceProposalInput): Promise<z.infer<typeof FabricProposalCheckpointSchema>>;
  advance(recovery: string): Promise<EvidenceAdvanceResult>;
}
/** The Server never imports Fabric SDK or probes a ledger during direct-mode admission. */
export class UnixAttestationClient implements AttestationClient {
  private readonly transport: UnixFabricClient;
  constructor(socketPath: string) {
    this.transport = new UnixFabricClient(socketPath);
  }
  async prepare(input: EvidenceProposalInput) {
    return FabricProposalCheckpointSchema.parse(
      await this.transport.call("/v1/evidence/proposal", EvidenceProposalInputSchema.parse(input)),
    );
  }
  async advance(recovery: string) {
    return FabricEvidenceAdvanceResultSchema.parse(
      await this.transport.call("/v1/evidence/advance", {
        recovery: FabricRecoveryTokenSchema.parse(recovery),
      }),
    );
  }
}
