import {
  FabricProposalCheckpointSchema,
  FabricRecoveryTokenSchema,
} from "@kuintessence/shared/federation/ledger";
import {
  FabricMarketAdvanceResultSchema,
  type MarketAdapterProposalInput,
  MarketAdapterProposalInputSchema,
  type MarketAdvanceResult,
  type MarketQueryInput,
  MarketQueryInputSchema,
  type MarketQueryResult,
  MarketQueryResultSchema,
} from "@kuintessence/shared/federation/market";
import type { z } from "zod";
import { UnixFabricClient } from "./fabric-client";

export interface MarketClient {
  query(input: MarketQueryInput): Promise<MarketQueryResult>;
  prepare(
    input: MarketAdapterProposalInput,
  ): Promise<z.infer<typeof FabricProposalCheckpointSchema>>;
  advance(recovery: string): Promise<MarketAdvanceResult>;
}
export class UnixMarketClient implements MarketClient {
  private readonly transport: UnixFabricClient;
  constructor(socketPath: string) {
    this.transport = new UnixFabricClient(socketPath);
  }
  async query(input: MarketQueryInput) {
    return MarketQueryResultSchema.parse(
      await this.transport.call("/v1/market/query", MarketQueryInputSchema.parse(input)),
    );
  }
  async prepare(input: MarketAdapterProposalInput) {
    return FabricProposalCheckpointSchema.parse(
      await this.transport.call(
        "/v1/market/proposal",
        MarketAdapterProposalInputSchema.parse(input),
      ),
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
