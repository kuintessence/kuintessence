/**
 * at-rest encryption for the OIDC client_secret (PRD F1.1).
 *
 * Uses Web Crypto (AES-GCM-256), which is available in Bun without any
 * extra deps. Output format is:
 *
 *   base64(version_byte=0x01 || iv[12] || ciphertext_with_tag)
 *
 * Key derivation:
 *   We derive the data key from a wrapping key via HKDF-SHA-256 with a
 *   stable info label `"kq-sso-secret-v1"`. The wrapping key source is
 *   `SSO_SECRET_KEY` if configured, otherwise `JWT_SECRET` (so single-
 *   binary dev deployments still work). Operators are encouraged to set
 *   a dedicated `SSO_SECRET_KEY` so the JWT signing key and the OIDC
 *   secret-encryption key can rotate independently — see
 *   `packages/server/src/config.ts`.
 *
 * We do NOT use a per-row salt: the singleton sso_config has a single
 * row, and HKDF is deterministic given the same wrapping key + info
 * label, which is what we need so the Server can decrypt across restarts
 * without storing key material in the row itself. If you ever extend
 * this to multi-tenant SSO (multiple rows), switch to a random salt
 * column and pass it through `info`.
 *
 * NOTE: this module deliberately exposes `encryptSecret` / `decryptSecret`
 * with a passed-in key instead of reading env directly so tests can
 * exercise edge cases (round-trip, tamper detection, version mismatch)
 * without setting process env.
 */

/**
 * Default HKDF info label (the original SSO domain). Callers that encrypt a
 * different class of secret pass their own `domain` so the derived AES key is
 * cryptographically separated: a wrapping-key compromise in one domain does
 * not let an attacker decrypt another domain's ciphertext, and a ciphertext
 * cannot be replayed across domains (the auth tag fails). SSH
 * credential vault uses `"kq-ssh-cred-v1"`.
 */
export const DEFAULT_SECRET_DOMAIN = "kq-sso-secret-v1";
const HKDF_SALT = new TextEncoder().encode("kq-sso-secret-salt-v1");
const VERSION_BYTE = 0x01;
const IV_LENGTH = 12;

async function deriveKey(wrappingKey: string, domain: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(wrappingKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: new TextEncoder().encode(domain),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Encrypt a UTF-8 plaintext into the canonical envelope format.
 * Returns "" when plaintext is empty (so unset secrets survive a round-trip
 * without ciphertext bloat).
 */
export async function encryptSecret(
  plaintext: string,
  wrappingKey: string,
  domain: string = DEFAULT_SECRET_DOMAIN,
): Promise<string> {
  if (plaintext.length === 0) return "";
  if (wrappingKey.length < 32) {
    throw new Error("Wrapping key must be at least 32 chars");
  }
  const key = await deriveKey(wrappingKey, domain);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(1 + IV_LENGTH + ct.byteLength);
  out[0] = VERSION_BYTE;
  out.set(iv, 1);
  out.set(ct, 1 + IV_LENGTH);
  return bytesToBase64(out);
}

/**
 * Inverse of `encryptSecret`. Returns "" for "" input. Throws on:
 *   - corrupt envelope (length / version)
 *   - wrong wrapping key (AES-GCM auth tag mismatch)
 */
export async function decryptSecret(
  envelope: string,
  wrappingKey: string,
  domain: string = DEFAULT_SECRET_DOMAIN,
): Promise<string> {
  if (envelope.length === 0) return "";
  if (wrappingKey.length < 32) {
    throw new Error("Wrapping key must be at least 32 chars");
  }
  const buf = base64ToBytes(envelope);
  if (buf.byteLength < 1 + IV_LENGTH + 16) {
    throw new Error("Invalid SSO secret envelope: too short");
  }
  if (buf[0] !== VERSION_BYTE) {
    throw new Error(
      `Invalid SSO secret envelope: unsupported version ${buf[0]}, expected ${VERSION_BYTE}`,
    );
  }
  const iv = buf.slice(1, 1 + IV_LENGTH);
  const ct = buf.slice(1 + IV_LENGTH);
  const key = await deriveKey(wrappingKey, domain);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
