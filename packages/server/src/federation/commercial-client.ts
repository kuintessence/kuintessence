import {
  type CommercialAdvanceResult,
  type CommercialProposalInput,
  CommercialProposalInputSchema,
  FabricCommercialAdvanceResultSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  FabricProposalCheckpointSchema,
  FabricRecoveryTokenSchema,
} from "@kuintessence/shared/federation/ledger";
import type { z } from "zod";
import { UnixFabricClient } from "./fabric-client";

export interface CommercialClient {
  prepare(input: CommercialProposalInput): Promise<z.infer<typeof FabricProposalCheckpointSchema>>;
  advance(recovery: string): Promise<CommercialAdvanceResult>;
}
export class UnixCommercialClient implements CommercialClient {
  private readonly transport: UnixFabricClient;
  constructor(socketPath: string) {
    this.transport = new UnixFabricClient(socketPath);
  }
  async prepare(input: CommercialProposalInput) {
    return FabricProposalCheckpointSchema.parse(
      await this.transport.call(
        "/v1/commercial/proposal",
        CommercialProposalInputSchema.parse(input),
      ),
    );
  }
  async advance(recovery: string) {
    return FabricCommercialAdvanceResultSchema.parse(
      await this.transport.call("/v1/commercial/advance", {
        recovery: FabricRecoveryTokenSchema.parse(recovery),
      }),
    );
  }
}
