import { describe, expect, test } from "bun:test";
import forge from "node-forge";
import { generateCsr } from "./csr";

describe("Agent CSR generation", () => {
  test("generates a 2048-bit RSA keypair and a CSR with CN=agentId", () => {
    const result = generateCsr({ agentId: "agent-001" });
    expect(result.csrPem).toMatch(/-----BEGIN CERTIFICATE REQUEST-----/);
    expect(result.privateKeyPem).toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);

    const csr = forge.pki.certificationRequestFromPem(result.csrPem);
    expect(csr.verify()).toBe(true);
    const cnAttr = csr.subject.getField("CN") as { value: string } | null;
    expect(cnAttr?.value).toBe("agent-001");
  });

  test("two calls produce different keys (no static seed)", () => {
    const a = generateCsr({ agentId: "x" });
    const b = generateCsr({ agentId: "x" });
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
    expect(a.csrPem).not.toBe(b.csrPem);
  });

  test("rejects empty agentId", () => {
    expect(() => generateCsr({ agentId: "" })).toThrow();
  });
});
