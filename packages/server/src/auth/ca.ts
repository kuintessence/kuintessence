import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import forge from "node-forge";
import { randomSerial } from "./cert-serial";

/**
 * Server self-signed Certificate Authority.
 *
 * On first start (CA absent on disk), generate a self-signed CA cert + RSA
 * private key. Persist to `${SERVER_CA_DIR}/{ca.crt, ca.key}` so subsequent
 * Server restarts re-use the same authority. Idempotent.
 *
 * This helper creates a development-grade self-signed authority.
 * Production CA provisioning requires separate operator configuration.
 * CRL/OCSP are not implemented; see `agent_certs.revoked_at` for revocation.
 */
export interface CaMaterial {
  /** PEM-encoded self-signed CA certificate. */
  readonly certPem: string;
  /** PEM-encoded RSA private key (PKCS#8). NEVER log this. */
  readonly keyPem: string;
}

/** CA validity (5 years) — well above the 1y agent cert validity. */
const CA_VALIDITY_YEARS = 5;
const CA_KEY_BITS = 2048;
const CA_COMMON_NAME = "Kuintessence Server CA";

const CA_CERT_FILE = "ca.crt";
const CA_KEY_FILE = "ca.key";

/**
 * Load existing CA material, or null when neither file exists.
 *
 * Throws when exactly one of the two files exists — that's a corrupt
 * half-state that a fresh `ensureCa()` would otherwise paper over with a
 * brand new CA, silently invalidating every previously issued agent cert.
 */
export async function loadCa(dir: string): Promise<CaMaterial | null> {
  const certPath = join(dir, CA_CERT_FILE);
  const keyPath = join(dir, CA_KEY_FILE);
  const certExists = existsSync(certPath);
  const keyExists = existsSync(keyPath);

  if (!certExists && !keyExists) return null;
  if (certExists !== keyExists) {
    throw new Error(
      `corrupt CA state in ${dir}: one of {ca.crt, ca.key} is missing — refuse to regenerate`,
    );
  }

  const [certPem, keyPem] = await Promise.all([
    readFile(certPath, "utf8"),
    readFile(keyPath, "utf8"),
  ]);
  return { certPem, keyPem };
}

/**
 * Load existing CA, or generate + persist a fresh one. Returns whichever
 * the directory now contains. Safe to call on every Server boot.
 */
export async function ensureCa(dir: string): Promise<CaMaterial> {
  const existing = await loadCa(dir);
  if (existing) return existing;

  await mkdir(dir, { recursive: true });
  const fresh = generateCa();
  await Promise.all([
    writeFile(join(dir, CA_CERT_FILE), fresh.certPem, { mode: 0o644 }),
    writeFile(join(dir, CA_KEY_FILE), fresh.keyPem, { mode: 0o600 }),
  ]);
  return fresh;
}

/**
 * Generate a fresh self-signed CA. Pure — no I/O.
 */
function generateCa(): CaMaterial {
  const keys = forge.pki.rsa.generateKeyPair({ bits: CA_KEY_BITS });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + CA_VALIDITY_YEARS);

  const attrs = [
    { name: "commonName", value: CA_COMMON_NAME },
    { name: "organizationName", value: "Kuintessence" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
      critical: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
