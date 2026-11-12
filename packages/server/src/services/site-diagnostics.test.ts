import { expect, test } from "bun:test";
import { randomBytes, sign } from "node:crypto";
import forge from "node-forge";
import { FakeMinioBackend } from "../storage/minio-client.test";
import { createSiteDiagnosticsService } from "./site-diagnostics";

const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = "01";
cert.validity.notBefore = new Date(Date.now() - 1000);
cert.validity.notAfter = new Date(Date.now() + 86400000);
cert.sign(keys.privateKey, forge.md.sha256.create());
const certificate = forge.pki.certificateToPem(cert);
const privateKey = forge.pki.privateKeyToPem(keys.privateKey);
function proof(timestamp = Date.now()) {
  const nonce = randomBytes(24).toString("hex");
  return {
    agentId: "agent-a",
    certificate,
    timestamp,
    nonce,
    signature: sign(
      "sha256",
      Buffer.from(`kq-site-diagnostics-v1\nagent-a\n${timestamp}\n${nonce}`),
      privateKey,
    ).toString("base64"),
  };
}

test("diagnostic proof checks ledger, freshness, signature, identity and nonce replay", async () => {
  let valid = true;
  const service = createSiteDiagnosticsService({
    storage: new FakeMinioBackend(),
    certificate: async () => valid,
    agentExists: async () => true,
  });
  const request = proof();
  const result = await service.create(request);
  const ticket = new URL(result.cleanupUrl, "https://platform.invalid/api/").searchParams.get(
    "ticket",
  ) as string;
  expect(result.identity.agentId).toBe("agent-a");
  expect(result.fixtures.multipart.parts.length).toBe(2);
  expect(result.fixtures.multipart.parts[0]?.body.length).toBe(5 * 1024 * 1024);
  expect((await service.material(ticket)).length).toBe(result.fixtures.material.size);
  await expect(service.create(request)).rejects.toThrow();
  await expect(service.create(proof(Date.now() - 120000))).rejects.toThrow();
  await expect(service.create({ ...proof(), agentId: "other" })).rejects.toThrow();
  valid = false;
  await expect(service.material(ticket)).rejects.toThrow();
  await expect(service.create(proof())).rejects.toThrow();
  valid = true;
  await service.cleanup(ticket);
  await expect(service.material(ticket)).rejects.toThrow();
});

test("capability does not permit arbitrary objects, malformed parts, or unknown sessions", async () => {
  const service = createSiteDiagnosticsService({
    storage: new FakeMinioBackend(),
    certificate: async () => true,
    agentExists: async () => true,
  });
  const result = await service.create(proof());
  const ticket = new URL(result.cleanupUrl, "https://platform.invalid/api/").searchParams.get(
    "ticket",
  ) as string;
  await expect(service.material("../other-key")).rejects.toThrow();
  await expect(
    service.complete(ticket, [
      { partNumber: 2, etag: "e" },
      { partNumber: 2, etag: "e" },
    ]),
  ).rejects.toThrow();
  await service.cleanup(ticket);
});

test("diagnostic multipart completion assembles exact fixture bytes and cleanup removes objects", async () => {
  const storage = new FakeMinioBackend();
  const service = createSiteDiagnosticsService({
    storage,
    certificate: async () => true,
    agentExists: async () => true,
  });
  const result = await service.create(proof());
  const ticket = new URL(result.cleanupUrl, "https://platform.invalid/api/").searchParams.get(
    "ticket",
  ) as string;
  const parts: { partNumber: number; etag: string }[] = [];
  let key = "";
  for (const fixture of result.fixtures.multipart.parts) {
    const url = new URL(fixture.url);
    key = decodeURIComponent(url.pathname.slice("/part/".length));
    const partNumber = Number(url.searchParams.get("partNumber"));
    const { etag } = await storage.putUploadedPart(
      key,
      url.searchParams.get("uploadId") as string,
      partNumber,
      Buffer.from(fixture.body),
    );
    parts.push({ partNumber, etag });
  }
  await service.complete(ticket, parts);
  expect(await storage.sha256(key)).toBe(result.fixtures.multipart.verify.sha256);
  expect((await storage.head(key))?.size).toBe(result.fixtures.multipart.verify.size);
  await service.cleanup(ticket);
  expect(await storage.head(key)).toBeNull();
});
