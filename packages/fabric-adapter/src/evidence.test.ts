import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { Client, credentials, Metadata } from "@grpc/grpc-js";
import {
  connect,
  EndorseError,
  type Proposal,
  type Status,
  StatusCode,
  signers,
} from "@hyperledger/fabric-gateway";
import { common, peer, gateway as proto } from "@hyperledger/fabric-protos";
import {
  type FederationEvidenceBatch,
  FederationEvidenceBatchSchema,
} from "@kuintessence/shared/federation/ledger";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { exportSPKI, generateKeyPair } from "jose";
import {
  type EvidenceAdapterConfig,
  type EvidenceProposalInput,
  FabricEvidenceAdapter,
} from "./evidence";

let config: EvidenceAdapterConfig;
let input: EvidenceProposalInput;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const sites = [randomUUID(), randomUUID(), randomUUID()];
  const source = sites[0];
  const target = sites[1];
  if (!source || !target) throw new Error("Missing sites");
  const batch: FederationEvidenceBatch = {
    protocolVersion: 1,
    kind: "evidence-batch",
    batchId: randomUUID(),
    domainId: randomUUID(),
    agreementRevisionId: randomUUID(),
    epoch: randomUUID(),
    issuerSiteId: source,
    counterpartySiteId: target,
    confirmation: "unilateral",
    salt: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(),
    records: [
      {
        evidenceId: randomUUID(),
        sequence: "1",
        kind: "acceptance",
        digest: `sha256:${"ab".repeat(32)}`,
      },
    ],
  };
  const pem = await exportSPKI(pair.publicKey);
  config = {
    siteId: source,
    channel: "cooperation",
    chaincode: "kq-evidence",
    trust: {
      version: 1,
      generationId: randomUUID(),
      organizations: sites.map((siteId, i) => ({
        siteId,
        mspId: `${String.fromCharCode(65 + i)}MSP`,
        keys: [
          {
            keyId: "batch-1",
            publicKeyPem: pem,
            validFrom: "2026-01-01T00:00:00Z",
            validUntil: "2099-01-01T00:00:00Z",
          },
        ],
      })),
      domains: [{ domainId: batch.domainId, collection: "evidence_AB", siteIds: [source, target] }],
    },
  };
  const issuerJws = await signFederationMessage(FederationEvidenceBatchSchema, batch, {
    siteId: source,
    keyId: "batch-1",
    privateKey: pair.privateKey,
  });
  const payload = issuerJws.split(".")[1];
  if (!payload) throw new Error("Missing payload");
  input = {
    domainId: batch.domainId,
    batchId: batch.batchId,
    digest: `sha256:${new Bun.CryptoHasher("sha256").update(Buffer.from(payload, "base64url")).digest("hex")}`,
    envelope: { issuerJws },
  };
});

/** Real SDK codecs/signing/reconstruction; RPC results are controlled and are NOT a Fabric network. */
function setup() {
  const client = new Client("127.0.0.1:1", credentials.createInsecure());
  const identity = { mspId: "AMSP", credentials: Buffer.from("offline-sdk-test-identity") };
  const signer = signers.newPrivateKeySigner(
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
  );
  const gateway = connect({ client, identity, signer });
  cleanups.push(() => {
    gateway.close();
    client.close();
  });
  const recoveryKey = randomBytes(32);
  const adapter = new FabricEvidenceAdapter(config, gateway, identity, signer, recoveryKey);
  let submits = 0;
  let endorsements = 0;
  let committed: Status["code"] | null = null;
  let nextCode: Status["code"] | null = StatusCode.VALID;
  let proposed: proto.ProposedTransaction | undefined;
  let endorsementError: Error | undefined;
  const originalProposal = gateway.newSignedProposal.bind(gateway);
  const originalTransaction = gateway.newSignedTransaction.bind(gateway);
  const originalCommit = gateway.newSignedCommit.bind(gateway);

  function endorsed(proposal: Proposal) {
    const channel = new common.ChannelHeader();
    channel.setChannelId(config.channel);
    channel.setTxId(proposal.getTransactionId());
    const header = new common.Header();
    header.setChannelHeader(channel.serializeBinary());
    const response = new peer.Response();
    response.setStatus(200);
    response.setPayload(
      Buffer.from(JSON.stringify({ batchId: input.batchId, digest: input.digest })),
    );
    const action = new peer.ChaincodeAction();
    action.setResponse(response);
    const proposalResponse = new peer.ProposalResponsePayload();
    proposalResponse.setExtension$(action.serializeBinary());
    const chaincodeEndorsedAction = new peer.ChaincodeEndorsedAction();
    chaincodeEndorsedAction.setProposalResponsePayload(proposalResponse.serializeBinary());
    const actionPayload = new peer.ChaincodeActionPayload();
    actionPayload.setAction(chaincodeEndorsedAction);
    const transactionAction = new peer.TransactionAction();
    transactionAction.setPayload(actionPayload.serializeBinary());
    const transaction = new peer.Transaction();
    transaction.setActionsList([transactionAction]);
    const payload = new common.Payload();
    payload.setHeader(header);
    payload.setData(transaction.serializeBinary());
    const envelope = new common.Envelope();
    envelope.setPayload(payload.serializeBinary());
    const result = new proto.PreparedTransaction();
    result.setEnvelope(envelope);
    result.setTransactionId(proposal.getTransactionId());
    return gateway.newTransaction(result.serializeBinary());
  }

  spyOn(gateway, "newSignedProposal").mockImplementation((bytes, signature) => {
    proposed = proto.ProposedTransaction.deserializeBinary(bytes);
    const proposal = originalProposal(bytes, signature);
    spyOn(proposal, "endorse").mockImplementation(async () => {
      endorsements++;
      if (endorsementError) throw endorsementError;
      return endorsed(proposal);
    });
    return proposal;
  });
  spyOn(gateway, "newSignedTransaction").mockImplementation((bytes, signature) => {
    const transaction = originalTransaction(bytes, signature);
    spyOn(transaction, "submit").mockImplementation(async () => {
      submits++;
      committed = nextCode;
      throw new Error("lost acknowledgement with private-detail that must never escape");
    });
    return transaction;
  });
  spyOn(gateway, "newSignedCommit").mockImplementation((bytes, signature) => {
    const commit = originalCommit(bytes, signature);
    spyOn(commit, "getStatus").mockImplementation(async () => {
      if (committed === null) throw new Error("timeout with private details");
      return {
        transactionId: commit.getTransactionId(),
        blockNumber: 19n,
        code: committed,
        successful: committed === StatusCode.VALID,
      };
    });
    return commit;
  });
  return {
    adapter,
    gateway,
    identity,
    signer,
    recoveryKey,
    proposed: () => proposed,
    endorseError: (error: Error) => {
      endorsementError = error;
    },
    counts: () => ({ submits, endorsements }),
    nextCode: (code: Status["code"] | null) => {
      nextCode = code;
    },
  };
}

test("signed proposal contains only opaque IDs in args and sends transient only to both member MSPs", async () => {
  const fixture = setup();
  const created = await fixture.adapter.prepare(input);
  expect(fixture.counts()).toEqual({ submits: 0, endorsements: 0 });
  expect(created.recovery).not.toContain(input.envelope.issuerJws);
  const encrypted = Buffer.from(created.recovery, "base64").toString();
  expect(encrypted).not.toContain(input.envelope.issuerJws);
  const next = await fixture.adapter.advance(created.recovery);
  expect(next.state).toBe("prepared");
  expect(fixture.counts()).toEqual({ submits: 0, endorsements: 1 });
  const proposed = fixture.proposed();
  expect(proposed?.getEndorsingOrganizationsList()).toEqual(["AMSP", "BMSP"]);
  const signed = proposed?.getProposal();
  if (!signed) throw new Error("Missing proposal");
  const proposal = peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8());
  const payload = peer.ChaincodeProposalPayload.deserializeBinary(proposal.getPayload_asU8());
  expect(payload.getTransientmapMap().getLength()).toBe(1);
  expect(Buffer.from(payload.getTransientmapMap().get("evidence") ?? []).toString()).toBe(
    JSON.stringify(input.envelope),
  );
  const invocation = peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8());
  expect(
    invocation
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((v) => Buffer.from(v).toString()),
  ).toEqual(["AnchorBatch", input.domainId, input.batchId]);
  expect(invocation.getChaincodeSpec()?.getChaincodeId()?.getName()).toBe("kq-evidence");
});

test("lost submit acknowledgement resolves by VALID; restart queries original txId without resubmitting", async () => {
  const fixture = setup();
  const created = await fixture.adapter.prepare(input);
  const next = await fixture.adapter.advance(created.recovery);
  if (next.state !== "prepared") throw new Error("Expected checkpoint");
  const result = await fixture.adapter.advance(next.recovery);
  expect(result).toEqual({
    state: "anchored",
    transactionId: created.transactionId,
    blockNumber: "19",
  });
  const restarted = new FabricEvidenceAdapter(
    config,
    fixture.gateway,
    fixture.identity,
    fixture.signer,
    fixture.recoveryKey,
  );
  expect(await restarted.advance(next.recovery)).toEqual(result);
  expect(fixture.counts()).toEqual({ submits: 1, endorsements: 1 });
});

test("pending status keeps original recovery bytes; invalid commits never become anchored", async () => {
  const fixture = setup();
  fixture.nextCode(null);
  const next = await fixture.adapter.advance((await fixture.adapter.prepare(input)).recovery);
  if (next.state !== "prepared") throw new Error("Expected checkpoint");
  expect(await fixture.adapter.advance(next.recovery)).toEqual({ ...next, state: "pending" });
  fixture.nextCode(StatusCode.MVCC_READ_CONFLICT);
  expect(await fixture.adapter.advance(next.recovery)).toEqual({
    state: "invalid",
    transactionId: next.transactionId,
    validationCode: StatusCode.MVCC_READ_CONFLICT,
    blockNumber: "19",
  });
  expect(fixture.counts()).toEqual({ submits: 2, endorsements: 1 });
});

test("tampered recovery, changed policy, wrong key and foreign domain fail before any SDK submission", async () => {
  const fixture = setup();
  const created = await fixture.adapter.prepare(input);
  const bytes = Buffer.from(created.recovery, "base64");
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
  await expect(fixture.adapter.advance(bytes.toString("base64"))).rejects.toThrow(
    "INVALID_RECOVERY",
  );
  const wrongKey = new FabricEvidenceAdapter(
    config,
    fixture.gateway,
    fixture.identity,
    fixture.signer,
    randomBytes(32),
  );
  await expect(wrongKey.advance(created.recovery)).rejects.toThrow("INVALID_RECOVERY");
  const otherChannel = new FabricEvidenceAdapter(
    { ...config, channel: "other-channel" },
    fixture.gateway,
    fixture.identity,
    fixture.signer,
    fixture.recoveryKey,
  );
  await expect(otherChannel.advance(created.recovery)).rejects.toThrow("INVALID_RECOVERY");
  await expect(fixture.adapter.prepare({ ...input, domainId: randomUUID() })).rejects.toThrow(
    "POLICY_DENIED",
  );
  await expect(
    fixture.adapter.prepare({ ...input, digest: `sha256:${"0".repeat(64)}` }),
  ).rejects.toThrow("POLICY_DENIED");
  expect(fixture.counts()).toEqual({ submits: 0, endorsements: 0 });
});

test("explicit chaincode refusals are sanitized terminal errors; RPC and ambiguous failures remain retryable", async () => {
  const fixture = setup();
  const checkpoint = await fixture.adapter.prepare(input);
  const failure = (code: number, messages: string[]) =>
    new EndorseError({
      code,
      transactionId: checkpoint.transactionId,
      cause: Object.assign(new Error("private transport details"), {
        code,
        details: "private",
        metadata: new Metadata(),
      }),
      details: messages.map((message) => ({ address: "private-peer", mspId: "AMSP", message })),
    });
  for (const code of [
    "POLICY_DENIED",
    "UNTRUSTED_IDENTITY",
    "OPERATION_CONFLICT",
    "INVALID_MESSAGE",
  ]) {
    fixture.endorseError(failure(10, [`chaincode response 500, ${code}`]));
    try {
      await fixture.adapter.advance(checkpoint.recovery);
      throw new Error("Expected terminal refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(code);
      expect(error).not.toBeInstanceOf(EndorseError);
    }
  }
  for (const error of [
    failure(14, ["chaincode response 500, POLICY_DENIED"]),
    failure(10, []),
    failure(10, ["private POLICY_DENIED detail"]),
    failure(10, ["chaincode response 500, DATA_WAITING"]),
    failure(10, ["chaincode response 500, POLICY_DENIED", "peer unavailable"]),
  ]) {
    fixture.endorseError(error);
    await expect(fixture.adapter.advance(checkpoint.recovery)).rejects.toBe(error);
  }
  expect(fixture.counts().submits).toBe(0);
});
