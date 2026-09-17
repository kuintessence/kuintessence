import { describe, expect, test } from "bun:test";
import forge from "node-forge";
import { fingerprintOfPem } from "./fingerprint";

describe("fingerprintOfPem", () => {
  test("returns a 64-char lowercase hex string", () => {
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: "commonName", value: "x" }]);
    cert.setIssuer([{ name: "commonName", value: "x" }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);
    const fp = fingerprintOfPem(pem);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two different certs have different fingerprints", () => {
    const make = () => {
      const k = forge.pki.rsa.generateKeyPair({ bits: 2048 });
      const c = forge.pki.createCertificate();
      c.publicKey = k.publicKey;
      c.serialNumber = String(Date.now());
      c.validity.notBefore = new Date();
      c.validity.notAfter = new Date(Date.now() + 86400000);
      c.setSubject([{ name: "commonName", value: "x" }]);
      c.setIssuer([{ name: "commonName", value: "x" }]);
      c.sign(k.privateKey, forge.md.sha256.create());
      return forge.pki.certificateToPem(c);
    };
    expect(fingerprintOfPem(make())).not.toBe(fingerprintOfPem(make()));
  });

  test("rejects malformed PEM", () => {
    expect(() => fingerprintOfPem("garbage")).toThrow();
  });
});
