import { createHash } from "node:crypto";
import type { Gateway, Identity, Signer } from "@hyperledger/fabric-gateway";
import { federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  FabricMarketTrustSchema,
  type MarketCancelOpenSchema,
  type MarketClaim,
  type MarketDemand,
  type MarketProposalInput,
  MarketProposalInputSchema,
  MarketReceiptSchema,
} from "@kuintessence/shared/federation/market";
import { z } from "zod";
import { FabricSubmission } from "./submission";

export const MarketAdapterConfigSchema = z.strictObject({
  siteId: z.uuid(),
  channel: z.string().regex(/^[a-z][a-z0-9.-]{0,248}$/),
  chaincode: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  trust: FabricMarketTrustSchema,
});
export type MarketAdapterConfig = z.infer<typeof MarketAdapterConfigSchema>;
export class FabricMarketAdapter {
  private readonly config: MarketAdapterConfig;
  private readonly submission: FabricSubmission;
  constructor(
    config: MarketAdapterConfig,
    private readonly gateway: Gateway,
    identity: Identity,
    signer: Signer,
    recoveryKey: Uint8Array,
  ) {
    this.config = MarketAdapterConfigSchema.parse(config);
    const organization = this.config.trust.organizations.find(
      (org) => org.siteId === this.config.siteId,
    );
    if (!organization || organization.mspId !== identity.mspId)
      throw new Error("INVALID_ADAPTER_CONFIG");
    this.submission = new FabricSubmission(
      this.config,
      { purpose: "kq-market-v1", config: this.config },
      gateway,
      identity,
      signer,
      recoveryKey,
      (value) => MarketReceiptSchema.parse(value),
    );
  }
  async prepare(raw: MarketProposalInput) {
    const input = MarketProposalInputSchema.parse(raw);
    let name: string, recordId: string;
    let value: MarketDemand | MarketClaim | z.infer<typeof MarketCancelOpenSchema>;
    if (input.operation === "publish-demand") {
      if (input.demand.sourceSiteId !== this.config.siteId) throw new Error("POLICY_DENIED");
      name = "PublishDemand";
      recordId = input.demand.demandId;
      value = input.demand;
    } else if (input.operation === "claim-demand") {
      if (input.claim.providerSiteId !== this.config.siteId) throw new Error("POLICY_DENIED");
      name = "ClaimDemand";
      recordId = input.claim.claimId;
      value = input.claim;
    } else {
      // Publisher authorization needs current committed state and remains enforced by chaincode.
      name = "CancelOpenDemand";
      recordId = input.cancellation.cancellationId;
      value = input.cancellation;
    }
    const bytes = federationCanonicalJson(value);
    const proposal = this.gateway
      .getNetwork(this.config.channel)
      .getContract(this.config.chaincode)
      .newProposal(name, {
        arguments: [value.demandId],
        transientData: { market: bytes },
        // All fields are public; Gateway discovers the channel's native majority endorsement policy.
      });
    return this.submission.prepare(proposal, {
      // Recovery's legacy domainId field binds the public market governance generation, not a wallet.
      domainId: this.config.trust.generationId,
      recordId,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
  }
  advance(recovery: string) {
    return this.submission.advance(recovery);
  }
}
