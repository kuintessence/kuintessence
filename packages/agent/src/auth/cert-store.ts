import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Agent on-disk cert bundle (`AGENT_CERT_DIR`).
 *
 * Bundle layout:
 *   client.crt — PEM cert signed by the Server CA
 *   client.key — PEM private key (mode 0600)
 *   ca.crt     — PEM CA bundle the Agent must trust (i.e. the Server CA cert)
 *
 * Pure file I/O. The enrollment workflow (CSR -> Server -> sign -> persist)
 * lives in `bootstrap.ts`.
 */
export interface CertBundle {
  readonly certPem: string;
  readonly keyPem: string;
  readonly caCertPem: string;
}

const CLIENT_CERT = "client.crt";
const CLIENT_KEY = "client.key";
const CA_CERT = "ca.crt";

export function hasCert(dir: string): boolean {
  return (
    existsSync(join(dir, CLIENT_CERT)) &&
    existsSync(join(dir, CLIENT_KEY)) &&
    existsSync(join(dir, CA_CERT))
  );
}

export async function persistCertBundle(dir: string, bundle: CertBundle): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, CLIENT_CERT), bundle.certPem, { mode: 0o644 }),
    writeFile(join(dir, CLIENT_KEY), bundle.keyPem, { mode: 0o600 }),
    writeFile(join(dir, CA_CERT), bundle.caCertPem, { mode: 0o644 }),
  ]);
}

export async function loadCertBundle(dir: string): Promise<CertBundle> {
  const certPath = join(dir, CLIENT_CERT);
  const keyPath = join(dir, CLIENT_KEY);
  const caPath = join(dir, CA_CERT);
  const presence = [existsSync(certPath), existsSync(keyPath), existsSync(caPath)];
  if (!presence.every(Boolean)) {
    if (presence.some(Boolean)) {
      throw new Error(
        `agent cert bundle in ${dir} is corrupt: not all of {client.crt, client.key, ca.crt} exist`,
      );
    }
    throw new Error(`agent cert bundle not found in ${dir}`);
  }
  const [certPem, keyPem, caCertPem] = await Promise.all([
    readFile(certPath, "utf8"),
    readFile(keyPath, "utf8"),
    readFile(caPath, "utf8"),
  ]);
  return { certPem, keyPem, caCertPem };
}
