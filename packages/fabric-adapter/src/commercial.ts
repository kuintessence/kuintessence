import type { Gateway, Identity, Signer } from "@hyperledger/fabric-gateway";
import {
  CommercialAgreementSchema,
  type CommercialProposalInput,
  CommercialProposalInputSchema,
  CommercialReceiptSchema,
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
  async prepare(raw: CommercialProposalInput) {
    const input = CommercialProposalInputSchema.parse(raw);
    const domain = this.config.trust.domains.find((domain) => domain.domainId === input.domainId);
    if (!domain?.siteIds.includes(this.config.siteId)) throw new Error("POLICY_DENIED");
    const now = new Date();
    if (input.operation === "register-agreement") {
      const { sourceSiteId, targetSiteId, sourceJws, targetJws } = input.envelope;
      if (
        sourceSiteId === targetSiteId ||
        !domain.siteIds.includes(sourceSiteId) ||
        !domain.siteIds.includes(targetSiteId)
      )
        throw new Error("POLICY_DENIED");
      const source = await this.verify(CommercialAgreementSchema, sourceJws, sourceSiteId, now);
      const target = await this.verify(CommercialAgreementSchema, targetJws, targetSiteId, now);
      if (source.digest !== target.digest) throw new Error("OPERATION_CONFLICT");
      if (
        source.digest !== input.digest ||
        source.payload.domainId !== input.domainId ||
        source.payload.agreement.agreementRevisionId !== input.recordId ||
        source.payload.agreement.sourceSiteId !== sourceSiteId ||
        source.payload.agreement.targetSiteId !== targetSiteId ||
        Date.parse(source.payload.createdAt) > now.getTime() + 60000
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
    const proposal = this.gateway
      .getNetwork(this.config.channel)
      .getContract(this.config.chaincode)
      .newProposal(input.operation === "register-agreement" ? "RegisterAgreement" : "RecordUsage", {
        arguments: [input.domainId, input.recordId],
        transientData: { commercial: JSON.stringify(input.envelope) },
        endorsingOrganizations: this.config.trust.organizations
          .filter((org) => domain.siteIds.includes(org.siteId))
          .map((org) => org.mspId),
      });
    return this.submission.prepare(proposal, input);
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
