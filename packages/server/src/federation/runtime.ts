import { chmod, lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { PgDb } from "@kuintessence/db";
import { withPrivateUnixSocketStartup } from "@kuintessence/shared/unix-socket";
import { importPKCS8 } from "jose";
import type { ServerConfig } from "../config";
import type { FederationDownloadStorage } from "./download-credential";
import type { FederationExecutionConfirmationService } from "./execution-confirmation";
import { createFederationIngress } from "./ingress";
import type { FederationOutboundService } from "./outbound";
import { createFederationSender } from "./outbound-client";
import type { FederationResultDownloadStorage } from "./results";
import type { FederationSigningKey } from "./signatures";

export async function startFederationIngress(
  db: PgDb,
  config: ServerConfig,
  key?: FederationSigningKey,
  downloads?: FederationResultDownloadStorage,
  materials?: Pick<FederationOutboundService, "materialChunk" | "inputDownload">,
  inputDownloads?: FederationDownloadStorage,
  confirmations?: FederationExecutionConfirmationService,
) {
  if (!config.FEDERATION_ENABLED) return undefined;
  const socketPath = config.FEDERATION_SOCKET_PATH;
  const siteId = config.FEDERATION_SITE_ID;
  const keyId = config.FEDERATION_SIGNING_KEY_ID;
  const keyFile = config.FEDERATION_SIGNING_KEY_FILE;
  if (!socketPath || !isAbsolute(socketPath) || !siteId || !keyId || !keyFile)
    throw new Error(
      "Federation requires absolute socket path, site ID and signing key configuration",
    );
  const signingKey = key ?? (await loadFederationSigningKey(config));
  if (!signingKey) throw new Error("Federation signing key is required");
  const app = createFederationIngress(
    db,
    signingKey,
    downloads,
    materials,
    inputDownloads,
    confirmations,
  );
  return withPrivateUnixSocketStartup(socketPath, async () => {
    const server = Bun.serve({ unix: socketPath, fetch: app.fetch, maxRequestBodySize: 524288 });
    try {
      await chmod(socketPath, 0o600);
    } catch (error) {
      await server.stop(true);
      throw error;
    }
    return server;
  });
}

export async function loadFederationSigningKey(
  config: ServerConfig,
): Promise<FederationSigningKey | undefined> {
  if (!config.FEDERATION_ENABLED) return undefined;
  const keyFile = config.FEDERATION_SIGNING_KEY_FILE;
  const siteId = config.FEDERATION_SITE_ID;
  const keyId = config.FEDERATION_SIGNING_KEY_ID;
  if (!keyFile || !siteId || !keyId)
    throw new Error("Federation signing key configuration required");
  const keyStat = await lstat(keyFile);
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0 || keyStat.uid !== process.getuid?.())
    throw new Error("Federation signing key must be a private file owned by the Server UID");
  const privateKey = await importPKCS8(await readFile(keyFile, "utf8"), "RS256");
  return { siteId, keyId, privateKey };
}

export async function loadFederationSender(config: ServerConfig) {
  if (!config.FEDERATION_ENABLED || !config.FEDERATION_CLIENT_KEY_FILE) return undefined;
  const {
    FEDERATION_CLIENT_KEY_FILE: keyFile,
    FEDERATION_CLIENT_CERT_FILE: certFile,
    FEDERATION_CLIENT_CA_FILE: caFile,
  } = config;
  if (!certFile || !caFile) throw new Error("Federation client TLS configuration is incomplete");
  const stat = await lstat(keyFile);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new Error("Federation client key must be a private file owned by the Server UID");
  const [cert, key, ca] = await Promise.all([
    readFile(certFile, "utf8"),
    readFile(keyFile, "utf8"),
    readFile(caFile, "utf8"),
  ]);
  return createFederationSender({ cert, key, ca });
}
