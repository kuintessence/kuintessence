import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { ensureCa } from "./ca";
import { buildMtlsTlsOptions, mtlsHeaderGuard } from "./mtls-wire";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kq-mtls-wire-"));
}

function genServerCert(ca: { certPem: string; keyPem: string }): {
  certPem: string;
  keyPem: string;
} {
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  cert.setSubject([{ name: "commonName", value: "server.local" }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "server.local" }] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe("buildMtlsTlsOptions", () => {
  test("returns TLS options that pin server identity and require a client cert", async () => {
    const dir = tmp();
    try {
      const ca = await ensureCa(dir);
      const server = genServerCert(ca);
      const opts = buildMtlsTlsOptions({
        caCertPem: ca.certPem,
        serverCertPem: server.certPem,
        serverKeyPem: server.keyPem,
      });
      expect(opts.cert).toBe(server.certPem);
      expect(opts.key).toBe(server.keyPem);
      expect(opts.ca).toBe(ca.certPem);
      expect(opts.requestCert).toBe(true);
      expect(opts.rejectUnauthorized).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Generate a CA-signed leaf cert (serverAuth+SAN for servers, clientAuth for clients). */
function genLeaf(
  ca: { certPem: string; keyPem: string },
  cn: string,
  kind: "server" | "client",
): { certPem: string; keyPem: string } {
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = kind === "server" ? "0a" : "0b";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  cert.setSubject([{ name: "commonName", value: cn }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    kind === "server"
      ? { name: "extKeyUsage", serverAuth: true }
      : { name: "extKeyUsage", clientAuth: true },
    ...(kind === "server" ? [{ name: "subjectAltName", altNames: [{ type: 2, value: cn }] }] : []),
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

// Integration: stand up a real Bun.serve with the options buildMtlsTlsOptions
// produces, and confirm it actually ENFORCES mTLS at the TLS layer — the live
// regression guard for tbd #14 step 3 (the server handshake), replacing the
// throwaway de-risk spike. A client with a CA-signed cert connects; a client
// without one is rejected by the handshake.
describe("buildMtlsTlsOptions — live handshake enforcement", () => {
  test("accepts a CA-signed client cert and rejects a client with no cert", async () => {
    const dir = tmp();
    let srv: ReturnType<typeof Bun.serve> | null = null;
    try {
      const ca = await ensureCa(dir);
      const server = genLeaf(ca, "localhost", "server");
      const client = genLeaf(ca, "spike-agent", "client");
      srv = Bun.serve({
        port: 0,
        tls: buildMtlsTlsOptions({
          caCertPem: ca.certPem,
          serverCertPem: server.certPem,
          serverKeyPem: server.keyPem,
        }),
        fetch: () => new Response("ok-mtls"),
      });

      const withCert = await fetch(`https://localhost:${srv.port}/`, {
        tls: { cert: client.certPem, key: client.keyPem, ca: ca.certPem },
      } as RequestInit);
      expect(withCert.status).toBe(200);
      expect(await withCert.text()).toBe("ok-mtls");

      // No client cert presented → the requestCert+rejectUnauthorized handshake
      // must drop the connection (fetch throws).
      await expect(
        fetch(`https://localhost:${srv.port}/`, { tls: { ca: ca.certPem } } as RequestInit),
      ).rejects.toThrow();
    } finally {
      srv?.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mtlsHeaderGuard", () => {
  test("rejects requests missing the fingerprint header with 401", async () => {
    const guard = mtlsHeaderGuard({
      lookup: async () => null,
      enabled: true,
    });
    const req = new Request("https://server.local/grpc", { method: "POST" });
    const verdict = await guard(req);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.response.status).toBe(401);
      const body = (await verdict.response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("MTLS_REJECTED");
    }
  });

  test("rejects unknown fingerprint with 401", async () => {
    const guard = mtlsHeaderGuard({
      lookup: async () => null,
      enabled: true,
    });
    const fp = "ab".repeat(32);
    const req = new Request("https://server.local/grpc", {
      method: "POST",
      headers: { "x-agent-cert-fingerprint": fp },
    });
    const verdict = await guard(req);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.response.status).toBe(401);
  });

  test("rejects revoked fingerprint", async () => {
    const fp = "ab".repeat(32);
    const guard = mtlsHeaderGuard({
      lookup: async () => ({ agentId: "a", revokedAt: new Date() }),
      enabled: true,
    });
    const req = new Request("https://server.local/grpc", {
      method: "POST",
      headers: { "x-agent-cert-fingerprint": fp },
    });
    const verdict = await guard(req);
    expect(verdict.ok).toBe(false);
  });

  test("accepts known, non-revoked fingerprint and returns agentId", async () => {
    const fp = "cd".repeat(32);
    const guard = mtlsHeaderGuard({
      lookup: async (got) => (got === fp ? { agentId: "agent-yes", revokedAt: null } : null),
      enabled: true,
    });
    const req = new Request("https://server.local/grpc", {
      method: "POST",
      headers: { "x-agent-cert-fingerprint": fp },
    });
    const verdict = await guard(req);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.agentId).toBe("agent-yes");
      expect(verdict.fingerprintSha256).toBe(fp);
    }
  });

  test("accepts a configured fingerprint header name", async () => {
    const fp = "ef".repeat(32);
    const guard = mtlsHeaderGuard({
      lookup: async (got) => (got === fp ? { agentId: "agent-custom", revokedAt: null } : null),
      enabled: true,
      fingerprintHeader: "x-client-cert-sha256",
    });
    const req = new Request("https://server.local/grpc", {
      method: "POST",
      headers: { "x-client-cert-sha256": fp },
    });
    const verdict = await guard(req);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.agentId).toBe("agent-custom");
  });

  test("when disabled, passes through without any check", async () => {
    const guard = mtlsHeaderGuard({
      lookup: async () => {
        throw new Error("lookup should not be called when mTLS disabled");
      },
      enabled: false,
    });
    const req = new Request("https://server.local/grpc", { method: "POST" });
    const verdict = await guard(req);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.agentId).toBeNull();
  });

  test("rejects fingerprint header that is not 64 hex chars (defense in depth)", async () => {
    const guard = mtlsHeaderGuard({
      lookup: async () => ({ agentId: "x", revokedAt: null }),
      enabled: true,
    });
    const req = new Request("https://server.local/grpc", {
      method: "POST",
      headers: { "x-agent-cert-fingerprint": "not-a-hex" },
    });
    const verdict = await guard(req);
    expect(verdict.ok).toBe(false);
  });
});
