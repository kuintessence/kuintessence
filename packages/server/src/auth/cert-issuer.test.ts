import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { ensureCa } from "./ca";
import { issueAgentCert } from "./cert-issuer";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kq-issuer-"));
}

/** Generate a self-managed CSR exactly the way the Agent will. */
function genAgentCsr(commonName: string): { csrPem: string } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return { csrPem: forge.pki.certificationRequestToPem(csr) };
}

describe("issueAgentCert", () => {
  test("signs a valid CSR and returns PEM cert with expected fields", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const { csrPem } = genAgentCsr("agent-alpha");

      const result = issueAgentCert({
        ca,
        csrPem,
        agentId: "agent-alpha",
      });

      expect(result.certPem).toMatch(/-----BEGIN CERTIFICATE-----/);
      expect(result.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.subjectCn).toBe("agent-alpha");
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // ~ 1 year validity
      const validityDays =
        (result.expiresAt.getTime() - result.issuedAt.getTime()) / (24 * 3600 * 1000);
      expect(validityDays).toBeGreaterThan(360);
      expect(validityDays).toBeLessThan(370);

      // Cert chain: signed by our CA
      const issued = forge.pki.certificateFromPem(result.certPem);
      const caCert = forge.pki.certificateFromPem(ca.certPem);
      // verify() returns true on success, throws on failure
      expect(caCert.verify(issued)).toBe(true);

      // SAN contains agentId for the connectRPC verifier
      const sanExt = issued.getExtension("subjectAltName") as
        | { altNames: { type: number; value: string }[] }
        | undefined;
      expect(sanExt).toBeDefined();
      const dnsName = sanExt?.altNames.find((a) => a.type === 2)?.value;
      expect(dnsName).toBe("agent-alpha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects CSR whose CN does not match agentId (defense in depth)", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const { csrPem } = genAgentCsr("attacker-agent");
      expect(() => issueAgentCert({ ca, csrPem, agentId: "victim-agent" })).toThrow(
        /CN.*mismatch|does not match/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects CSR with an invalid signature (tampered CSR)", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const { csrPem } = genAgentCsr("agent-x");
      // Mutate one base64 char in the body to corrupt the signature.
      const tampered = csrPem.replace(/^([A-Za-z0-9+/=]+)$/m, (l) =>
        l.length > 20 ? `${l.slice(0, -2)}AB` : l,
      );
      expect(() => issueAgentCert({ ca, csrPem: tampered, agentId: "agent-x" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed CSR PEM with a clear error", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      expect(() => issueAgentCert({ ca, csrPem: "not a csr", agentId: "agent-x" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two issuances for the same agent produce different fingerprints", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const a = issueAgentCert({ ca, csrPem: genAgentCsr("agent-z").csrPem, agentId: "agent-z" });
      const b = issueAgentCert({ ca, csrPem: genAgentCsr("agent-z").csrPem, agentId: "agent-z" });
      expect(a.fingerprintSha256).not.toBe(b.fingerprintSha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
