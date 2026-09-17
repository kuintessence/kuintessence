import { createHash } from "node:crypto";
import forge from "node-forge";

/**
 * compute a hex-encoded SHA-256 fingerprint of a PEM cert.
 * Matches the Server's `cert-issuer.computeFingerprint` byte-for-byte so
 * the Agent can stamp every gRPC request with a fingerprint the Server
 * looks up against the `agent_certs` ledger.
 */
export function fingerprintOfPem(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const asn1 = forge.pki.certificateToAsn1(cert);
  const derBytes = forge.asn1.toDer(asn1).getBytes();
  return createHash("sha256").update(Buffer.from(derBytes, "binary")).digest("hex");
}
