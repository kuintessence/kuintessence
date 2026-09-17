import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { ensureCa } from "./ca";
import { createCertIssuanceService } from "./cert-service";

interface InsertedCert {
  agentId: string;
  fingerprintSha256: string;
  subjectCn: string;
  certPem: string;
  expiresAt: Date;
  revokedAt: Date | null;
  issuedBy: string | null;
}

interface AuditEntry {
  actor: string;
  action: string;
  target: string;
  diff: { before?: unknown; after?: unknown } | null;
}

function fakeStore() {
  const certs: InsertedCert[] = [];
  const audits: AuditEntry[] = [];
  return {
    certs,
    audits,
    listByAgent: async (agentId: string) =>
      certs
        .filter((cert) => cert.agentId === agentId)
        .map((cert, idx) => ({
          id: `cert-${idx}`,
          fingerprintSha256: cert.fingerprintSha256,
          subjectCn: cert.subjectCn,
          issuedAt: new Date("2026-01-01T00:00:00Z"),
          expiresAt: cert.expiresAt,
          revokedAt: cert.revokedAt,
          issuedBy: cert.issuedBy,
        })),
    insertCert: async (row: InsertedCert) => {
      certs.push(row);
    },
    revokeByFingerprint: async (fp: string, _at: Date) => {
      const row = certs.find((c) => c.fingerprintSha256 === fp);
      if (row) row.revokedAt = _at;
    },
    appendAudit: async (entry: AuditEntry) => {
      audits.push(entry);
    },
  };
}

function genCsr(cn: string): string {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: cn }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

describe("createCertIssuanceService", () => {
  test("issues a cert, persists ledger row, and writes audit entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kq-cert-svc-"));
    try {
      const ca = await ensureCa(dir);
      const store = fakeStore();
      const svc = createCertIssuanceService({ ca, store });

      const csrPem = genCsr("agent-q");
      const view = await svc.issueCert({
        agentId: "agent-q",
        csrPem,
        issuedBy: "user-7",
      });

      expect(view.certPem).toContain("BEGIN CERTIFICATE");
      expect(view.caCertPem).toBe(ca.certPem);
      expect(view.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);

      expect(store.certs.length).toBe(1);
      expect(store.certs[0]?.agentId).toBe("agent-q");
      expect(store.certs[0]?.subjectCn).toBe("agent-q");
      expect(store.certs[0]?.fingerprintSha256).toBe(view.fingerprintSha256);
      expect(store.certs[0]?.revokedAt).toBeNull();
      expect(store.certs[0]?.issuedBy).toBe("user-7");

      expect(store.audits.length).toBe(1);
      expect(store.audits[0]?.action).toBe("agent_cert_issued");
      expect(store.audits[0]?.actor).toBe("user-7");
      expect(store.audits[0]?.target).toBe("agent-q");
      // Audit diff records the fingerprint, NOT the cert PEM (PEM is fine but
      // verbose; fingerprint is the durable identifier).
      expect((store.audits[0]?.diff?.after as { fingerprint?: string })?.fingerprint).toBe(
        view.fingerprintSha256,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("revokeCert sets revokedAt and audits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kq-cert-svc-"));
    try {
      const ca = await ensureCa(dir);
      const store = fakeStore();
      const svc = createCertIssuanceService({ ca, store });
      const csrPem = genCsr("agent-revoke-me");
      const view = await svc.issueCert({
        agentId: "agent-revoke-me",
        csrPem,
        issuedBy: "user-1",
      });

      await svc.revokeCert({
        agentId: "agent-revoke-me",
        fingerprintSha256: view.fingerprintSha256,
        revokedBy: "user-1",
        reason: "key rotated",
      });

      expect(store.certs[0]?.revokedAt).toBeInstanceOf(Date);
      expect(store.audits.length).toBe(2);
      expect(store.audits[1]?.action).toBe("agent_cert_revoked");
      expect((store.audits[1]?.diff?.after as { reason?: string })?.reason).toBe("key rotated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listCerts returns metadata for one agent without cert PEM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kq-cert-svc-"));
    try {
      const ca = await ensureCa(dir);
      const store = fakeStore();
      const svc = createCertIssuanceService({ ca, store });
      await svc.issueCert({
        agentId: "agent-list",
        csrPem: genCsr("agent-list"),
        issuedBy: "user-1",
      });
      await svc.issueCert({
        agentId: "agent-other",
        csrPem: genCsr("agent-other"),
        issuedBy: "user-1",
      });

      const certs = await svc.listCerts("agent-list");

      expect(certs.length).toBe(1);
      expect(certs[0]?.subjectCn).toBe("agent-list");
      expect("certPem" in (certs[0] ?? {})).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("propagates issuer error (e.g. CN mismatch) without writing ledger or audit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kq-cert-svc-"));
    try {
      const ca = await ensureCa(dir);
      const store = fakeStore();
      const svc = createCertIssuanceService({ ca, store });
      const csrPem = genCsr("attacker");

      await expect(
        svc.issueCert({ agentId: "victim", csrPem, issuedBy: "user-1" }),
      ).rejects.toThrow();
      expect(store.certs.length).toBe(0);
      expect(store.audits.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
