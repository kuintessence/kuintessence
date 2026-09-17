import forge from "node-forge";

/**
 * Agent CSR + private key generation.
 *
 * Pure: no I/O. Persistence is the cert-store's job. The Agent generates a
 * fresh keypair on first start, ships the CSR to the Server via the admin
 * cert-issuance endpoint, and persists the resulting cert plus the private
 * key under `${AGENT_CERT_DIR}/`.
 *
 * Hardware-backed keys (PKCS#11) and key rotation are not supported here.
 * A lost key requires regenerating the key material and re-enrolling.
 */
export interface CsrResult {
  readonly csrPem: string;
  readonly privateKeyPem: string;
}

const KEY_BITS = 2048;

export function generateCsr(input: { agentId: string }): CsrResult {
  if (!input.agentId || input.agentId.trim() === "") {
    throw new Error("agentId is required for CSR generation");
  }

  const keys = forge.pki.rsa.generateKeyPair({ bits: KEY_BITS });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: input.agentId }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  return {
    csrPem: forge.pki.certificationRequestToPem(csr),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
