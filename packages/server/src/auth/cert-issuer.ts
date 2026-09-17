import { createHash } from "node:crypto";
import forge from "node-forge";
import type { CaMaterial } from "./ca";
import { randomSerial } from "./cert-serial";

/**
 * Server-side CSR signer.
 *
 * Validates an Agent-submitted CSR and issues a 1-year client cert signed by
 * the Server CA (`CaMaterial`). The cert's subject CN equals `agentId`; the
 * SAN dnsName is also the `agentId` so the connectRPC mTLS verifier can
 * map verified peer certs back to an agent without trusting the
 * RegisterRequest body.
 */
export interface IssueAgentCertInput {
  readonly ca: CaMaterial;
  readonly csrPem: string;
  /** Authoritative agentId from the Server-side admin route. */
  readonly agentId: string;
}

export interface IssuedAgentCert {
  readonly certPem: string;
  /** Hex-encoded SHA-256 fingerprint of DER cert bytes. */
  readonly fingerprintSha256: string;
  /** Subject CN actually written into the cert. */
  readonly subjectCn: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

const CLIENT_CERT_VALIDITY_DAYS = 365;

export function issueAgentCert(input: IssueAgentCertInput): IssuedAgentCert {
  const { ca, csrPem, agentId } = input;

  // Parse + verify CSR signature. node-forge throws on malformed PEM.
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  if (!csr.verify()) {
    throw new Error("CSR signature is invalid");
  }

  // CN must match agentId. Defense in depth: the admin route also pins
  // the agentId from URL param, but we re-check here so this function is
  // safe to call from other code paths.
  const cnAttr = csr.subject.getField("CN") as { value?: string } | null;
  const csrCn = cnAttr?.value;
  if (csrCn !== agentId) {
    throw new Error(`CSR CN mismatch: csr=${csrCn ?? "<none>"}, expected=${agentId}`);
  }

  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);

  const cert = forge.pki.createCertificate();
  if (!csr.publicKey) {
    throw new Error("CSR has no public key");
  }
  cert.publicKey = csr.publicKey;
  cert.serialNumber = randomSerial();

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt);
  expiresAt.setDate(expiresAt.getDate() + CLIENT_CERT_VALIDITY_DAYS);
  cert.validity.notBefore = issuedAt;
  cert.validity.notAfter = expiresAt;

  cert.setSubject([
    { name: "commonName", value: agentId },
    { name: "organizationName", value: "Kuintessence" },
  ]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", clientAuth: true, critical: false },
    {
      name: "subjectAltName",
      altNames: [{ type: 2 /* dNSName */, value: agentId }],
    },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const fingerprintSha256 = computeFingerprint(cert);

  return {
    certPem,
    fingerprintSha256,
    subjectCn: agentId,
    issuedAt,
    expiresAt,
  };
}

/**
 * Compute hex SHA-256 over the DER encoding of the certificate.
 * Matches `openssl x509 -fingerprint -sha256 -noout` (sans colons).
 */
function computeFingerprint(cert: forge.pki.Certificate): string {
  const asn1 = forge.pki.certificateToAsn1(cert);
  const derBytes = forge.asn1.toDer(asn1).getBytes();
  const buf = Buffer.from(derBytes, "binary");
  return createHash("sha256").update(buf).digest("hex");
}
