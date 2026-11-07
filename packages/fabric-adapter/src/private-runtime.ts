import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { chmod, lstat, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { isAbsolute, join } from "node:path";
import { Client, credentials } from "@grpc/grpc-js";
import {
  connect,
  type Gateway,
  type Identity,
  type Signer,
  signers,
} from "@hyperledger/fabric-gateway";
import { withPrivateUnixSocketStartup } from "@kuintessence/shared/unix-socket";
import { z } from "zod";

const File = z.string().refine(isAbsolute, "Absolute path required");
export const FabricConnectionConfigSchema = z.strictObject({
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
  "AUTHORIZATION_EXPIRED",
  "BUDGET_EXHAUSTED",
  "AGREEMENT_UNAVAILABLE",
  "ASSET_UNAVAILABLE",
  "LEDGER_REQUIRED",
  "DATA_WAITING",
]);

/** Only local socket callers; no generic chaincode/channel/identity/collection selection. */
export function createFabricHttpServer<T>(
  kind: "evidence" | "commercial" | "market",
  inputSchema: z.ZodType<T>,
  adapter: { prepare(input: T): Promise<unknown>; advance(token: string): Promise<unknown> },
  query?: (input: unknown) => Promise<unknown>,
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
        ![
          `/v1/${kind}/proposal`,
          `/v1/${kind}/advance`,
          ...(query ? [`/v1/${kind}/query`] : []),
        ].includes(request.url ?? "")
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
          query && request.url === `/v1/${kind}/query`
            ? await query(input)
            : request.url === `/v1/${kind}/proposal`
              ? await adapter.prepare(inputSchema.parse(input))
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

export async function readAdapterConfigFile(configFile: string): Promise<unknown> {
  if (process.versions.bun) throw new Error("Fabric adapter requires Node.js");
  const bytes = await readFile(configFile);
  if (bytes.length > 2_097_152) throw new Error("Adapter configuration too large");
  return JSON.parse(bytes.toString("utf8"));
}

export async function startFabricRuntime(
  config: z.infer<typeof FabricConnectionConfigSchema>,
  mspId: string,
  createHttpServer: (
    gateway: Gateway,
    identity: Identity,
    signer: Signer,
    recoveryKey: Uint8Array,
  ) => Server,
  socketName: "evidence.sock" | "commercial.sock" | "market.sock",
) {
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
  const identity = { mspId, credentials: certificate };
  const signer = signers.newPrivateKeySigner(key);
  const gateway = connect({
    client,
    identity,
    signer,
    tlsClientCertificateHash: createHash("sha256")
      .update(new X509Certificate(tlsCertificate).raw)
      .digest(),
  });
  const server = createHttpServer(gateway, identity, signer, recoveryKey);
  try {
    const socket = join(config.runDirectory, socketName);
    await withPrivateUnixSocketStartup(socket, async () => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await chmod(socket, 0o600);
    });
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
