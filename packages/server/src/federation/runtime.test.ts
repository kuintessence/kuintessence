import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgDb } from "@kuintessence/db";
import { exportPKCS8, generateKeyPair } from "jose";
import { loadServerConfig } from "../config";
import { loadFederationSender, startFederationIngress } from "./runtime";

const base = {
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/kuintessence_unit_unused",
  REDIS_URL: "redis://127.0.0.1:1",
  JWT_SECRET: "x".repeat(32),
};
const db = createPgDb(base.DATABASE_URL);

test("federation is opt-in and incomplete configuration cannot start a listener", async () => {
  expect(await startFederationIngress(db, loadServerConfig(base))).toBeUndefined();
  expect(() => loadServerConfig({ ...base, FEDERATION_ENABLED: "true" })).toThrow();
});

test("private ingress only binds a mode-0600 Unix socket in an owned mode-0700 directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kq-federation-runtime-"));
  const socket = join(dir, "ingress.sock");
  const keyPath = join(dir, "signing.key");
  const pair = await generateKeyPair("RS256", { extractable: true });
  await writeFile(keyPath, await exportPKCS8(pair.privateKey), { mode: 0o600 });
  const config = loadServerConfig({
    ...base,
    FEDERATION_ENABLED: "true",
    FEDERATION_SITE_ID: crypto.randomUUID(),
    FEDERATION_SOCKET_PATH: socket,
    FEDERATION_SIGNING_KEY_ID: "test",
    FEDERATION_SIGNING_KEY_FILE: keyPath,
  });
  try {
    await chmod(dir, 0o755);
    await expect(startFederationIngress(db, config)).rejects.toThrow("directory must be private");
    await chmod(dir, 0o700);
    await chmod(keyPath, 0o644);
    await expect(startFederationIngress(db, config)).rejects.toThrow(
      "signing key must be a private file",
    );
    await chmod(keyPath, 0o600);
    const server = await startFederationIngress(db, config);
    expect(server).toBeDefined();
    try {
      expect((await stat(socket)).mode & 0o777).toBe(0o600);
      const result = await fetch("http://localhost/api/admin/federation/sites", { unix: socket });
      expect(result.status).toBe(404);
      const rejected = await fetch("http://localhost/federation/v1/delegations", {
        unix: socket,
        method: "POST",
        headers: { "content-type": "application/jose" },
        body: "invalid",
      });
      expect(rejected.status).toBe(400);
    } finally {
      await server?.stop(true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outbound requires federation plus all three TLS files and a private client key", async () => {
  expect(await loadFederationSender(loadServerConfig(base))).toBeUndefined();
  const config = {
    ...base,
    FEDERATION_ENABLED: "true",
    FEDERATION_SITE_ID: crypto.randomUUID(),
    FEDERATION_SOCKET_PATH: "/private/ingress.sock",
    FEDERATION_SIGNING_KEY_ID: "test",
    FEDERATION_SIGNING_KEY_FILE: "/private/signing.key",
  };
  expect(() =>
    loadServerConfig({ ...config, FEDERATION_CLIENT_KEY_FILE: "/private/client.key" }),
  ).toThrow();
  const dir = await mkdtemp(join(tmpdir(), "kq-federation-client-"));
  const keyFile = join(dir, "client.key");
  try {
    await writeFile(keyFile, "unused", { mode: 0o644 });
    const files = {
      FEDERATION_CLIENT_CERT_FILE: join(dir, "client.pem"),
      FEDERATION_CLIENT_KEY_FILE: keyFile,
      FEDERATION_CLIENT_CA_FILE: join(dir, "ca.pem"),
    };
    expect(() => loadServerConfig({ ...base, ...files })).toThrow();
    await expect(loadFederationSender(loadServerConfig({ ...config, ...files }))).rejects.toThrow(
      "private file",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
