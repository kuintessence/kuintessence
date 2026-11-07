import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Gateway, Identity, Proposal, Signable, Signer } from "@hyperledger/fabric-gateway";
import { EndorseError, StatusCode } from "@hyperledger/fabric-gateway";
import { msp, gateway as proto } from "@hyperledger/fabric-protos";
import {
  type EvidenceAdvanceResult,
  FabricAnchorReceiptSchema,
} from "@kuintessence/shared/federation/ledger";
import { z } from "zod";

export type FabricSubmissionResult =
  | Exclude<EvidenceAdvanceResult, { state: "anchored" }>
  | { state: "committed"; transactionId: string; blockNumber: string };
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

/** The legacy batchId wire field is retained so persisted evidence checkpoints survive upgrades. */
export class FabricSubmission {
  private readonly associatedData: Buffer;
  private readonly recoveryKey: Buffer;
  constructor(
    private readonly config: { channel: string },
    context: unknown,
    private readonly gateway: Gateway,
    private readonly identity: Identity,
    private readonly signer: Signer,
    recoveryKey: Uint8Array,
    private readonly readReceipt: (value: unknown) => { recordId: string; digest: string },
  ) {
    if (recoveryKey.length !== 32) throw new Error("INVALID_ADAPTER_CONFIG");
    this.recoveryKey = Buffer.from(recoveryKey);
    this.associatedData = createHash("sha256")
      .update(JSON.stringify(context))
      .update(identity.credentials)
      .digest();
  }
  async prepare(
    proposal: Proposal,
    record: { domainId: string; recordId: string; digest: string },
  ) {
    const recovery = this.seal({
      version: 1,
      stage: "proposal",
      transactionId: proposal.getTransactionId(),
      batchId: record.recordId,
      domainId: record.domainId,
      digest: record.digest,
      message: await this.sign(proposal),
    });
    return { transactionId: proposal.getTransactionId(), recovery };
  }
  /** An endorsement checkpoint is returned before ANY submit; unknown outcomes keep the same txId. */
  async advance(token: string): Promise<FabricSubmissionResult> {
    const recovery = this.open(token);
    if (recovery.stage === "proposal") {
      const proposal = this.gateway.newSignedProposal(
        Buffer.from(recovery.message.bytes, "base64"),
        Buffer.from(recovery.message.signature, "base64"),
      );
      if (proposal.getTransactionId() !== recovery.transactionId)
        throw new Error("INVALID_RECOVERY");
      const transaction = await proposal
        .endorse({ deadline: Date.now() + 15_000 })
        .catch((error: unknown) => {
          // Keep terminal chaincode refusals distinct from temporary RPC failures, without raw details.
          if (error instanceof EndorseError && error.code === 10 && error.details.length) {
            const codes = error.details.map(
              (detail) =>
                /^chaincode response 500, (POLICY_DENIED|UNTRUSTED_IDENTITY|OPERATION_CONFLICT|INVALID_MESSAGE|AUTHORIZATION_EXPIRED)$/.exec(
                  detail.message,
                )?.[1],
            );
            const code = codes[0];
            if (code && codes.every((value) => value === code)) throw new Error(code);
          }
          throw error;
        });
      if (transaction.getTransactionId() !== recovery.transactionId)
        throw new Error("INVALID_LEDGER_RESPONSE");
      const receipt = this.readReceipt(
        JSON.parse(Buffer.from(transaction.getResult()).toString("utf8")),
      );
      if (receipt.recordId !== recovery.batchId || receipt.digest !== recovery.digest)
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
  ): Promise<FabricSubmissionResult | null> {
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
        state: "committed",
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
}
