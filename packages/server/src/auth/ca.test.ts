import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCa, loadCa } from "./ca";

describe("Server self-signed CA", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kq-ca-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("ensureCa creates ca.crt + ca.key on first run", async () => {
    const ca = await ensureCa(dir);
    expect(ca.certPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(ca.keyPem).toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);
    // Files persisted
    const certOnDisk = readFileSync(join(dir, "ca.crt"), "utf8");
    const keyOnDisk = readFileSync(join(dir, "ca.key"), "utf8");
    expect(certOnDisk).toBe(ca.certPem);
    expect(keyOnDisk).toBe(ca.keyPem);
  });

  test("ensureCa is idempotent — second call loads same cert", async () => {
    const first = await ensureCa(dir);
    const second = await ensureCa(dir);
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);
  });

  test("loadCa reads existing cert and key", async () => {
    await ensureCa(dir);
    const ca = await loadCa(dir);
    expect(ca).not.toBeNull();
    expect(ca?.certPem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(ca?.keyPem).toMatch(/-----BEGIN/);
  });

  test("loadCa returns null when CA files absent", async () => {
    const ca = await loadCa(dir);
    expect(ca).toBeNull();
  });

  test("loadCa rejects when one of the files is missing (corrupt state)", async () => {
    await ensureCa(dir);
    // Delete just the key — corrupt half-state
    rmSync(join(dir, "ca.key"));
    await expect(loadCa(dir)).rejects.toThrow(/corrupt/i);
  });

  test("CA cert has 5-year validity and is self-signed", async () => {
    const ca = await ensureCa(dir);
    // Parse with node-forge to inspect
    const forge = await import("node-forge");
    const cert = forge.pki.certificateFromPem(ca.certPem);
    const validityYears =
      (cert.validity.notAfter.getTime() - cert.validity.notBefore.getTime()) /
      (365.25 * 24 * 3600 * 1000);
    expect(validityYears).toBeGreaterThan(4.9);
    expect(validityYears).toBeLessThan(5.1);
    // Self-signed: subject == issuer
    expect(cert.subject.hash).toBe(cert.issuer.hash);
  });

  test("ensureCa survives an unrelated file in dir", async () => {
    writeFileSync(join(dir, "noise.txt"), "hello");
    const ca = await ensureCa(dir);
    expect(ca.certPem).toContain("BEGIN CERTIFICATE");
  });
});
