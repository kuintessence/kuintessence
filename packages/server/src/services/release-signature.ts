import { createPublicKey, verify } from "node:crypto";
import { ecosystemCanonicalJson } from "@kuintessence/shared";

export function verifyReleaseSignature(
  binding: { manifest: Record<string, unknown>; signingKeyId: string; signature: string },
  trustedPublicKeys: Readonly<Record<string, string>>,
): boolean {
  try {
    const key = trustedPublicKeys[binding.signingKeyId];
    if (!key) return false;
    return verify(
      null,
      Buffer.from(ecosystemCanonicalJson(binding.manifest)),
      createPublicKey({
        key: Buffer.from(key, "base64"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(binding.signature, "base64"),
    );
  } catch {
    return false;
  }
}
