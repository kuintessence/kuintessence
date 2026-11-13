import { CompactEncrypt, compactDecrypt, importJWK } from "jose";
import { z } from "zod";
import { FederationError } from "./errors";
import { type FederationMediaRecipientKey, FederationMediaRecipientKeySchema } from "./media-keys";
import { FederationDigestSchema } from "./references";

const Header = z.strictObject({
  alg: z.literal("RSA-OAEP-256"),
  enc: z.literal("A256GCM"),
  typ: z.literal("kq-media-key+jwe"),
  queryDigest: FederationDigestSchema,
});
const Identity = /^AGE-SECRET-KEY-1[0-9A-Z]{58}\n?$/;

export async function encryptFederationMediaIdentity(
  identity: Uint8Array,
  recipient: FederationMediaRecipientKey,
  queryDigest: string,
) {
  try {
    if (!Identity.test(new TextDecoder("utf-8", { fatal: true }).decode(identity)))
      throw new Error("identity");
    const jwk = FederationMediaRecipientKeySchema.parse(recipient);
    const key = await importJWK(jwk, "RSA-OAEP-256");
    if (
      !(key instanceof CryptoKey) ||
      key.type !== "public" ||
      !("modulusLength" in key.algorithm) ||
      typeof key.algorithm.modulusLength !== "number" ||
      key.algorithm.modulusLength < 2048 ||
      key.algorithm.modulusLength > 4096
    )
      throw new Error("key");
    return await new CompactEncrypt(identity)
      .setProtectedHeader(
        Header.parse({ alg: "RSA-OAEP-256", enc: "A256GCM", typ: "kq-media-key+jwe", queryDigest }),
      )
      .encrypt(key);
  } catch {
    throw new FederationError("INVALID_MESSAGE");
  }
}

/** Call only after checking the signed grant and current local import authorization. */
export async function decryptFederationMediaIdentity(
  envelope: string,
  key: CryptoKey,
  queryDigest: string,
): Promise<Uint8Array> {
  let plaintext: Uint8Array | undefined;
  try {
    if (envelope.length > 4096 || key.type !== "private") throw new Error("envelope");
    const result = await compactDecrypt(envelope, key, {
      keyManagementAlgorithms: ["RSA-OAEP-256"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    plaintext = result.plaintext;
    if (
      Header.parse(result.protectedHeader).queryDigest !== queryDigest ||
      !Identity.test(new TextDecoder("utf-8", { fatal: true }).decode(plaintext))
    )
      throw new Error("binding");
    return plaintext;
  } catch {
    plaintext?.fill(0);
    throw new FederationError("INVALID_MESSAGE");
  }
}
