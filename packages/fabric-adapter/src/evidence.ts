import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Gateway, Identity, Signable, Signer } from "@hyperledger/fabric-gateway";
import { StatusCode } from "@hyperledger/fabric-gateway";
import { msp, gateway as proto } from "@hyperledger/fabric-protos";
import {
  FabricAnchorReceiptSchema,
  FabricEvidenceTrustSchema,
  FederationEvidenceBatchSchema,
  FederationEvidenceEnvelopeSchema,
} from "@kuintessence/shared/federation/ledger";
import {
  federationMessageKeyId,
  parseFederationPublicKey,
  verifyFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { z } from "zod";

export const EvidenceAdapterConfigSchema = z.strictObject({
  siteId: z.uuid(),
  channel: z.string().regex(/^[a-z][a-z0-9.-]{0,248}$/),
  chaincode: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  trust: FabricEvidenceTrustSchema,
});
export type EvidenceAdapterConfig = z.infer<typeof EvidenceAdapterConfigSchema>;

export const EvidenceProposalInputSchema = z.strictObject({
  domainId: z.uuid(),
  batchId: z.uuid(),
  digest: FabricAnchorReceiptSchema.shape.digest,
  envelope: FederationEvidenceEnvelopeSchema,
});
export type EvidenceProposalInput = z.infer<typeof EvidenceProposalInputSchema>;

const EncodedBytes = z.string().min(1).max(4_194_304).base64();
const SignedMessageSchema = z.strictObject({ bytes: EncodedBytes, signature: EncodedBytes });
const RecoverySchema = z.strictObject({
  version: z.literal(1),
  stage: z.enum(["proposal", "transaction"]),
  transactionId: z.string().regex(/^[a-f0-9]{64}$/),
  batchId: z.uuid(),
  domainId: z.uuid(),
  digest: FabricAnchorReceiptSchema.shape.digest,
  message: SignedMessageSchema,
  commit: SignedMessageSchema.optional(),
});
type Recovery = z.infer<typeof RecoverySchema>;

export type EvidenceAdvanceResult =
  | { state: "prepared"; transactionId: string; recovery: string }
  | { state: "pending"; transactionId: string; recovery: string }
  | { state: "anchored"; transactionId: string; blockNumber: string }
  | { state: "invalid"; transactionId: string; validationCode: number; blockNumber: string };

/** No database and no arbitrary invoke API. The caller persists each checkpoint before advancing. */
export class FabricEvidenceAdapter {
  private readonly config: EvidenceAdapterConfig;
  private readonly associatedData: Buffer;
  private readonly recoveryKey: Buffer;

  constructor(
    config: EvidenceAdapterConfig,
    private readonly gateway: Gateway,
    private readonly identity: Identity,
    private readonly signer: Signer,
    recoveryKey: Uint8Array,
  ) {
    this.config = EvidenceAdapterConfigSchema.parse(config);
    const organization = this.config.trust.organizations.find((o) => o.siteId === config.siteId);
    if (!organization || organization.mspId !== identity.mspId || recoveryKey.length !== 32)
      throw new Error("INVALID_ADAPTER_CONFIG");
    this.recoveryKey = Buffer.from(recoveryKey);
    this.associatedData = createHash("sha256")
      .update(JSON.stringify(this.config))
      .update(identity.credentials)
      .digest();
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
    const recovery = this.seal({
      version: 1,
      stage: "proposal",
      transactionId: proposal.getTransactionId(),
      batchId: input.batchId,
      domainId: input.domainId,
      digest: input.digest,
      message: await this.sign(proposal),
    });
    return { transactionId: proposal.getTransactionId(), recovery };
  }

  /** An endorsement checkpoint is returned before ANY submit; unknown outcomes keep the same txId. */
  async advance(token: string): Promise<EvidenceAdvanceResult> {
    const recovery = this.open(token);
    if (recovery.stage === "proposal") {
      const proposal = this.gateway.newSignedProposal(
        Buffer.from(recovery.message.bytes, "base64"),
        Buffer.from(recovery.message.signature, "base64"),
      );
      if (proposal.getTransactionId() !== recovery.transactionId)
        throw new Error("INVALID_RECOVERY");
      const transaction = await proposal.endorse({ deadline: Date.now() + 15_000 });
      if (transaction.getTransactionId() !== recovery.transactionId)
        throw new Error("INVALID_LEDGER_RESPONSE");
      const receipt = FabricAnchorReceiptSchema.parse(
        JSON.parse(Buffer.from(transaction.getResult()).toString("utf8")),
      );
      if (receipt.batchId !== recovery.batchId || receipt.digest !== recovery.digest)
        throw new Error("INVALID_LEDGER_RESPONSE");
      const next = this.seal({
        ...recovery,
        stage: "transaction",
        message: await this.sign(transaction),
        commit: await this.commitRequest(recovery.transactionId),
      });
      return { state: "prepared", transactionId: recovery.transactionId, recovery: next };
    }
    const priorStatus = await this.status(recovery, 2_000);
    if (priorStatus) return priorStatus;
    const transaction = this.gateway.newSignedTransaction(
      Buffer.from(recovery.message.bytes, "base64"),
      Buffer.from(recovery.message.signature, "base64"),
    );
    if (transaction.getTransactionId() !== recovery.transactionId)
      throw new Error("INVALID_RECOVERY");
    try {
      await transaction.submit({ deadline: Date.now() + 5_000 });
    } catch {
      // Submit may have reached the orderer. Only commit status resolves this uncertainty.
    }
    return (
      (await this.status(recovery, 5_000)) ?? {
        state: "pending",
        transactionId: recovery.transactionId,
        recovery: token,
      }
    );
  }

  private async status(
    recovery: Recovery,
    timeoutMs: number,
  ): Promise<EvidenceAdvanceResult | null> {
    if (!recovery.commit) throw new Error("INVALID_RECOVERY");
    const commit = this.gateway.newSignedCommit(
      Buffer.from(recovery.commit.bytes, "base64"),
      Buffer.from(recovery.commit.signature, "base64"),
    );
    if (commit.getTransactionId() !== recovery.transactionId) throw new Error("INVALID_RECOVERY");
    let status: Awaited<ReturnType<typeof commit.getStatus>>;
    try {
      status = await commit.getStatus({ deadline: Date.now() + timeoutMs });
    } catch {
      return null;
    }
    if (status.transactionId !== recovery.transactionId) throw new Error("INVALID_LEDGER_RESPONSE");
    if (status.successful && status.code === StatusCode.VALID)
      return {
        state: "anchored",
        transactionId: status.transactionId,
        blockNumber: status.blockNumber.toString(),
      };
    return {
      state: "invalid",
      transactionId: status.transactionId,
      validationCode: status.code,
      blockNumber: status.blockNumber.toString(),
    };
  }

  private async commitRequest(transactionId: string) {
    const creator = new msp.SerializedIdentity();
    creator.setMspid(this.identity.mspId);
    creator.setIdBytes(this.identity.credentials);
    const request = new proto.CommitStatusRequest();
    request.setChannelId(this.config.channel);
    request.setTransactionId(transactionId);
    request.setIdentity(creator.serializeBinary());
    const signed = new proto.SignedCommitStatusRequest();
    signed.setRequest(request.serializeBinary());
    return this.sign(this.gateway.newCommit(signed.serializeBinary()));
  }

  private async sign(value: Signable) {
    return {
      bytes: Buffer.from(value.getBytes()).toString("base64"),
      signature: Buffer.from(await this.signer(value.getDigest())).toString("base64"),
    };
  }

  private seal(value: Recovery): string {
    const bytes = Buffer.from(JSON.stringify(RecoverySchema.parse(value)));
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.recoveryKey, nonce);
    cipher.setAAD(this.associatedData);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  private open(token: string): Recovery {
    try {
      const bytes = Buffer.from(EncodedBytes.parse(token), "base64");
      if (bytes.length < 29) throw new Error("Invalid recovery");
      const decipher = createDecipheriv("aes-256-gcm", this.recoveryKey, bytes.subarray(0, 12));
      decipher.setAAD(this.associatedData);
      decipher.setAuthTag(bytes.subarray(12, 28));
      return RecoverySchema.parse(
        JSON.parse(
          Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
        ),
      );
    } catch {
      throw new Error("INVALID_RECOVERY");
    }
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
