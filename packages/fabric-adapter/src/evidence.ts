import type { Gateway, Identity, Signer } from "@hyperledger/fabric-gateway";
import {
  type EvidenceAdvanceResult,
  type EvidenceProposalInput,
  EvidenceProposalInputSchema,
  FabricAnchorReceiptSchema,
  FabricEvidenceTrustSchema,
  FederationEvidenceBatchSchema,
} from "@kuintessence/shared/federation/ledger";
import {
  federationMessageKeyId,
  parseFederationPublicKey,
  verifyFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { z } from "zod";
import { FabricSubmission } from "./submission";

export const EvidenceAdapterConfigSchema = z.strictObject({
  siteId: z.uuid(),
  channel: z.string().regex(/^[a-z][a-z0-9.-]{0,248}$/),
  chaincode: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  trust: FabricEvidenceTrustSchema,
});
export type EvidenceAdapterConfig = z.infer<typeof EvidenceAdapterConfigSchema>;

export {
  type EvidenceAdvanceResult,
  type EvidenceProposalInput,
  EvidenceProposalInputSchema,
} from "@kuintessence/shared/federation/ledger";

/** No database and no arbitrary invoke API. The caller persists each checkpoint before advancing. */
export class FabricEvidenceAdapter {
  private readonly config: EvidenceAdapterConfig;
  private readonly submission: FabricSubmission;

  constructor(
    config: EvidenceAdapterConfig,
    private readonly gateway: Gateway,
    identity: Identity,
    signer: Signer,
    recoveryKey: Uint8Array,
  ) {
    this.config = EvidenceAdapterConfigSchema.parse(config);
    const organization = this.config.trust.organizations.find((o) => o.siteId === config.siteId);
    if (!organization || organization.mspId !== identity.mspId || recoveryKey.length !== 32)
      throw new Error("INVALID_ADAPTER_CONFIG");
    this.submission = new FabricSubmission(
      this.config,
      this.config,
      gateway,
      identity,
      signer,
      recoveryKey,
      (value) => {
        const receipt = FabricAnchorReceiptSchema.parse(value);
        return { recordId: receipt.batchId, digest: receipt.digest };
      },
    );
  }

  async prepare(raw: EvidenceProposalInput) {
    const input = EvidenceProposalInputSchema.parse(raw);
    const domain = this.config.trust.domains.find((d) => d.domainId === input.domainId);
    if (!domain?.siteIds.includes(this.config.siteId)) throw new Error("POLICY_DENIED");
    const now = new Date();
    const issuer = await this.verify(this.config.siteId, input.envelope.issuerJws, now);
    if (
      issuer.digest !== input.digest ||
      issuer.payload.domainId !== input.domainId ||
      issuer.payload.batchId !== input.batchId ||
      issuer.payload.issuerSiteId !== this.config.siteId ||
      !domain.siteIds.includes(issuer.payload.counterpartySiteId) ||
      Date.parse(issuer.payload.createdAt) > now.getTime() + 60_000
    )
      throw new Error("POLICY_DENIED");
    if (issuer.payload.confirmation === "bilateral") {
      if (!input.envelope.counterpartyJws) throw new Error("UNTRUSTED_IDENTITY");
      const other = await this.verify(
        issuer.payload.counterpartySiteId,
        input.envelope.counterpartyJws,
        now,
      );
      if (other.digest !== issuer.digest) throw new Error("OPERATION_CONFLICT");
    } else if (input.envelope.counterpartyJws) throw new Error("INVALID_MESSAGE");

    const contract = this.gateway
      .getNetwork(this.config.channel)
      .getContract(this.config.chaincode);
    const proposal = contract.newProposal("AnchorBatch", {
      arguments: [input.domainId, input.batchId],
      transientData: { evidence: JSON.stringify(input.envelope) },
      endorsingOrganizations: this.config.trust.organizations
        .filter((o) => domain.siteIds.includes(o.siteId))
        .map((o) => o.mspId),
    });
    return this.submission.prepare(proposal, {
      domainId: input.domainId,
      recordId: input.batchId,
      digest: input.digest,
    });
  }

  async advance(token: string): Promise<EvidenceAdvanceResult> {
    const result = await this.submission.advance(token);
    return result.state === "committed" ? { ...result, state: "anchored" } : result;
  }

  private async verify(siteId: string, jws: string, now: Date) {
    const keyId = federationMessageKeyId(jws);
    const key = this.config.trust.organizations
      .find((o) => o.siteId === siteId)
      ?.keys.find((k) => k.keyId === keyId);
    if (!key) throw new Error("UNTRUSTED_IDENTITY");
    return verifyFederationMessage(
      FederationEvidenceBatchSchema,
      jws,
      {
        siteId,
        keyId,
        publicKey: await parseFederationPublicKey(key.publicKeyPem),
        validFrom: new Date(key.validFrom),
        validUntil: new Date(key.validUntil),
        revoked: false,
        allowedKinds: ["evidence-batch"],
      },
      now,
    );
  }
}
