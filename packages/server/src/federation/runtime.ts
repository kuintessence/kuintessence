import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { PgDb } from "@kuintessence/db";
import { importPKCS8 } from "jose";
import type { ServerConfig } from "../config";
import { createFederationIngress } from "./ingress";
import type { FederationSigningKey } from "./signatures";

export async function startFederationIngress(
  db: PgDb,
  config: ServerConfig,
  key?: FederationSigningKey,
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
  const directory = dirname(socketPath);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new Error("Federation socket directory must be private (0700), owned by the Server UID");
  const signingKey = key ?? (await loadFederationSigningKey(config));
  if (!signingKey) throw new Error("Federation signing key is required");
  const app = createFederationIngress(db, signingKey);
  const server = Bun.serve({ unix: socketPath, fetch: app.fetch, maxRequestBodySize: 524288 });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  return server;
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
