import { createHash } from "node:crypto";
import { CompactSign, compactVerify, importSPKI } from "jose";
import { z } from "zod";
import { FederationError } from "./index";

const HeaderSchema = z.strictObject({
  alg: z.literal("RS256"),
  typ: z.literal("kq-federation+jws"),
  v: z.literal(1),
  kid: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_.:-]+$/),
});
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const maxMessageBytes = 262_144;

/** An untrusted lookup hint only. Verification still checks the exact protected header. */
export function federationMessageKeyId(jws: string): string {
  try {
    if (jws.length > maxMessageBytes * 2 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(jws))
      throw new FederationError("INVALID_MESSAGE");
    const header = jws.split(".")[0];
    if (!header || header.length > 1024) throw new FederationError("INVALID_MESSAGE");
    return HeaderSchema.parse(parseWireJson(Buffer.from(header, "base64url"))).kid;
  } catch {
    throw new FederationError("INVALID_MESSAGE");
  }
}

export interface FederationSigningKey {
  siteId: string;
  keyId: string;
  privateKey: CryptoKey;
}

/** Supplied by the local trust registry, never by an incoming JWK/header/URL. */
export interface FederationVerificationKey {
  siteId: string;
  keyId: string;
  publicKey: CryptoKey;
  validFrom: Date;
  validUntil: Date;
  revoked: boolean;
  allowedKinds: readonly (
    | "agreement"
    | "delegation"
    | "acceptance"
    | "evidence-batch"
    | "status-query"
    | "status-report"
    | "cancellation"
    | "cancellation-receipt"
    | "result-query"
    | "result-report"
    | "result-download-query"
    | "result-download-grant"
    | "result-receipt"
    | "result-receipt-ack"
  )[];
}

// This wire format requires compact JSON, preserving property order. The equality rejects duplicate
// keys (including escaped aliases), lossy numeric encodings and non-canonical escape spellings.
function parseWireJson(bytes: Uint8Array): unknown {
  const text = decoder.decode(bytes);
  const value: unknown = JSON.parse(text);
  if (JSON.stringify(value) !== text) throw new FederationError("INVALID_MESSAGE");
  return value;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function signFederationMessage<T>(
  schema: z.ZodType<T>,
  payload: T,
  key: FederationSigningKey,
): Promise<string> {
  const validated = schema.parse(payload);
  const bytes = encoder.encode(JSON.stringify(validated));
  if (bytes.length > maxMessageBytes) throw new FederationError("INVALID_MESSAGE");
  const header = HeaderSchema.parse({
    alg: "RS256",
    typ: "kq-federation+jws",
    v: 1,
    kid: key.keyId,
  });
  return new CompactSign(bytes).setProtectedHeader(header).sign(key.privateKey);
}

export async function verifyFederationMessage<T extends { kind: string }>(
  schema: z.ZodType<T>,
  jws: string,
  key: FederationVerificationKey,
  now: Date,
): Promise<{ payload: T; digest: string; jws: string }> {
  if (
    key.revoked ||
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(key.validFrom.getTime()) ||
    !Number.isFinite(key.validUntil.getTime()) ||
    now < key.validFrom ||
    now >= key.validUntil
  )
    throw new FederationError("UNTRUSTED_IDENTITY");
  try {
    if (federationMessageKeyId(jws) !== key.keyId) throw new FederationError("UNTRUSTED_IDENTITY");
    const result = await compactVerify(jws, key.publicKey, { algorithms: ["RS256"] });
    if (result.payload.length > maxMessageBytes) throw new FederationError("INVALID_MESSAGE");
    const payload = schema.parse(parseWireJson(result.payload));
    if (!key.allowedKinds.some((kind) => kind === payload.kind))
      throw new FederationError("UNTRUSTED_IDENTITY");
    return {
      payload,
      digest: digest(result.payload),
      jws,
    };
  } catch (error) {
    if (error instanceof FederationError) throw error;
    // Parser/crypto errors can contain private input. Expose only the protocol error code.
    throw new FederationError("INVALID_MESSAGE");
  }
}

export async function parseFederationPublicKey(pem: string): Promise<CryptoKey> {
  try {
    const key = await importSPKI(pem, "RS256", { extractable: true });
    const algorithm = key.algorithm;
    if (
      algorithm.name !== "RSASSA-PKCS1-v1_5" ||
      !("modulusLength" in algorithm) ||
      typeof algorithm.modulusLength !== "number" ||
      algorithm.modulusLength < 2048
    )
      throw new Error("Invalid RSA key");
    return key;
  } catch {
    throw new FederationError("INVALID_MESSAGE");
  }
}
