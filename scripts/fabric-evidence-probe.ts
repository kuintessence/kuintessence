import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, EndorseError, signers } from "@hyperledger/fabric-gateway";
import { common, ledger, msp, peer, gateway as proto } from "@hyperledger/fabric-protos";
import {
  type EvidenceAdvanceResult,
  EvidenceProposalInputSchema,
  FabricProposalCheckpointSchema,
  FederationEvidenceBatchSchema,
} from "@kuintessence/shared/federation/ledger";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { FabricEvidenceAdapter } from "../packages/fabric-adapter/src/evidence";
import { createEvidenceHttpServer } from "../packages/fabric-adapter/src/runtime";
import {
  AttestationFailure,
  UnixAttestationClient,
} from "../packages/server/src/federation/attestation-client";
import { fabricEvidenceProbeFailure } from "./fabric-evidence-diagnostics";
import { Network, Site } from "./fabric-evidence-fixture";

const Request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ready") }),
  z.object({
    action: z.literal("createBatch"),
    sequence: z.string().regex(/^[1-9][0-9]*$/),
    batchFile: z.string(),
  }),
  z.object({ action: z.literal("prepare"), batchFile: z.string(), checkpointFile: z.string() }),
  z.object({ action: z.literal("advance"), checkpointFile: z.string() }),
  z.object({ action: z.literal("missingEndorsement"), batchFile: z.string() }),
  z.object({
    action: z.literal("revoke"),
    identity: z.enum(["A", "B", "C"]),
    target: z.enum(["A", "B", "C"]),
    administrator: z.boolean(),
  }),
  z.object({
    action: z.literal("privateBlock"),
    identity: z.enum(["A", "B", "C"]),
    endpoint: z.enum(["A", "B", "C"]),
    blockNumber: z.string().regex(/^[0-9]+$/),
    batchFile: z.string(),
  }),
]);
const networkPath = z.string().min(1).parse(process.argv[2]);
const requestPath = z.string().min(1).parse(process.argv[3]);
const replyPath = z.string().min(1).parse(process.argv[4]);
const network = Network.parse(JSON.parse(await readFile(networkPath, "utf8")));
const input = Request.parse(JSON.parse(await readFile(requestPath, "utf8")));
const sender = Site.parse(
  network.sites.find(
    (s) =>
      s.name ===
      (input.action === "privateBlock" || input.action === "revoke" ? input.identity : "A"),
  ),
);
const endpoint = Site.parse(
  network.sites.find((s) => s.name === (input.action === "privateBlock" ? input.endpoint : "A")),
);
const tlsCert = await readFile(join(sender.tls, "server.crt"));
const administrator = input.action === "revoke" && input.administrator;
const signingMsp = administrator ? sender.adminMsp : sender.userMsp;
const keyNames = await readdir(join(signingMsp, "keystore"));
if (keyNames.length !== 1 || !keyNames[0]) throw new Error("Missing isolated identity key");
const identity = {
  mspId: `${sender.name}MSP`,
  credentials: await readFile(
    join(
      signingMsp,
      "signcerts",
      `${administrator ? "Admin" : "User1"}@${sender.name.toLowerCase()}.kq.test-cert.pem`,
    ),
  ),
};
const signer = signers.newPrivateKeySigner(
  createPrivateKey(await readFile(join(signingMsp, "keystore", keyNames[0]))),
);
const client = new Client(
  `127.0.0.1:${endpoint.peerPort}`,
  credentials.createSsl(
    await readFile(join(endpoint.tls, "ca.crt")),
    await readFile(join(sender.tls, "server.key")),
    tlsCert,
  ),
  { "grpc.ssl_target_name_override": "localhost" },
);
const gateway = connect({
  client,
  identity,
  signer,
  tlsClientCertificateHash: createHash("sha256").update(new X509Certificate(tlsCert).raw).digest(),
  endorseOptions: () => ({ deadline: Date.now() + 15_000 }),
  submitOptions: () => ({ deadline: Date.now() + 10_000 }),
  commitStatusOptions: () => ({ deadline: Date.now() + 15_000 }),
});
const write = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const readBatch = async (path: string) =>
  EvidenceProposalInputSchema.parse(JSON.parse(await readFile(path, "utf8")));

function rejection(error: unknown) {
  const reasons = ["POLICY_DENIED", "UNTRUSTED_IDENTITY", "OPERATION_CONFLICT", "DATA_WAITING"];
  if (error instanceof AttestationFailure && error.needsReview && reasons.includes(error.code))
    return { rejected: true, reason: error.code };
  if (!(error instanceof EndorseError)) throw error;
  const reason = reasons.find((code) =>
    error.details.some((detail) => new RegExp(`\\b${code}\\b`).test(detail.message)),
  );
  if (!reason) throw error;
  return { rejected: true, reason };
}

async function execute() {
  if (input.action === "ready") {
    const domain = network.trust.domains[0];
    if (!domain) throw new Error("Missing test domain");
    for (const member of ["AMSP", "BMSP"]) {
      try {
        await gateway
          .getNetwork(network.channel)
          .getContract(network.chaincode)
          .newProposal("GetAnchor", {
            arguments: [domain.domainId, randomUUID()],
            endorsingOrganizations: [member],
          })
          .endorse();
        throw new Error("Unexpected test anchor");
      } catch (error) {
        if (!(error instanceof EndorseError)) throw error;
        if (
          !error.details.some(
            (detail) =>
              detail.mspId === member &&
              detail.message === "chaincode response 500, ASSET_UNAVAILABLE",
          )
        )
          return { ready: false };
      }
    }
    return { ready: true };
  }

  if (input.action === "createBatch") {
    const domain = network.trust.domains[0];
    const counterparty = network.sites.find((s) => s.name === "B");
    if (!domain || !counterparty) throw new Error("Missing test domain");
    const payload = FederationEvidenceBatchSchema.parse({
      protocolVersion: 1,
      kind: "evidence-batch",
      batchId: randomUUID(),
      domainId: domain.domainId,
      agreementRevisionId: randomUUID(),
      epoch: randomUUID(),
      issuerSiteId: sender.siteId,
      counterpartySiteId: counterparty.siteId,
      confirmation: "unilateral",
      salt: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(),
      records: [
        {
          evidenceId: randomUUID(),
          sequence: input.sequence,
          kind: "acceptance",
          digest: `sha256:${randomBytes(32).toString("hex")}`,
        },
      ],
    });
    const issuerJws = await signFederationMessage(FederationEvidenceBatchSchema, payload, {
      siteId: sender.siteId,
      keyId: "batch-1",
      privateKey: await importPKCS8(await readFile(sender.businessKeyFile, "utf8"), "RS256"),
    });
    const payloadBytes = issuerJws.split(".")[1];
    if (!payloadBytes) throw new Error("Missing signed test payload");
    const batch = {
      batchId: payload.batchId,
      domainId: domain.domainId,
      digest: `sha256:${createHash("sha256").update(Buffer.from(payloadBytes, "base64url")).digest("hex")}`,
      envelope: { issuerJws },
    };
    await write(input.batchFile, batch);
    return { batchId: batch.batchId, digest: batch.digest };
  }
  if (input.action === "prepare" || input.action === "advance") {
    const recoveryKey = await readFile(join(networkPath, "..", "recovery.key"));
    const adapter = new FabricEvidenceAdapter(
      {
        siteId: sender.siteId,
        channel: network.channel,
        chaincode: network.chaincode,
        trust: network.trust,
      },
      gateway,
      identity,
      signer,
      recoveryKey,
    );
    const runDirectory = await mkdtemp(join(dirname(networkPath), "unix-"));
    await chmod(runDirectory, 0o700);
    const socket = join(runDirectory, "evidence.sock");
    const server = createEvidenceHttpServer(adapter);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      await chmod(socket, 0o600);
      const adapterClient = new UnixAttestationClient(socket);
      if (input.action === "prepare") {
        const checkpoint = await adapterClient.prepare(await readBatch(input.batchFile));
        await write(input.checkpointFile, checkpoint);
        return { state: "proposal", transactionId: checkpoint.transactionId };
      }
      const checkpoint = FabricProposalCheckpointSchema.parse(
        JSON.parse(await readFile(input.checkpointFile, "utf8")),
      );
      let result: EvidenceAdvanceResult;
      try {
        result = await adapterClient.advance(checkpoint.recovery);
      } catch (error) {
        return rejection(error);
      }
      if ("recovery" in result)
        await write(input.checkpointFile, {
          transactionId: result.transactionId,
          recovery: result.recovery,
        });
      return {
        state: result.state,
        transactionId: result.transactionId,
        ...("blockNumber" in result ? { blockNumber: result.blockNumber } : {}),
        ...("validationCode" in result ? { validationCode: result.validationCode } : {}),
      };
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(runDirectory, { recursive: true, force: true });
    }
  }

  if (input.action === "revoke") {
    const target = network.sites.find((s) => s.name === input.target);
    if (!target) throw new Error("Unknown test institution");
    const proposal = gateway
      .getNetwork(network.channel)
      .getContract(network.chaincode)
      .newProposal("RevokeKey", {
        arguments: [target.siteId, "batch-1"],
        endorsingOrganizations: [`${sender.name}MSP`],
      });
    try {
      const transaction = await proposal.endorse();
      const status = await (await transaction.submit()).getStatus();
      return {
        successful: status.successful,
        validationCode: status.code,
        transactionId: status.transactionId,
        blockNumber: status.blockNumber.toString(),
      };
    } catch (error) {
      return rejection(error);
    }
  }
  if (input.action === "missingEndorsement") {
    const batch = await readBatch(input.batchFile);
    const contract = gateway.getNetwork(network.channel).getContract(network.chaincode);
    const proposed = contract.newProposal("AnchorBatch", {
      arguments: [batch.domainId, batch.batchId],
      transientData: { evidence: JSON.stringify(batch.envelope) },
      endorsingOrganizations: ["AMSP", "BMSP"],
    });
    const endorsed = await proposed.endorse();
    // Adversarial network test: a client removes B's valid signature and re-signs its own envelope.
    const prepared = proto.PreparedTransaction.deserializeBinary(endorsed.getBytes());
    const envelope = prepared.getEnvelope();
    if (!envelope) throw new Error("Missing endorsed envelope");
    const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
    const transaction = peer.Transaction.deserializeBinary(payload.getData_asU8());
    for (const action of transaction.getActionsList()) {
      const actionPayload = peer.ChaincodeActionPayload.deserializeBinary(action.getPayload_asU8());
      const endorsement = actionPayload.getAction();
      if (!endorsement) throw new Error("Missing endorsements");
      const remaining = endorsement
        .getEndorsementsList()
        .filter(
          (e) =>
            msp.SerializedIdentity.deserializeBinary(e.getEndorser_asU8()).getMspid() === "AMSP",
        );
      if (remaining.length !== 1) throw new Error("Expected A's real endorsement");
      endorsement.setEndorsementsList(remaining);
      action.setPayload(actionPayload.serializeBinary());
    }
    payload.setData(transaction.serializeBinary());
    envelope.setPayload(payload.serializeBinary());
    const malicious = gateway.newTransaction(prepared.serializeBinary());
    const status = await (await malicious.submit()).getStatus();
    return {
      successful: status.successful,
      validationCode: status.code,
      transactionId: status.transactionId,
      blockNumber: status.blockNumber.toString(),
    };
  }
  const batch = await readBatch(input.batchFile);
  const events = await gateway
    .getNetwork(network.channel)
    .newBlockAndPrivateDataEventsRequest({ startBlock: BigInt(input.blockNumber) })
    .getEvents({ deadline: Date.now() + 10_000 });
  try {
    for await (const event of events) {
      const block = event.getBlock();
      if (!block || String(block.getHeader()?.getNumber()) !== input.blockNumber)
        throw new Error("Unexpected test block");
      const privateWrites: Uint8Array[] = [];
      const collections = new Set<string>();
      for (const [, transaction] of event.getPrivateDataMapMap().entries()) {
        for (const ns of transaction.getNsPvtRwsetList()) {
          if (ns.getNamespace() !== network.chaincode) continue;
          for (const collection of ns.getCollectionPvtRwsetList()) {
            collections.add(collection.getCollectionName());
            for (const write of ledger.rwset.kvrwset.KVRWSet.deserializeBinary(
              collection.getRwset_asU8(),
            ).getWritesList())
              privateWrites.push(write.getValue_asU8());
          }
        }
      }
      return {
        identity: sender.name,
        peer: endpoint.name,
        blockNumber: input.blockNumber,
        privateWrites: privateWrites.length,
        collections: [...collections],
        privateContainsEnvelope: privateWrites.some((value) =>
          Buffer.from(value).includes(Buffer.from(batch.envelope.issuerJws)),
        ),
        publicContainsEnvelope: Buffer.from(block.serializeBinary()).includes(
          Buffer.from(batch.envelope.issuerJws),
        ),
      };
    }
    throw new Error("No committed block received");
  } finally {
    events.close();
  }
}

try {
  await write(replyPath, await execute());
} catch (error) {
  // Keep test diagnostics useful without printing transient data or serialized private proposals.
  const failure = fabricEvidenceProbeFailure(error);
  await write(replyPath, failure);
  process.stderr.write(`Fabric evidence probe failed (${failure.code ?? "unknown"})\n`);
  process.exitCode = 1;
} finally {
  gateway.close();
  client.close();
}
