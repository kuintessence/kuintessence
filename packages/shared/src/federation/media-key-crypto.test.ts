import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair } from "jose";
import { decryptFederationMediaIdentity, encryptFederationMediaIdentity } from "./media-key-crypto";
import { FederationMediaRecipientKeySchema } from "./media-keys";

const identity = new TextEncoder().encode(`AGE-SECRET-KEY-1${"A".repeat(58)}\n`);
const digest = `sha256:${"a".repeat(64)}`;

test("media identities are encrypted only to the bound Agent key and query digest", async () => {
  const pair = await generateKeyPair("RSA-OAEP-256", { modulusLength: 2048 });
  const recipient = FederationMediaRecipientKeySchema.parse(await exportJWK(pair.publicKey));
  const envelope = await encryptFederationMediaIdentity(identity, recipient, digest);
  expect(envelope).not.toContain("AGE-SECRET-KEY");
  const plain = await decryptFederationMediaIdentity(envelope, pair.privateKey, digest);
  expect(plain).toEqual(identity);
  plain.fill(0);
  await expect(
    decryptFederationMediaIdentity(envelope, pair.privateKey, `sha256:${"b".repeat(64)}`),
  ).rejects.toThrow("INVALID_MESSAGE");
  const other = await generateKeyPair("RSA-OAEP-256", { modulusLength: 2048 });
  await expect(decryptFederationMediaIdentity(envelope, other.privateKey, digest)).rejects.toThrow(
    "INVALID_MESSAGE",
  );
  const parts = envelope.split(".");
  parts[3] = `${parts[3]?.[0] === "A" ? "B" : "A"}${parts[3]?.slice(1)}`;
  await expect(
    decryptFederationMediaIdentity(parts.join("."), pair.privateKey, digest),
  ).rejects.toThrow("INVALID_MESSAGE");
});

test("recipient inputs reject private parameters, weak keys and unbounded RSA exponents", async () => {
  const pair = await generateKeyPair("RSA-OAEP-256", { modulusLength: 2048 });
  const key = await exportJWK(pair.publicKey);
  expect(FederationMediaRecipientKeySchema.safeParse({ ...key, d: "private" }).success).toBe(false);
  expect(FederationMediaRecipientKeySchema.safeParse({ ...key, e: "A".repeat(1000) }).success).toBe(
    false,
  );
  expect(FederationMediaRecipientKeySchema.safeParse({ ...key, n: "A".repeat(1000) }).success).toBe(
    false,
  );
  await expect(
    encryptFederationMediaIdentity(identity, { kty: "RSA", n: "A".repeat(342), e: "AQAB" }, digest),
  ).rejects.toThrow("INVALID_MESSAGE");
});
