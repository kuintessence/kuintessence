import {
  type CaseProposal,
  CaseProposalSchema,
  CaseReceiptQuerySchema,
  CaseReceiptResultSchema,
} from "@kuintessence/shared/federation/case-ledger";
import {
  type CommercialAdvanceResult,
  FabricCommercialAdvanceResultSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  FabricProposalCheckpointSchema,
  FabricRecoveryTokenSchema,
} from "@kuintessence/shared/federation/ledger";
import type { z } from "zod";
import { UnixFabricClient } from "./fabric-client";

export interface CaseClient {
  prepare(input: CaseProposal): Promise<z.infer<typeof FabricProposalCheckpointSchema>>;
  advance(recovery: string): Promise<CommercialAdvanceResult>;
  receipt(
    input: z.infer<typeof CaseReceiptQuerySchema>,
  ): Promise<z.infer<typeof CaseReceiptResultSchema>>;
}
export class UnixCaseClient implements CaseClient {
  private readonly transport: UnixFabricClient;
  constructor(socketPath: string) {
    this.transport = new UnixFabricClient(socketPath);
  }
  async prepare(input: CaseProposal) {
    return FabricProposalCheckpointSchema.parse(
      await this.transport.call("/v1/case/proposal", CaseProposalSchema.parse(input)),
    );
  }
  async advance(recovery: string) {
    return FabricCommercialAdvanceResultSchema.parse(
      await this.transport.call("/v1/case/advance", {
        recovery: FabricRecoveryTokenSchema.parse(recovery),
      }),
    );
  }
  async receipt(input: z.infer<typeof CaseReceiptQuerySchema>) {
    return CaseReceiptResultSchema.parse(
      await this.transport.call("/v1/case/query", CaseReceiptQuerySchema.parse(input)),
    );
  }
}
