import {
  FabricProposalCheckpointSchema,
  FabricRecoveryTokenSchema,
} from "@kuintessence/shared/federation/ledger";
import {
  FabricMarketAdvanceResultSchema,
  type MarketAdvanceResult,
  type MarketProposalInput,
  MarketProposalInputSchema,
} from "@kuintessence/shared/federation/market";
import type { z } from "zod";
import { UnixFabricClient } from "./fabric-client";

export interface MarketClient {
  prepare(input: MarketProposalInput): Promise<z.infer<typeof FabricProposalCheckpointSchema>>;
  advance(recovery: string): Promise<MarketAdvanceResult>;
}
export class UnixMarketClient implements MarketClient {
  private readonly transport: UnixFabricClient;
  constructor(socketPath: string) {
    this.transport = new UnixFabricClient(socketPath);
  }
  async prepare(input: MarketProposalInput) {
    return FabricProposalCheckpointSchema.parse(
      await this.transport.call("/v1/market/proposal", MarketProposalInputSchema.parse(input)),
    );
  }
  async advance(recovery: string) {
    return FabricMarketAdvanceResultSchema.parse(
      await this.transport.call("/v1/market/advance", {
        recovery: FabricRecoveryTokenSchema.parse(recovery),
      }),
    );
  }
}
