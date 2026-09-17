import type { IssuedCertView } from "../routes/admin-agents";
import type { CaMaterial } from "./ca";
import { issueAgentCert } from "./cert-issuer";

/**
 * concrete CertIssuanceService backed by a pluggable store.
 *
 * The store interface is intentionally narrow so tests can fake it without
 * spinning a real PG. The PG-backed implementation lives in
 * `cert-store.ts`.
 */
export interface CertStore {
  listByAgent(agentId: string): Promise<
    Array<{
      id: string;
      fingerprintSha256: string;
      subjectCn: string;
      issuedAt: Date;
      expiresAt: Date;
      revokedAt: Date | null;
      issuedBy: string | null;
    }>
  >;
  insertCert(row: {
    agentId: string;
    fingerprintSha256: string;
    subjectCn: string;
    certPem: string;
    expiresAt: Date;
    revokedAt: Date | null;
    issuedBy: string | null;
  }): Promise<void>;
  revokeByFingerprint(fingerprintSha256: string, revokedAt: Date): Promise<void>;
  appendAudit(entry: {
    actor: string;
    action: string;
    target: string;
    diff: { before?: unknown; after?: unknown } | null;
  }): Promise<void>;
}

export interface CreateCertIssuanceServiceDeps {
  readonly ca: CaMaterial;
  readonly store: CertStore;
}

export function createCertIssuanceService(deps: CreateCertIssuanceServiceDeps) {
  const { ca, store } = deps;

  return {
    async listCerts(agentId: string) {
      return store.listByAgent(agentId);
    },

    async issueCert(input: {
      agentId: string;
      csrPem: string;
      issuedBy: string;
    }): Promise<IssuedCertView> {
      // issueAgentCert throws on CN mismatch / bad signature / malformed PEM.
      // We let it bubble so the route maps it to a 400 — and we deliberately
      // do NOT touch the store before the cert is signed, so a failed CSR
      // leaves no orphan ledger or audit row.
      const issued = issueAgentCert({
        ca,
        csrPem: input.csrPem,
        agentId: input.agentId,
      });

      await store.insertCert({
        agentId: input.agentId,
        fingerprintSha256: issued.fingerprintSha256,
        subjectCn: issued.subjectCn,
        certPem: issued.certPem,
        expiresAt: issued.expiresAt,
        revokedAt: null,
        issuedBy: input.issuedBy,
      });

      await store.appendAudit({
        actor: input.issuedBy,
        action: "agent_cert_issued",
        target: input.agentId,
        diff: {
          after: {
            fingerprint: issued.fingerprintSha256,
            expiresAt: issued.expiresAt.toISOString(),
          },
        },
      });

      return {
        certPem: issued.certPem,
        caCertPem: ca.certPem,
        fingerprintSha256: issued.fingerprintSha256,
        issuedAt: issued.issuedAt,
        expiresAt: issued.expiresAt,
      };
    },

    async revokeCert(input: {
      agentId: string;
      fingerprintSha256: string;
      revokedBy: string;
      reason?: string;
    }): Promise<void> {
      const revokedAt = new Date();
      const after: Record<string, string> = {
        fingerprint: input.fingerprintSha256,
        revokedAt: revokedAt.toISOString(),
      };
      if (input.reason) after.reason = input.reason;
      await store.revokeByFingerprint(input.fingerprintSha256, revokedAt);
      await store.appendAudit({
        actor: input.revokedBy,
        action: "agent_cert_revoked",
        target: input.agentId,
        diff: {
          after,
        },
      });
    },
  };
}
