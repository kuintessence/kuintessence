import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { ensureCa } from "../auth/ca";
import { issueAgentCert } from "../auth/cert-issuer";
import { type AgentCertLookup, createMtlsVerifier } from "./mtls";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kq-mtls-"));
}

/** Stub lookup keyed by fingerprint with optional revocation. */
function lookupOf(
  certs: { fingerprint: string; agentId: string; revoked?: boolean }[],
): AgentCertLookup {
  return async (fp: string) => {
    const row = certs.find((r) => r.fingerprint === fp);
    if (!row) return null;
    return {
      agentId: row.agentId,
      revokedAt: row.revoked ? new Date() : null,
    };
  };
}

function genCsr(cn: string): { csrPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: cn }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    csrPem: forge.pki.certificationRequestToPem(csr),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe("mTLS verifier", () => {
  test("accepts a chain-valid, ledger-known, non-revoked cert and returns agentId", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const { csrPem } = genCsr("agent-good");
      const issued = issueAgentCert({ ca, csrPem, agentId: "agent-good" });

      const verifier = createMtlsVerifier({
        caCertPem: ca.certPem,
        lookup: lookupOf([{ fingerprint: issued.fingerprintSha256, agentId: "agent-good" }]),
      });

      const result = await verifier({ peerCertPem: issued.certPem });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.agentId).toBe("agent-good");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a cert signed by a different CA", async () => {
    const dirA = tmp();
    const dirB = tmp();
    try {
      const caA = await ensureCa(dirA);
      const caB = await ensureCa(dirB);
      const { csrPem } = genCsr("agent-rogue");
      const rogueCert = issueAgentCert({ ca: caB, csrPem, agentId: "agent-rogue" });

      const verifier = createMtlsVerifier({
        caCertPem: caA.certPem,
        lookup: lookupOf([{ fingerprint: rogueCert.fingerprintSha256, agentId: "agent-rogue" }]),
      });

      const result = await verifier({ peerCertPem: rogueCert.certPem });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/chain|issuer|untrusted/i);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test("rejects a cert not present in the ledger (e.g. issued elsewhere with same CA)", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const { csrPem } = genCsr("ghost");
      const ghost = issueAgentCert({ ca, csrPem, agentId: "ghost" });

      const verifier = createMtlsVerifier({
        caCertPem: ca.certPem,
        lookup: lookupOf([]), // empty ledger
      });

      const result = await verifier({ peerCertPem: ghost.certPem });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/unknown|not registered|no ledger/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a revoked cert", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const { csrPem } = genCsr("agent-revoked");
      const issued = issueAgentCert({ ca, csrPem, agentId: "agent-revoked" });

      const verifier = createMtlsVerifier({
        caCertPem: ca.certPem,
        lookup: lookupOf([
          { fingerprint: issued.fingerprintSha256, agentId: "agent-revoked", revoked: true },
        ]),
      });

      const result = await verifier({ peerCertPem: issued.certPem });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/revoked/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an expired cert", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const caCert = forge.pki.certificateFromPem(ca.certPem);
      const caKey = forge.pki.privateKeyFromPem(ca.keyPem);

      // Hand-craft an already-expired cert
      const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = "01";
      cert.validity.notBefore = new Date(Date.now() - 2 * 24 * 3600 * 1000);
      cert.validity.notAfter = new Date(Date.now() - 24 * 3600 * 1000);
      cert.setSubject([{ name: "commonName", value: "agent-exp" }]);
      cert.setIssuer(caCert.subject.attributes);
      cert.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "extKeyUsage", clientAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: "agent-exp" }] },
      ]);
      cert.sign(caKey, forge.md.sha256.create());
      const certPem = forge.pki.certificateToPem(cert);

      const verifier = createMtlsVerifier({
        caCertPem: ca.certPem,
        lookup: lookupOf([
          { fingerprint: "deadbeef".repeat(8), agentId: "agent-exp" }, // doesn't matter — should reject before lookup
        ]),
      });

      const result = await verifier({ peerCertPem: certPem });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/expired/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed peer cert PEM", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const verifier = createMtlsVerifier({
        caCertPem: ca.certPem,
        lookup: lookupOf([]),
      });
      const result = await verifier({ peerCertPem: "not a cert" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/malformed|parse/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects when peerCertPem is null/empty (no client cert presented)", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const verifier = createMtlsVerifier({
        caCertPem: ca.certPem,
        lookup: lookupOf([]),
      });
      const empty = await verifier({ peerCertPem: "" });
      expect(empty.ok).toBe(false);
      const undef = await verifier({ peerCertPem: null });
      expect(undef.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
