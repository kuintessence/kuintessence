import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, signers } from "@hyperledger/fabric-gateway";
import { z } from "zod";
import {
  EvidenceAdapterConfigSchema,
  EvidenceProposalInputSchema,
  FabricEvidenceAdapter,
} from "./evidence";

const File = z.string().refine(isAbsolute, "Absolute path required");
export const EvidenceRuntimeConfigSchema = z.strictObject({
  adapter: EvidenceAdapterConfigSchema,
  peerEndpoint: z.string().regex(/^[a-zA-Z0-9.-]+:[0-9]{1,5}$/),
  peerTlsCaFile: File,
  tlsCertificateFile: File,
  tlsPrivateKeyFile: File,
  identityCertificateFile: File,
  identityPrivateKeyFile: File,
  recoveryKeyFile: File,
  runDirectory: File,
});
const AdvanceInput = z.strictObject({ recovery: z.string().min(1).max(4_194_304).base64() });
const publicErrors = new Set([
  "POLICY_DENIED",
  "UNTRUSTED_IDENTITY",
  "OPERATION_CONFLICT",
  "INVALID_MESSAGE",
  "INVALID_RECOVERY",
  "INVALID_LEDGER_RESPONSE",
]);

/** Only local socket callers; no generic chaincode/channel/identity/collection selection. */
export function createEvidenceHttpServer(
  adapter: Pick<FabricEvidenceAdapter, "prepare" | "advance">,
) {
  let active = 0;
  return createServer(
    { maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 5_000 },
    async (request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      if (request.method === "GET" && request.url === "/health") {
        response.end(JSON.stringify({ configured: true }));
        return;
      }
      if (
        request.method !== "POST" ||
        !["/v1/evidence/proposal", "/v1/evidence/advance"].includes(request.url ?? "")
      ) {
        response.writeHead(404).end();
        return;
      }
      if (request.headers["content-type"] !== "application/json") {
        response.writeHead(415).end();
        return;
      }
      if (active >= 4) {
        response.writeHead(503).end(JSON.stringify({ code: "ADAPTER_BUSY" }));
        return;
      }
      active++;
      try {
        let size = 0;
        const parts: Buffer[] = [];
        for await (const part of request) {
          const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
          size += bytes.length;
          if (size > 4_194_560) {
            response.writeHead(413, { connection: "close" }).end();
            return;
          }
          parts.push(bytes);
        }
        const input: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
        );
        const result =
          request.url === "/v1/evidence/proposal"
            ? await adapter.prepare(EvidenceProposalInputSchema.parse(input))
            : await adapter.advance(AdvanceInput.parse(input).recovery);
        response.end(JSON.stringify(result));
      } catch (error) {
        const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
        const code =
          error instanceof Error && publicErrors.has(error.message)
            ? error.message
            : invalid
              ? "INVALID_MESSAGE"
              : "LEDGER_UNAVAILABLE";
        response.writeHead(code === "LEDGER_UNAVAILABLE" ? 503 : 409).end(JSON.stringify({ code }));
      } finally {
        active--;
      }
    },
  );
}

async function privateFile(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new Error("Private key file must be owned by this process user with mode 0600");
  return readFile(path);
}

export async function startEvidenceAdapter(configFile: string) {
  if (process.versions.bun) throw new Error("Fabric adapter requires Node.js");
  const bytes = await readFile(configFile);
  if (bytes.length > 2_097_152) throw new Error("Adapter configuration too large");
  const config = EvidenceRuntimeConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
  const certificate = await readFile(config.identityCertificateFile);
  const key = createPrivateKey(await privateFile(config.identityPrivateKeyFile));
  const identityCert = new X509Certificate(certificate);
  if (
    identityCert.ca ||
    Date.now() < Date.parse(identityCert.validFrom) ||
    Date.now() >= Date.parse(identityCert.validTo) ||
    !createPublicKey(key)
      .export({ type: "spki", format: "der" })
      .equals(identityCert.publicKey.export({ type: "spki", format: "der" }))
  )
    throw new Error("Invalid Fabric signing identity");
  const recoveryKey = await privateFile(config.recoveryKeyFile);
  if (recoveryKey.length !== 32) throw new Error("Recovery key must contain 32 raw random bytes");
  const org = config.adapter.trust.organizations.find((o) => o.siteId === config.adapter.siteId);
  if (!org) throw new Error("Unknown local institution");
  const tlsCertificate = await readFile(config.tlsCertificateFile);
  const client = new Client(
    config.peerEndpoint,
    credentials.createSsl(
      await readFile(config.peerTlsCaFile),
      await privateFile(config.tlsPrivateKeyFile),
      tlsCertificate,
    ),
    { "grpc.max_receive_message_length": 4_194_304, "grpc.max_send_message_length": 4_194_304 },
  );
  const identity = { mspId: org.mspId, credentials: certificate };
  const signer = signers.newPrivateKeySigner(key);
  const gateway = connect({
    client,
    identity,
    signer,
    tlsClientCertificateHash: createHash("sha256")
      .update(new X509Certificate(tlsCertificate).raw)
      .digest(),
  });
  const server = createEvidenceHttpServer(
    new FabricEvidenceAdapter(config.adapter, gateway, identity, signer, recoveryKey),
  );
  try {
    await mkdir(config.runDirectory, { recursive: true, mode: 0o700 });
    const stat = await lstat(config.runDirectory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new Error(
        "Adapter runtime directory must be owned by this process user with mode 0700",
      );
    const socket = join(config.runDirectory, "evidence.sock");
    // Existing sockets are not removed automatically: another adapter might still own them.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socket, 0o600);
  } catch (error) {
    server.close();
    gateway.close();
    client.close();
    throw error;
  }
  return async () => {
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } finally {
      gateway.close();
      client.close();
    }
  };
}
