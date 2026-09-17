import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCert, loadCertBundle, persistCertBundle } from "./cert-store";

describe("Agent cert-store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kq-agent-cs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("hasCert returns false on empty dir", () => {
    expect(hasCert(dir)).toBe(false);
  });

  test("persistCertBundle writes client.crt + client.key + ca.crt with restrictive perms", async () => {
    await persistCertBundle(dir, {
      certPem: "CERT",
      keyPem: "KEY",
      caCertPem: "CA",
    });
    expect(readFileSync(join(dir, "client.crt"), "utf8")).toBe("CERT");
    expect(readFileSync(join(dir, "client.key"), "utf8")).toBe("KEY");
    expect(readFileSync(join(dir, "ca.crt"), "utf8")).toBe("CA");

    // Key file mode is 0600 (owner-rw only)
    const keyStat = statSync(join(dir, "client.key"));
    expect(keyStat.mode & 0o777).toBe(0o600);

    expect(hasCert(dir)).toBe(true);
  });

  test("loadCertBundle round-trips the persisted bundle", async () => {
    await persistCertBundle(dir, {
      certPem: "C1",
      keyPem: "K1",
      caCertPem: "CA1",
    });
    const loaded = await loadCertBundle(dir);
    expect(loaded).toEqual({ certPem: "C1", keyPem: "K1", caCertPem: "CA1" });
  });

  test("loadCertBundle throws when bundle is missing entirely", async () => {
    await expect(loadCertBundle(dir)).rejects.toThrow(/not found|missing/i);
  });

  test("loadCertBundle throws when only some files exist (corrupt)", async () => {
    writeFileSync(join(dir, "client.crt"), "x");
    await expect(loadCertBundle(dir)).rejects.toThrow();
  });

  test("hasCert is true only when all three files exist", () => {
    writeFileSync(join(dir, "client.crt"), "x");
    expect(hasCert(dir)).toBe(false);
    writeFileSync(join(dir, "client.key"), "x");
    expect(hasCert(dir)).toBe(false);
    writeFileSync(join(dir, "ca.crt"), "x");
    expect(hasCert(dir)).toBe(true);
  });
});
