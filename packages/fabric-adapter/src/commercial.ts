import {
  type Gateway,
  GatewayError,
  type Identity,
  type Signer,
} from "@hyperledger/fabric-gateway";
import {
  type CommercialAdapterProposalInput,
  CommercialAdapterProposalInputSchema,
  CommercialAdjustmentSchema,
  type CommercialAgreementEnvelopeSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialGateHashSchema,
  CommercialGateQuerySchema,
  CommercialReceiptQueryResultSchema,
  CommercialReceiptQuerySchema,
  CommercialReceiptSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  CommercialSettlementSchema,
  CommercialTerminalSchema,
  CommercialUsageSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  federationMessageKeyId,
  parseFederationPublicKey,
  verifyFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { z } from "zod";
import { FabricSubmission } from "./submission";

export const CommercialAdapterConfigSchema = z.strictObject({
  siteId: z.uuid(),
  channel: z.string().regex(/^[a-z][a-z0-9.-]{0,248}$/),
  chaincode: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  trust: FabricCommercialTrustSchema,
});
export type CommercialAdapterConfig = z.infer<typeof CommercialAdapterConfigSchema>;
export class FabricCommercialAdapter {
  private readonly config: CommercialAdapterConfig;
  private readonly submission: FabricSubmission;
  constructor(
    config: CommercialAdapterConfig,
    private readonly gateway: Gateway,
    identity: Identity,
    signer: Signer,
    recoveryKey: Uint8Array,
  ) {
    this.config = CommercialAdapterConfigSchema.parse(config);
    const organization = this.config.trust.organizations.find(
      (org) => org.siteId === config.siteId,
    );
    if (!organization || organization.mspId !== identity.mspId)
      throw new Error("INVALID_ADAPTER_CONFIG");
    this.submission = new FabricSubmission(
      this.config,
      { purpose: "kq-commercial-v1", config: this.config },
      gateway,
      identity,
      signer,
      recoveryKey,
      (value) => CommercialReceiptSchema.parse(value),
    );
  }
  async prepare(raw: CommercialAdapterProposalInput) {
    const input = CommercialAdapterProposalInputSchema.parse(raw);
    const domain = this.config.trust.domains.find((domain) => domain.domainId === input.domainId);
    if (!domain?.siteIds.includes(this.config.siteId)) throw new Error("POLICY_DENIED");
    const now = new Date();
    if (input.operation !== "record-usage" && input.operation !== "record-discount") {
      const { sourceSiteId, targetSiteId } = input.envelope;
      if (
        sourceSiteId === targetSiteId ||
        !domain.siteIds.includes(sourceSiteId) ||
        !domain.siteIds.includes(targetSiteId)
      )
        throw new Error("POLICY_DENIED");
    }
    if (input.operation === "register-agreement") {
      const { sourceSiteId, targetSiteId } = input.envelope;
      const source = await this.verifyPair(CommercialAgreementSchema, input.envelope, now);
      if (
        source.digest !== input.digest ||
        source.payload.domainId !== input.domainId ||
        source.payload.agreement.agreementRevisionId !== input.recordId ||
        source.payload.agreement.sourceSiteId !== sourceSiteId ||
        source.payload.agreement.targetSiteId !== targetSiteId ||
        Date.parse(source.payload.createdAt) > now.getTime() + 60000
      )
        throw new Error("POLICY_DENIED");
    } else if (input.operation === "reserve-execution") {
      const signed = await this.verifyPair(CommercialReservationSchema, input.envelope, now),
        value = signed.payload;
      if (
        signed.digest !== input.digest ||
        value.domainId !== input.domainId ||
        value.reservationId !== input.recordId ||
        value.request.senderSiteId !== input.envelope.sourceSiteId ||
        value.request.recipientSiteId !== input.envelope.targetSiteId ||
        value.request.mode !== "ledger_coordinated" ||
        Date.parse(value.request.issuedAt) > now.getTime() + 60000
      )
        throw new Error("POLICY_DENIED");
    } else if (input.operation === "release-execution") {
      const signed = await this.verifyPair(CommercialReleaseSchema, input.envelope, now),
        value = signed.payload;
      if (
        signed.digest !== input.digest ||
        value.domainId !== input.domainId ||
        value.releaseId !== input.recordId ||
        value.sourceSiteId !== input.envelope.sourceSiteId ||
        value.targetSiteId !== input.envelope.targetSiteId ||
        Date.parse(value.issuedAt) > now.getTime() + 60000
      )
        throw new Error("POLICY_DENIED");
    } else if (input.operation === "record-execution-terminal") {
      const signed = await this.verifyPair(CommercialTerminalSchema, input.envelope, now),
        value = signed.payload;
      if (
        signed.digest !== input.digest ||
        value.domainId !== input.domainId ||
        value.terminalId !== input.recordId ||
        value.sourceSiteId !== input.envelope.sourceSiteId ||
        value.targetSiteId !== input.envelope.targetSiteId ||
        Date.parse(value.issuedAt) > now.getTime() + 60000
      )
        throw new Error("POLICY_DENIED");
    } else if (input.operation === "adjust-settlement") {
      const signed = await this.verifyPair(CommercialAdjustmentSchema, input.envelope, now),
        value = signed.payload;
      if (
        signed.digest !== input.digest ||
        value.domainId !== input.domainId ||
        value.adjustmentId !== input.recordId ||
        value.sourceSiteId !== input.envelope.sourceSiteId ||
        value.targetSiteId !== input.envelope.targetSiteId ||
        Date.parse(value.issuedAt) > now.getTime() + 60000
      )
        throw new Error("POLICY_DENIED");
    } else if (input.operation === "settle-bill") {
      const signed = await this.verifyPair(CommercialSettlementSchema, input.envelope, now),
        value = signed.payload;
      if (
        signed.digest !== input.digest ||
        value.domainId !== input.domainId ||
        value.settlementId !== input.recordId ||
        value.sourceSiteId !== input.envelope.sourceSiteId ||
        value.targetSiteId !== input.envelope.targetSiteId ||
        Date.parse(value.issuedAt) > now.getTime() + 60000
      )
        throw new Error("POLICY_DENIED");
    } else if (input.operation === "confirm-bill") {
      const signed = await this.verifyPair(CommercialBillSchema, input.envelope, now);
      const value = signed.payload;
      if (
        signed.digest !== input.digest ||
        value.domainId !== input.domainId ||
        value.billId !== input.recordId ||
        value.request.senderSiteId !== input.envelope.sourceSiteId ||
        value.request.recipientSiteId !== input.envelope.targetSiteId ||
        Date.parse(value.issuedAt) > now.getTime() + 60000
      )
        throw new Error("POLICY_DENIED");
    } else if (input.operation === "record-discount") {
      const signed = await this.verify(
        CommercialDiscountSchema,
        input.envelope.providerJws,
        this.config.siteId,
        now,
      );
      const value = signed.payload;
      if (
        signed.digest !== input.digest ||
        value.domainId !== input.domainId ||
        value.discountId !== input.recordId ||
        value.targetSiteId !== this.config.siteId ||
        value.sourceSiteId === value.targetSiteId ||
        !domain.siteIds.includes(value.sourceSiteId) ||
        Date.parse(value.issuedAt) > now.getTime() + 60000
      )
        throw new Error("POLICY_DENIED");
    } else {
      const provider = await this.verify(
        CommercialUsageSchema,
        input.envelope.providerJws,
        this.config.siteId,
        now,
      );
      if (
        provider.digest !== input.digest ||
        provider.payload.domainId !== input.domainId ||
        provider.payload.reportId !== input.recordId ||
        provider.payload.targetSiteId !== this.config.siteId ||
        !domain.siteIds.includes(provider.payload.sourceSiteId) ||
        Date.parse(provider.payload.reportedAt) > now.getTime() + 60000
      )
        throw new Error("POLICY_DENIED");
    }
    const methods = {
      "register-agreement": "RegisterAgreement",
      "record-usage": "RecordUsage",
      "reserve-execution": "ReserveExecution",
      "release-execution": "ReleaseExecution",
      "record-execution-terminal": "RecordExecutionTerminal",
      "record-discount": "RecordDiscount",
      "confirm-bill": "ConfirmBill",
      "settle-bill": "SettleBill",
      "adjust-settlement": "AdjustSettlement",
    } as const;
    const proposal = this.gateway
      .getNetwork(this.config.channel)
      .getContract(this.config.chaincode)
      .newProposal(methods[input.operation], {
        arguments: [input.domainId, input.recordId],
        transientData: { commercial: JSON.stringify(input.envelope) },
        endorsingOrganizations: this.config.trust.organizations
          .filter((org) => domain.siteIds.includes(org.siteId))
          .map((org) => org.mspId),
      });
    return this.submission.prepare(proposal, input);
  }
  async query(raw: z.infer<typeof CommercialGateQuerySchema>) {
    const input = CommercialGateQuerySchema.parse(raw);
    const domain = this.config.trust.domains.find((domain) => domain.domainId === input.domainId);
    if (!domain?.siteIds.includes(this.config.siteId)) throw new Error("POLICY_DENIED");
    let bytes: Uint8Array;
    try {
      bytes = await this.gateway
        .getNetwork(this.config.channel)
        .getContract(this.config.chaincode)
        .newProposal("GetExecutionGateHash", { arguments: [input.domainId, input.reservationId] })
        .evaluate({ deadline: Date.now() + 10000 });
    } catch (error) {
      if (
        error instanceof GatewayError &&
        error.details.length > 0 &&
        error.details.every(
          (detail) => detail.message === "chaincode response 500, ASSET_UNAVAILABLE",
        )
      )
        return { hash: null };
      throw error;
    }
    try {
      if (bytes.length > 1024) throw new Error("Oversized gate response");
      const result = CommercialGateHashSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (!result.hash) throw new Error("Missing committed hash");
      return result;
    } catch {
      throw new Error("INVALID_LEDGER_RESPONSE");
    }
  }
  async receipt(raw: z.infer<typeof CommercialReceiptQuerySchema>) {
    const input = CommercialReceiptQuerySchema.parse(raw);
    const domain = this.config.trust.domains.find((domain) => domain.domainId === input.domainId);
    if (!domain?.siteIds.includes(this.config.siteId)) throw new Error("POLICY_DENIED");
    let bytes: Uint8Array;
    try {
      bytes = await this.gateway
        .getNetwork(this.config.channel)
        .getContract(this.config.chaincode)
        .newProposal("GetRecordReceipt", {
          arguments: [input.domainId, input.recordType, input.recordId],
        })
        .evaluate({ deadline: Date.now() + 10000 });
    } catch (error) {
      if (error instanceof GatewayError && error.details.length > 0) {
        for (const code of [
          "POLICY_DENIED",
          "UNTRUSTED_IDENTITY",
          "INVALID_MESSAGE",
          "OPERATION_CONFLICT",
          "DATA_WAITING",
        ])
          if (error.details.every((detail) => detail.message === `chaincode response 500, ${code}`))
            throw new Error(code);
      }
      throw error;
    }
    try {
      if (bytes.length > 1024) throw new Error("Oversized receipt response");
      const result = CommercialReceiptQueryResultSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (result.receipt && result.receipt.recordId !== input.recordId)
        throw new Error("Wrong record");
      return result;
    } catch {
      throw new Error("INVALID_LEDGER_RESPONSE");
    }
  }
  private async verifyPair<T extends { kind: string }>(
    schema: z.ZodType<T>,
    envelope: z.infer<typeof CommercialAgreementEnvelopeSchema>,
    now: Date,
  ) {
    const source = await this.verify(schema, envelope.sourceJws, envelope.sourceSiteId, now);
    const target = await this.verify(schema, envelope.targetJws, envelope.targetSiteId, now);
    if (source.digest !== target.digest) throw new Error("OPERATION_CONFLICT");
    return source;
  }
  advance(recovery: string) {
    return this.submission.advance(recovery);
  }
  private async verify<T extends { kind: string }>(
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
    now: Date,
  ) {
    const keyId = federationMessageKeyId(jws);
    const key = this.config.trust.organizations
      .find((org) => org.siteId === siteId)
      ?.keys.find((key) => key.keyId === keyId);
    const purpose = this.config.trust.keyPurposes.find(
      (item) => item.siteId === siteId && item.keyId === keyId,
    );
    if (!key || !purpose) throw new Error("UNTRUSTED_IDENTITY");
    return verifyFederationMessage(
      schema,
      jws,
      {
        siteId,
        keyId,
        publicKey: await parseFederationPublicKey(key.publicKeyPem),
        validFrom: new Date(key.validFrom),
        validUntil: new Date(key.validUntil),
        revoked: false,
        allowedKinds: purpose.kinds,
      },
      now,
    );
  }
}
