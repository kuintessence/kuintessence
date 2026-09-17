import { createHash, randomBytes, sign } from "node:crypto";
import {
  canonicalJson,
  type SandboxSignedManifest,
  SandboxSignedManifestSchema,
  type SandboxUnsignedManifest,
  SandboxUnsignedManifestSchema,
} from "@kuintessence/shared";

export function sandboxSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sandboxBundleSha256(
  script: Pick<SandboxUnsignedManifest["script"], "language" | "entrypoint" | "sha256">,
): string {
  return sandboxSha256(
    canonicalJson({
      language: script.language,
      entrypoint: script.entrypoint,
      sha256: script.sha256,
    }),
  );
}

export interface SandboxManifestSignerOptions {
  keyId: string;
  privateKeyPem: string;
  ttlMs?: number;
  now?: () => number;
  nonce?: () => string;
}

export class SandboxManifestSigner {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(private readonly options: SandboxManifestSignerOptions) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(24).toString("base64url"));
    if (this.ttlMs <= 0 || this.ttlMs > 15 * 60_000) {
      throw new Error("Sandbox manifest TTL must be between 1 ms and 15 minutes");
    }
  }

  sign(unsignedInput: SandboxUnsignedManifest): SandboxSignedManifest {
    const unsigned = SandboxUnsignedManifestSchema.parse(unsignedInput);
    const content = Buffer.from(unsigned.script.contentBase64, "base64");
    if (sandboxSha256(content) !== unsigned.script.sha256) {
      throw new Error("Sandbox script content hash mismatch");
    }
    if (sandboxBundleSha256(unsigned.script) !== unsigned.script.bundleSha256) {
      throw new Error("Sandbox script bundle hash mismatch");
    }
    const manifestJson = canonicalJson(unsigned);
    const manifestSha256 = sandboxSha256(manifestJson);
    const issuedAtUnixMs = this.now();
    return SandboxSignedManifestSchema.parse({
      ...unsigned,
      envelope: {
        keyId: this.options.keyId,
        nonce: this.nonce(),
        issuedAtUnixMs,
        expiresAtUnixMs: issuedAtUnixMs + this.ttlMs,
        manifestSha256,
        signatureBase64: sign(null, Buffer.from(manifestJson), this.options.privateKeyPem).toString(
          "base64",
        ),
      },
    });
  }
}
