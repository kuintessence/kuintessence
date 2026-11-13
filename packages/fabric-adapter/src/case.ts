import type { Gateway, Identity, Signer } from "@hyperledger/fabric-gateway";
import {
  type CaseProposal,
  CaseProposalSchema,
  CaseReceiptQuerySchema,
  CaseReceiptResultSchema,
  CaseReceiptSchema,
  caseMembers,
  caseOperationFunction,
  caseVerificationKeys,
  FabricCaseTrustSchema,
  verifyCaseArbitrationDecision,
  verifyCasePublication,
  verifyCaseRevocation,
} from "@kuintessence/shared/federation/case-ledger";
import { z } from "zod";
import { FabricSubmission } from "./submission";

export const CaseAdapterConfigSchema = z.strictObject({
  siteId: z.uuid(),
  channel: z.string().regex(/^[a-z][a-z0-9.-]{0,248}$/),
  chaincode: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  trust: FabricCaseTrustSchema,
});
export type CaseAdapterConfig = z.infer<typeof CaseAdapterConfigSchema>;
export class FabricCaseAdapter {
  private readonly config: CaseAdapterConfig;
  private readonly submission: FabricSubmission;
  constructor(
    config: CaseAdapterConfig,
    private readonly gateway: Gateway,
    identity: Identity,
    signer: Signer,
    recoveryKey: Uint8Array,
  ) {
    this.config = CaseAdapterConfigSchema.parse(config);
    if (
      this.config.trust.organizations.find((org) => org.siteId === config.siteId)?.mspId !==
      identity.mspId
    )
      throw new Error("INVALID_ADAPTER_CONFIG");
    this.submission = new FabricSubmission(
      this.config,
      { purpose: "kq-case-v1", config: this.config },
      gateway,
      identity,
      signer,
      recoveryKey,
      (value) => CaseReceiptSchema.parse(value),
    );
  }
  private domain(id: string) {
    const domain = this.config.trust.domains.find((domain) => domain.domainId === id);
    if (!domain || !caseMembers(domain).includes(this.config.siteId))
      throw new Error("POLICY_DENIED");
    return domain;
  }
  async prepare(raw: CaseProposal) {
    const input = CaseProposalSchema.parse(raw),
      domain = this.domain(input.domainId);
    const keys = await caseVerificationKeys(this.config.trust, input, async () => false);
    if (
      input.operation === "record-arbitration-decision" &&
      this.config.siteId !== domain.recipientSiteId
    )
      throw new Error("POLICY_DENIED");
    const signed =
      input.operation === "record-case-evidence"
        ? await verifyCasePublication(input.envelope, domain, keys, new Date())
        : input.operation === "record-arbitration-decision"
          ? await verifyCaseArbitrationDecision(input.envelope, domain, keys, new Date())
          : await verifyCaseRevocation(input.envelope, domain, keys, new Date());
    if (
      signed.digest !== input.digest ||
      (signed.payload.kind === "case-evidence-publication"
        ? signed.payload.publicationId
        : signed.payload.kind === "case-arbitration-decision"
          ? signed.payload.decisionId
          : signed.payload.revocationId) !== input.recordId
    )
      throw new Error("OPERATION_CONFLICT");
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 1_048_576) throw new Error("INVALID_MESSAGE");
    const proposal = this.gateway
      .getNetwork(this.config.channel)
      .getContract(this.config.chaincode)
      .newProposal(caseOperationFunction[input.operation], {
        arguments: [input.domainId, input.recordId],
        transientData: { case: body },
        endorsingOrganizations: this.config.trust.organizations
          .filter((org) => caseMembers(domain).includes(org.siteId))
          .map((org) => org.mspId),
      });
    return this.submission.prepare(proposal, input);
  }
  advance(recovery: string) {
    return this.submission.advance(recovery);
  }
  async receipt(raw: z.infer<typeof CaseReceiptQuerySchema>) {
    const input = CaseReceiptQuerySchema.parse(raw);
    this.domain(input.domainId);
    const bytes = await this.gateway
      .getNetwork(this.config.channel)
      .getContract(this.config.chaincode)
      .newProposal("GetCaseReceipt", {
        arguments: [input.domainId, input.recordType, input.recordId],
        // Query only through this member's Gateway; no transient evidence in an evaluate request.
      })
      .evaluate({ deadline: Date.now() + 10000 });
    try {
      if (bytes.length > 1024) throw new Error("Oversized receipt");
      const result = CaseReceiptResultSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (result.receipt && result.receipt.recordId !== input.recordId)
        throw new Error("Wrong record");
      return result;
    } catch {
      throw new Error("INVALID_LEDGER_RESPONSE");
    }
  }
}
