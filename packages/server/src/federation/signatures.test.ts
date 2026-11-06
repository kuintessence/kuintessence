import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FederationDelegationSchema } from "@kuintessence/shared/federation";
import { CompactSign, exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { z } from "zod";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { testAgreement, testDelegation, testKeys, testNow } from "./test-fixtures";

let keys: Awaited<ReturnType<typeof testKeys>>;
let jws: string;
const payload = testDelegation(testAgreement(crypto.randomUUID(), crypto.randomUUID()));
beforeAll(async () => {
  keys = await testKeys(payload.senderSiteId);
  jws = await signFederationMessage(FederationDelegationSchema, payload, keys.signing);
});
const verify = (value: string, key = keys.verification) =>
  verifyFederationMessage(FederationDelegationSchema, value, key, testNow);

test("exact signed bytes produce a stable digest and are retained", async () => {
  const verified = await verify(jws);
  expect(verified.payload).toEqual(payload);
  expect(verified.jws).toBe(jws);
  expect((await verify(jws)).digest).toBe(verified.digest);
});

test("tampering, unknown headers, key substitution and revocation are rejected", async () => {
  const parts = jws.split(".");
  const changed = Buffer.from(JSON.stringify({ ...payload, maxAmount: "0" })).toString("base64url");
  await expect(verify(`${parts[0]}.${changed}.${parts[2]}`)).rejects.toThrow("INVALID_MESSAGE");
  await expect(verify(jws, { ...keys.verification, revoked: true })).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await expect(verify(jws, { ...keys.verification, keyId: "different" })).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await expect(verify(jws, { ...keys.verification, allowedKinds: ["agreement"] })).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  await expect(verify(jws, { ...keys.verification, validUntil: testNow })).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
  const remoteKeyHeader = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({
      alg: "RS256",
      typ: "kq-federation+jws",
      v: 1,
      kid: keys.signing.keyId,
      jku: "https://untrusted.invalid/key",
    })
    .sign(keys.signing.privateKey);
  await expect(verify(remoteKeyHeader)).rejects.toThrow("INVALID_MESSAGE");
});

test("valid crypto cannot hide duplicate keys, lossy encodings or oversized payloads", async () => {
  const compact = JSON.stringify(payload);
  for (const text of [
    compact.replace('"attempt":1', '"attempt":2,"attempt":1'),
    compact.replace('"attempt":1', '"attempt":1.0'),
    compact.replace('"attempt":1', '"attempt":2,"\\u0061ttempt":1'),
    ` ${compact}`,
    "x".repeat(262_145),
  ]) {
    const signed = await new CompactSign(new TextEncoder().encode(text))
      .setProtectedHeader({ alg: "RS256", typ: "kq-federation+jws", v: 1, kid: keys.signing.keyId })
      .sign(keys.signing.privateKey);
    await expect(verify(signed)).rejects.toThrow("INVALID_MESSAGE");
  }
});

test("malformed input produces a bounded generic error with no private payload", async () => {
  for (const value of ["", "secret-price", "a.b.c", "x".repeat(600_000)])
    await expect(verify(value)).rejects.toThrow("INVALID_MESSAGE");
});

test("Node and Bun agree on signed bytes and schema without importing the shared runtime root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kq-federation-interop-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "node-interop.fixture.ts")],
      outdir: directory,
      target: "node",
      format: "esm",
      naming: "interop.mjs",
    });
    expect(build.success).toBe(true);
    const pair = await generateKeyPair("RS256", { extractable: true });
    const signing = { ...keys.signing, privateKey: pair.privateKey };
    const verification = { ...keys.verification, publicKey: pair.publicKey };
    const bunJws = await signFederationMessage(FederationDelegationSchema, payload, signing);
    const node = Bun.spawn(["node", join(directory, "interop.mjs")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    node.stdin.write(
      JSON.stringify({
        publicKey: await exportSPKI(pair.publicKey),
        privateKey: await exportPKCS8(pair.privateKey),
        siteId: signing.siteId,
        keyId: signing.keyId,
        now: testNow.toISOString(),
        validFrom: verification.validFrom.toISOString(),
        validUntil: verification.validUntil.toISOString(),
        jws: bunJws,
      }),
    );
    node.stdin.end();
    const [output, errors, exit] = await Promise.all([
      new Response(node.stdout).text(),
      new Response(node.stderr).text(),
      node.exited,
    ]);
    expect(errors).toBe("");
    expect(exit).toBe(0);
    const result = z.object({ digest: z.string(), jws: z.string() }).parse(JSON.parse(output));
    const verified = await verify(result.jws, verification);
    expect(result.digest).toBe(verified.digest);
    expect(verified.payload).toEqual(payload);
    expect(result.jws).toBe(bunJws);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execution deadline is covered by the original signed bytes", async () => {
  const extended = { ...payload, executionExpiresAt: "2026-01-01T12:00:00.000Z" };
  const signed = await signFederationMessage(FederationDelegationSchema, extended, keys.signing);
  expect((await verify(signed)).payload.executionExpiresAt).toBe(extended.executionExpiresAt);
  const [header, bytes, signature] = signed.split(".");
  if (!header || !bytes || !signature) throw new Error("Missing signed fixture");
  const changed = Buffer.from(
    JSON.stringify({ ...extended, executionExpiresAt: "2026-01-01T18:00:00.000Z" }),
  ).toString("base64url");
  await expect(verify(`${header}.${changed}.${signature}`)).rejects.toThrow("INVALID_MESSAGE");
});
