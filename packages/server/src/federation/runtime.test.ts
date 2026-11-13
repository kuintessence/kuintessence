import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgDb } from "@kuintessence/db";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { loadServerConfig } from "../config";
import {
  loadFederationCasePublications,
  loadFederationSender,
  startFederationIngress,
} from "./runtime";

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

test.skipIf(process.platform !== "linux")(
  "ingress recovers a killed process socket without replacing a live listener or other files",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kq-federation-restart-"));
    const socket = join(dir, "ingress.sock");
    const pair = await generateKeyPair("RS256", { extractable: true });
    const key = { siteId: crypto.randomUUID(), keyId: "test", privateKey: pair.privateKey };
    const config = loadServerConfig({
      ...base,
      FEDERATION_ENABLED: "true",
      FEDERATION_SITE_ID: key.siteId,
      FEDERATION_SOCKET_PATH: socket,
      FEDERATION_SIGNING_KEY_ID: key.keyId,
      FEDERATION_SIGNING_KEY_FILE: join(dir, "unused.key"),
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'Bun.serve({unix:process.argv[1],fetch:()=>new Response("live")}); console.log("ready");',
        socket,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    let server: Awaited<ReturnType<typeof startFederationIngress>>;
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready");
      reader.releaseLock();
      const before = await stat(socket);
      await expect(startFederationIngress(db, config, key)).rejects.toThrow("active listener");
      expect((await stat(socket)).ino).toBe(before.ino);
      expect(await (await fetch("http://localhost/", { unix: socket })).text()).toBe("live");
      child.kill("SIGKILL");
      await child.exited;
      expect((await stat(socket)).isSocket()).toBe(true);
      // Concurrent restarts must not remove the winner's newly bound socket.
      const attempts = await Promise.allSettled([
        startFederationIngress(db, config, key),
        startFederationIngress(db, config, key),
      ]);
      const started = attempts.filter((entry) => entry.status === "fulfilled");
      server = started[0]?.value;
      expect(started).toHaveLength(1);
      expect(server).toBeDefined();
      expect((await stat(socket)).mode & 0o777).toBe(0o600);
      expect((await fetch("http://localhost/", { unix: socket })).status).toBe(404);
      await expect(startFederationIngress(db, config, key)).rejects.toThrow("active listener");
      expect((await fetch("http://localhost/", { unix: socket })).status).toBe(404);
      await server?.stop(true);
      server = undefined;
      await rm(socket, { force: true });
      await writeFile(socket, "retain", { mode: 0o600 });
      await expect(startFederationIngress(db, config, key)).rejects.toThrow("must be a socket");
      expect(await readFile(socket, "utf8")).toBe("retain");
      await rm(socket);
      const target = join(dir, "target");
      await writeFile(target, "private", { mode: 0o600 });
      await symlink(target, socket);
      await expect(startFederationIngress(db, config, key)).rejects.toThrow("must be a socket");
      expect((await lstat(socket)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe("private");
    } finally {
      child.kill();
      await child.exited;
      await server?.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000,
);

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

test("case trust is opt-in and invalid or foreign configuration fails before ingress listens", async () => {
  expect(await loadFederationCasePublications(db, loadServerConfig(base))).toBeUndefined();
  const dir = await mkdtemp(join(tmpdir(), "kq-case-trust-"));
  const pair = await generateKeyPair("RS256", { extractable: true });
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
  const signing = { siteId: ids[0], keyId: "test", privateKey: pair.privateKey };
  const path = join(dir, "case-trust.json"),
    socket = join(dir, "ingress.sock");
  const pem = await exportSPKI(pair.publicKey);
  const trust = {
    version: 1,
    generationId: crypto.randomUUID(),
    organizations: ids.map((siteId, i) => ({
      siteId,
      mspId: `Org${i}MSP`,
      keys: [
        {
          keyId: "test",
          publicKeyPem: pem,
          validFrom: "2020-01-01T00:00:00Z",
          validUntil: "2099-01-01T00:00:00Z",
        },
      ],
    })),
    domains: [
      {
        domainId: crypto.randomUUID(),
        commercialDomainId: crypto.randomUUID(),
        sourceSiteId: ids[0],
        targetSiteId: ids[1],
        recipientSiteId: ids[2],
        collection: "case_ABR",
      },
    ],
    keyPurposes: ids.map((siteId) => ({
      siteId,
      keyId: "test",
      kinds: ["case-evidence-publication"],
    })),
  };
  const config = loadServerConfig({
    ...base,
    FEDERATION_ENABLED: "true",
    FEDERATION_SITE_ID: signing.siteId,
    FEDERATION_SOCKET_PATH: socket,
    FEDERATION_SIGNING_KEY_ID: signing.keyId,
    FEDERATION_SIGNING_KEY_FILE: join(dir, "unused.key"),
    FEDERATION_CASE_TRUST_FILE: path,
  });
  try {
    await writeFile(path, JSON.stringify(trust));
    expect(await loadFederationCasePublications(db, config, signing)).toBeDefined();
    await expect(
      loadFederationCasePublications(db, config, { ...signing, siteId: crypto.randomUUID() }),
    ).rejects.toThrow("Unknown local case institution");
    await writeFile(path, JSON.stringify({ ...trust, domains: [] }));
    await expect(startFederationIngress(db, config, signing)).rejects.toThrow();
    expect(await Bun.file(socket).exists()).toBe(false);
    await writeFile(path, "invalid");
    await expect(loadFederationCasePublications(db, config, signing)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
