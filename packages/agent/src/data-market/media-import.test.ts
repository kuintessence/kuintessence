import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FederationMediaImportTaskSchema,
  FederationMediaKeyGrantSchema,
  FederationMediaKeyQuerySchema,
} from "@kuintessence/shared/federation";
import { encryptFederationMediaIdentity } from "@kuintessence/shared/federation/media-key-crypto";
import { signFederationMessage } from "@kuintessence/shared/federation/signatures";
import { AgentDataRoots } from "./local-data-security";
import { exportFederationMedia } from "./media-export";
import { importFederationMedia } from "./media-import";
import { mediaExportFixture } from "./media-test-fixtures";

const live = process.env.KQ_MEDIA_AGE_TEST_BIN ? test : test.skip;
async function fixture() {
  const f = await mediaExportFixture();
  await exportFederationMedia(f.options);
  const mediaDirectory = join(f.root, "receiver-media");
  const inbox = join(mediaDirectory, "inbox", f.manifest.packageId);
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const cipher = join(inbox, "bundle.age");
  await copyFile(
    join(f.options.mediaDirectory, "outbox", f.manifest.packageId, "bundle.age"),
    cipher,
  );
  const data = join(f.root, "receiver-data");
  await mkdir(data, { mode: 0o700 });
  const roots = new AgentDataRoots({
    datasetRoot: data,
    jobWorkRoot: join(f.root, "receiver-jobs"),
    managedRoots: { [f.options.task.managedRootId]: "." },
  });
  await roots.initialize();
  const task = FederationMediaImportTaskSchema.parse({
    generation: crypto.randomUUID(),
    packageId: f.manifest.packageId,
    authorizationId: crypto.randomUUID(),
    manifestDigest: f.options.task.manifestDigest,
    agentId: "receiver-agent",
    sourceSiteId: f.manifest.senderSiteId,
    recipientSiteId: f.manifest.recipientSiteId,
    agreementRevisionId: f.manifest.agreementRevisionId,
    managedRootId: f.options.task.managedRootId,
    maxBytes: f.bytes.length,
    signedManifest: f.options.task.signedManifest,
    signingKey: f.options.task.signingKey,
    expiresAt: f.options.task.expiresAt,
  });
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["encrypt", "decrypt"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const recipientKey = { kty: "RSA" as const, n: jwk.n ?? "", e: "AQAB" as const };
  const binding = {
    generation: task.generation,
    packageId: task.packageId,
    authorizationId: task.authorizationId,
    manifestDigest: task.manifestDigest,
  };
  const authorize = async () => {
    const query = FederationMediaKeyQuerySchema.parse({
      protocolVersion: 1,
      kind: "media-key-query",
      queryId: crypto.randomUUID(),
      senderSiteId: task.recipientSiteId,
      recipientSiteId: task.sourceSiteId,
      packageId: task.packageId,
      agreementRevisionId: task.agreementRevisionId,
      manifestDigest: task.manifestDigest,
      authorizationId: task.authorizationId,
      agentId: task.agentId,
      managedRootId: task.managedRootId,
      recipientKey,
      maxBytes: task.maxBytes,
      authorizationExpiresAt: task.expiresAt,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    const queryDigest = `sha256:${createHash("sha256").update(JSON.stringify(query)).digest("hex")}`;
    const grant = FederationMediaKeyGrantSchema.parse({
      protocolVersion: 1,
      kind: "media-key-grant",
      queryId: query.queryId,
      senderSiteId: task.sourceSiteId,
      recipientSiteId: task.recipientSiteId,
      packageId: task.packageId,
      agreementRevisionId: task.agreementRevisionId,
      manifestDigest: task.manifestDigest,
      authorizationId: task.authorizationId,
      agentId: task.agentId,
      managedRootId: task.managedRootId,
      queryDigest,
      issuedAt: query.issuedAt,
      expiresAt: query.expiresAt,
      encryptedIdentity: await encryptFederationMediaIdentity(
        f.identity.identity,
        recipientKey,
        queryDigest,
      ),
    });
    return {
      binding,
      query,
      queryDigest,
      signedGrant: await signFederationMessage(FederationMediaKeyGrantSchema, grant, {
        siteId: task.sourceSiteId,
        keyId: task.signingKey.keyId,
        privateKey: f.keyPair.privateKey,
      }),
      signingKey: task.signingKey,
      expiresAt: grant.expiresAt,
    };
  };
  const options = {
    task,
    agentId: task.agentId,
    mediaDirectory,
    roots,
    age: f.age,
    privateKey: keys.privateKey,
    recipientKey,
    signal: f.options.signal,
    authorize,
  };
  return {
    ...f,
    options,
    cipher,
    parent: join(data, ".federation-media"),
    target: join(data, ".federation-media", task.packageId),
  };
}
live(
  "real receiver decrypts privately, reuses a verified copy without inbox, and detects tampering",
  async () => {
    const f = await fixture();
    try {
      const result = await importFederationMedia(f.options);
      expect(result.state).toBe("verified");
      expect(result.sizeBytes).toBe(f.bytes.length);
      expect(await readFile(join(f.target, "files", "input.dat"))).toEqual(f.bytes);
      await rm(f.cipher);
      expect((await importFederationMedia(f.options)).state).toBe("verified");
      await writeFile(join(f.target, "files", "extra"), "unlisted");
      await expect(importFederationMedia(f.options)).rejects.toThrow("MEDIA_IMPORT_CHANGED");
      await rm(join(f.target, "files", "extra"));
      await writeFile(join(f.target, "files", "input.dat"), Buffer.alloc(f.bytes.length));
      await expect(importFederationMedia(f.options)).rejects.toThrow("MEDIA_SOURCE_CHANGED");
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);
live.each(["scope", "key", "damaged", "revoked"] as const)(
  "receiver rejects %s without retaining plaintext",
  async (mode) => {
    const f = await fixture();
    try {
      let count = 0;
      if (mode === "damaged") await writeFile(f.cipher, "broken age file");
      const authorize = async () => {
        if (mode === "revoked" && ++count > 1) throw new Error("revoked");
        const grant = await f.options.authorize();
        if (mode === "scope") grant.query.managedRootId = crypto.randomUUID();
        if (mode === "key") grant.query.recipientKey.n = "b".repeat(342);
        return grant;
      };
      await expect(importFederationMedia({ ...f.options, authorize })).rejects.toThrow();
      expect(await readdir(f.parent)).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
  30_000,
);
