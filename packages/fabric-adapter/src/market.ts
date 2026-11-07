import { createHash } from "node:crypto";
import {
  type Gateway,
  GatewayError,
  type Identity,
  type Signer,
} from "@hyperledger/fabric-gateway";
import { federationCanonicalJson } from "@kuintessence/shared/federation";
import {
  FabricMarketTrustSchema,
  type MarketActivationSchema,
  type MarketAdapterProposalInput,
  MarketAdapterProposalInputSchema,
  type MarketCancelOpenSchema,
  type MarketClaim,
  type MarketDemand,
  MarketDemandStateSchema,
  type MarketExecutionAuthorization,
  MarketPageSchema,
  type MarketQueryInput,
  MarketQueryInputSchema,
  type MarketQueryResult,
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
  async prepare(raw: MarketAdapterProposalInput) {
    const input = MarketAdapterProposalInputSchema.parse(raw);
    let name: string, recordId: string;
    let value:
      | MarketDemand
      | MarketClaim
      | z.infer<typeof MarketCancelOpenSchema>
      | z.infer<typeof MarketActivationSchema>
      | MarketExecutionAuthorization;
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
    } else if (input.operation === "activate-demand") {
      name = "ActivateDemand";
      recordId = input.activation.activationId;
      value = input.activation;
    } else if (input.operation === "authorize-execution") {
      if (input.authorization.issuerSiteId !== this.config.siteId) throw new Error("POLICY_DENIED");
      name = "AuthorizeExecution";
      recordId = input.authorization.authorizationId;
      value = input.authorization;
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
  async query(raw: MarketQueryInput): Promise<MarketQueryResult> {
    const input = MarketQueryInputSchema.parse(raw);
    const contract = this.gateway
      .getNetwork(this.config.channel)
      .getContract(this.config.chaincode);
    const name = input.operation === "get-demand" ? "GetDemand" : "ListDemands";
    let bytes: Uint8Array;
    try {
      bytes = await contract
        .newProposal(name, {
          arguments:
            input.operation === "get-demand"
              ? [input.demandId]
              : [String(input.limit), input.bookmark],
        })
        .evaluate({ deadline: Date.now() + 10000 });
    } catch (error) {
      if (
        input.operation === "get-demand" &&
        error instanceof GatewayError &&
        error.details.length > 0 &&
        error.details.every(
          (detail) => detail.message === "chaincode response 500, ASSET_UNAVAILABLE",
        )
      )
        return { operation: "get-demand", demand: null };
      throw error;
    }
    try {
      if (bytes.length > 2_097_152) throw new Error("Oversized result");
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const result: MarketQueryResult =
        input.operation === "get-demand"
          ? { operation: "get-demand", demand: MarketDemandStateSchema.parse(value) }
          : { operation: "list-demands", ...MarketPageSchema.parse(value) };
      const demands =
        result.operation === "get-demand" ? (result.demand ? [result.demand] : []) : result.demands;
      if (input.operation === "list-demands" && demands.length > input.limit)
        throw new Error("Invalid page");
      if (new Set(demands.map((row) => row.demand.demandId)).size !== demands.length)
        throw new Error("Duplicate demand");
      for (const row of demands) {
        if (input.operation === "get-demand" && row.demand.demandId !== input.demandId)
          throw new Error("Wrong demand");
        if (
          row.digest !==
          `sha256:${createHash("sha256").update(federationCanonicalJson(row.demand)).digest("hex")}`
        )
          throw new Error("Wrong digest");
      }
      return result;
    } catch {
      throw new Error("INVALID_LEDGER_RESPONSE");
    }
  }
  advance(recovery: string) {
    return this.submission.advance(recovery);
  }
}
