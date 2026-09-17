import { agentCerts, type PgDb } from "@kuintessence/db";
import { desc, eq } from "drizzle-orm";
import type { AgentCertLookup } from "../middleware/mtls";
import { writeAudit } from "../services/audit-log-writer";
import type { CertStore } from "./cert-service";

/**
 * PG-backed CertStore + AgentCertLookup.
 *
 * Two narrow adapters around `agent_certs` and `audit_log`:
 *   - `createPgCertStore` is the write side (insert / revoke / audit)
 *   - `createPgAgentCertLookup` is the read side, used by the mTLS verifier
 */
export function createPgCertStore(db: PgDb): CertStore {
  return {
    async listByAgent(agentId) {
      return db
        .select({
          id: agentCerts.id,
          fingerprintSha256: agentCerts.fingerprintSha256,
          subjectCn: agentCerts.subjectCn,
          issuedAt: agentCerts.issuedAt,
          expiresAt: agentCerts.expiresAt,
          revokedAt: agentCerts.revokedAt,
          issuedBy: agentCerts.issuedBy,
        })
        .from(agentCerts)
        .where(eq(agentCerts.agentId, agentId))
        .orderBy(desc(agentCerts.issuedAt));
    },

    async insertCert(row) {
      await db.insert(agentCerts).values({
        agentId: row.agentId,
        fingerprintSha256: row.fingerprintSha256,
        subjectCn: row.subjectCn,
        certPem: row.certPem,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        issuedBy: row.issuedBy,
      });
    },
    async revokeByFingerprint(fingerprintSha256, revokedAt) {
      await db
        .update(agentCerts)
        .set({ revokedAt })
        .where(eq(agentCerts.fingerprintSha256, fingerprintSha256));
    },
    async appendAudit(entry) {
      await writeAudit(db, entry);
    },
  };
}

export function createPgAgentCertLookup(db: PgDb): AgentCertLookup {
  return async (fingerprintSha256: string) => {
    const rows = await db
      .select({
        agentId: agentCerts.agentId,
        revokedAt: agentCerts.revokedAt,
      })
      .from(agentCerts)
      .where(eq(agentCerts.fingerprintSha256, fingerprintSha256))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { agentId: row.agentId, revokedAt: row.revokedAt };
  };
}
