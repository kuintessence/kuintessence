/**
 * SSH credential vault (PRD F17).
 *
 * Replaces the not-for-production `SSH_CRED_<AGENT_ID>` env resolver
 * (`routes/ssh.ts` `envCredentialResolver`). The authentication material
 * (password / private key / passphrase) is encrypted at rest via
 * `secret-cipher` under the dedicated {@link SSH_CRED_DOMAIN} label, so it is
 * cryptographically isolated from the SSO client-secret domain. The connection
 * coordinates (host / port / username) are NOT secret and travel in the clear.
 *
 * This module is deliberately storage-agnostic: it owns only the crypto and the
 * resolver shape. The persistence row is supplied by an injected `loadRow`
 * function, so the vault is fully unit-testable without a database. In
 * production it is wired end-to-end: the `ssh_credentials` table backs
 * `makePgSshRowLoader` (`ssh-credential-store.ts`), and `index.ts` passes
 * `makeVaultResolver(loadRow, SSO_SECRET_KEY ?? JWT_SECRET)` as the route's
 * `resolveCredentials` dep when `NODE_ENV === "production"`; the dev env-mock
 * (`envCredentialResolver`) is the route default otherwise.
 */

import type { SshCredentials } from "../services/ssh-gateway";
import { decryptSecret, encryptSecret } from "./secret-cipher";

/** HKDF domain label — distinct from the SSO secret domain (key isolation). */
export const SSH_CRED_DOMAIN = "kq-ssh-cred-v1";

/** The secret half of an SSH credential — what gets encrypted at rest. */
export interface SshSecretMaterial {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** A persisted row: clear coordinates + the encrypted secret envelope. */
export interface EncryptedSshRow {
  host: string;
  port: number;
  username: string;
  /** Base64 AES-GCM envelope of the JSON `SshSecretMaterial`; "" when unset. */
  secretEncrypted: string;
  /** Base64 SHA-256 host-key pin (clear, not secret); absent/"" when unset. */
  hostKeySha256?: string;
}

/** Injected persistence read — returns the row for an agent, or null if none. */
export type LoadSshRow = (agentId: string) => Promise<EncryptedSshRow | null>;

/**
 * Encrypt the secret material into the at-rest envelope. Only defined,
 * non-empty fields are persisted. Returns "" when there is nothing to encrypt
 * (callers then store an empty `secret_encrypted`).
 */
export async function encryptSshSecrets(
  material: SshSecretMaterial,
  wrappingKey: string,
): Promise<string> {
  const payload: SshSecretMaterial = {};
  if (material.password) payload.password = material.password;
  if (material.privateKey) payload.privateKey = material.privateKey;
  if (material.passphrase) payload.passphrase = material.passphrase;
  if (Object.keys(payload).length === 0) return "";
  return encryptSecret(JSON.stringify(payload), wrappingKey, SSH_CRED_DOMAIN);
}

/**
 * Reassemble full {@link SshCredentials} from a persisted row by decrypting the
 * secret envelope and merging it with the clear coordinates. A row with an empty
 * `secretEncrypted` yields credentials with no auth material — the SSH handler
 * then closes the session with "auth payload missing", which is the correct
 * behaviour for a misconfigured vault entry.
 */
export async function decryptSshRow(
  row: EncryptedSshRow,
  wrappingKey: string,
): Promise<SshCredentials> {
  const base: SshCredentials = { host: row.host, port: row.port, username: row.username };
  if (row.hostKeySha256) base.hostKeySha256 = row.hostKeySha256;
  if (!row.secretEncrypted) return base;
  const json = await decryptSecret(row.secretEncrypted, wrappingKey, SSH_CRED_DOMAIN);
  const material = JSON.parse(json) as SshSecretMaterial;
  if (material.password) base.password = material.password;
  if (material.privateKey) base.privateKey = material.privateKey;
  if (material.passphrase) base.passphrase = material.passphrase;
  return base;
}

/**
 * Build a `resolveCredentials` function backed by the encrypted vault. The
 * returned resolver is async (the route awaits it); it returns null when the
 * agent has no stored credentials so the route closes the WebSocket with 4404,
 * exactly as the env-mock path did.
 */
export function makeVaultResolver(
  loadRow: LoadSshRow,
  wrappingKey: string,
): (agentId: string) => Promise<SshCredentials | null> {
  return async (agentId: string) => {
    const row = await loadRow(agentId);
    if (!row) return null;
    return decryptSshRow(row, wrappingKey);
  };
}
