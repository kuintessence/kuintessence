/**
 * PostgreSQL persistence adapter for the SSH credential vault.
 *
 * Kept separate from `ssh-credential-vault.ts` (which owns the crypto and the
 * storage-agnostic resolver) so the vault stays unit-testable without a DB and
 * the DB coupling lives in one place — the same split as
 * `secret-cipher` / `sso-config-store`.
 */

import { type PgDb, sshCredentials } from "@kuintessence/db";
import type { SshCredentialView } from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import {
  type EncryptedSshRow,
  encryptSshSecrets,
  type LoadSshRow,
  type SshSecretMaterial,
} from "./ssh-credential-vault";

/** Build the `loadRow` the vault resolver needs, reading from `ssh_credentials`. */
export function makePgSshRowLoader(db: PgDb): LoadSshRow {
  return async (agentId: string): Promise<EncryptedSshRow | null> => {
    const rows = await db
      .select()
      .from(sshCredentials)
      .where(eq(sshCredentials.agentId, agentId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      host: row.host,
      port: row.port,
      username: row.username,
      secretEncrypted: row.secretEncrypted,
      hostKeySha256: row.hostKeySha256,
    };
  };
}

export interface SaveSshCredentialInput {
  agentId: string;
  host: string;
  port: number;
  username: string;
  /** Plaintext auth material — encrypted here before it touches the row. */
  secret: SshSecretMaterial;
  /** Base64 SHA-256 host-key pin (clear); "" / omitted leaves the host unverified. */
  hostKeySha256?: string;
  updatedBy: string;
}

/**
 * Upsert one agent's SSH credentials, encrypting the secret material at rest.
 * Used by the (future) CP-admin route; the encryption happens here so callers
 * never persist plaintext.
 */
export async function saveSshCredential(
  db: PgDb,
  wrappingKey: string,
  input: SaveSshCredentialInput,
): Promise<void> {
  const secretEncrypted = await encryptSshSecrets(input.secret, wrappingKey);
  const row = {
    agentId: input.agentId,
    host: input.host,
    port: input.port,
    username: input.username,
    secretEncrypted,
    hostKeySha256: input.hostKeySha256 ?? "",
    updatedAt: new Date(),
    updatedBy: input.updatedBy,
  };
  await db
    .insert(sshCredentials)
    .values(row)
    .onConflictDoUpdate({
      target: sshCredentials.agentId,
      set: {
        host: row.host,
        port: row.port,
        username: row.username,
        secretEncrypted: row.secretEncrypted,
        hostKeySha256: row.hostKeySha256,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      },
    });
}

/** List configured agents WITHOUT any secret material — only `hasSecret`. */
export async function listSshCredentials(db: PgDb): Promise<SshCredentialView[]> {
  const rows = await db.select().from(sshCredentials);
  return sshCredentialViews(rows);
}

export async function listSshCredentialsByAgentIds(
  db: PgDb,
  agentIds: string[],
): Promise<SshCredentialView[]> {
  if (agentIds.length === 0) return [];
  const rows = await db
    .select()
    .from(sshCredentials)
    .where(inArray(sshCredentials.agentId, agentIds));
  return sshCredentialViews(rows);
}

function sshCredentialViews(rows: Array<typeof sshCredentials.$inferSelect>): SshCredentialView[] {
  return rows.map((r) => ({
    agentId: r.agentId,
    host: r.host,
    port: r.port,
    username: r.username,
    hasSecret: r.secretEncrypted.length > 0,
    hostKeySha256: r.hostKeySha256 ?? "",
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    updatedBy: r.updatedBy,
  }));
}

/** Remove an agent's stored credentials. Idempotent. */
export async function deleteSshCredential(db: PgDb, agentId: string): Promise<void> {
  await db.delete(sshCredentials).where(eq(sshCredentials.agentId, agentId));
}
