import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FabricEvidenceTrustSchema } from "@kuintessence/shared/federation/ledger";
import shim from "fabric-shim";
import { z } from "zod";
import { EvidenceChaincode } from "./contract";

const Config = z.object({
  KQ_EVIDENCE_TRUST_FILE: z.string().min(1),
  CHAINCODE_ID: z.string().min(1),
  CHAINCODE_ADDRESS: z.string().min(1),
  CHAINCODE_TLS_KEY_FILE: z.string().min(1),
  CHAINCODE_TLS_CERT_FILE: z.string().min(1),
  CHAINCODE_TLS_CLIENT_CA_FILE: z.string().min(1),
});

export async function startEvidenceChaincode(environment: NodeJS.ProcessEnv) {
  if (process.versions.bun) throw new Error("Evidence chaincode requires Node.js");
  const config = Config.parse(environment);
  const trustBytes = await readFile(config.KQ_EVIDENCE_TRUST_FILE);
  if (trustBytes.length > 2_097_152) throw new Error("Trust configuration too large");
  const trust = FabricEvidenceTrustSchema.parse(JSON.parse(trustBytes.toString("utf8")));
  const server = shim.Shim.server(new EvidenceChaincode(trust), {
    ccid: config.CHAINCODE_ID,
    address: config.CHAINCODE_ADDRESS,
    tlsProps: {
      key: await readFile(config.CHAINCODE_TLS_KEY_FILE),
      cert: await readFile(config.CHAINCODE_TLS_CERT_FILE),
      clientCACerts: await readFile(config.CHAINCODE_TLS_CLIENT_CA_FILE),
    },
    "grpc.max_receive_message_length": 2_097_152,
    "grpc.max_send_message_length": 2_097_152,
  });
  await server.start();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startEvidenceChaincode(process.env).catch(() => {
    process.stderr.write("Evidence chaincode startup failed; check deployment configuration\n");
    process.exitCode = 1;
  });
}
