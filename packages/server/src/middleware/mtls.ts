import { createHash } from "node:crypto";
import forge from "node-forge";

/**
 * Server mTLS verifier for incoming connectRPC streams.
 *
 * The Bun.serve TLS layer presents the client's leaf certificate (PEM) on
 * each connection. This module turns that PEM into a verified `agentId`
 * (or a rejection reason) by:
 *   1. parsing the cert,
 *   2. checking expiry,
 *   3. verifying the chain against the Server's own CA,
 *   4. computing the fingerprint and looking it up in `agent_certs`,
 *   5. rejecting if the row is revoked.
 *
 * Step 4–5 close the trust hole where the gRPC handler was previously
 * believing the agentId from `RegisterRequest.agentId` — the verified
 * fingerprint is now the source of truth and the handler is expected to
 * pin its `agentId` to the verifier output.
 *
 * Out of scope for B3: CRL/OCSP, intermediate CAs, hot-reload of trusted
 * roots, hardware-backed keys.
 */
export interface MtlsVerifyInput {
  readonly peerCertPem: string | null;
}

export type MtlsVerifyResult =
  | { readonly ok: true; readonly agentId: string; readonly fingerprintSha256: string }
  | { readonly ok: false; readonly reason: string };

export interface AgentCertLookupRow {
  readonly agentId: string;
  readonly revokedAt: Date | null;
}

/**
 * Side-effect-free lookup signature: given a fingerprint, return the
 * `agent_certs` row (or null when no such cert is on file).
 */
export type AgentCertLookup = (fingerprintSha256: string) => Promise<AgentCertLookupRow | null>;

export interface MtlsVerifierConfig {
  readonly caCertPem: string;
  readonly lookup: AgentCertLookup;
}

export type MtlsVerifier = (input: MtlsVerifyInput) => Promise<MtlsVerifyResult>;

export function createMtlsVerifier(config: MtlsVerifierConfig): MtlsVerifier {
  const caCert = forge.pki.certificateFromPem(config.caCertPem);
  const caStore = forge.pki.createCaStore([caCert]);

  return async function verify(input: MtlsVerifyInput): Promise<MtlsVerifyResult> {
    const peerPem = input.peerCertPem;
    if (!peerPem || peerPem.trim().length === 0) {
      return { ok: false, reason: "no client certificate presented" };
    }

    let cert: forge.pki.Certificate;
    try {
      cert = forge.pki.certificateFromPem(peerPem);
    } catch (err) {
      return {
        ok: false,
        reason: `malformed peer cert PEM: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const now = new Date();
    if (now < cert.validity.notBefore) {
      return { ok: false, reason: "client cert not yet valid" };
    }
    if (now > cert.validity.notAfter) {
      return { ok: false, reason: "client cert expired" };
    }

    try {
      forge.pki.verifyCertificateChain(caStore, [cert]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `chain verification failed: untrusted issuer (${msg})` };
    }

    const fingerprintSha256 = computeFingerprint(cert);
    const row = await config.lookup(fingerprintSha256);
    if (!row) {
      return { ok: false, reason: "unknown client cert: not in agent_certs ledger" };
    }
    if (row.revokedAt) {
      return {
        ok: false,
        reason: `client cert revoked at ${row.revokedAt.toISOString()}`,
      };
    }

    return { ok: true, agentId: row.agentId, fingerprintSha256 };
  };
}

/** Hex SHA-256 over DER cert bytes. Mirrors cert-issuer.computeFingerprint. */
function computeFingerprint(cert: forge.pki.Certificate): string {
  const asn1 = forge.pki.certificateToAsn1(cert);
  const derBytes = forge.asn1.toDer(asn1).getBytes();
  return createHash("sha256").update(Buffer.from(derBytes, "binary")).digest("hex");
}
