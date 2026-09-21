import { describe, expect, test } from "bun:test";
import { loadRegistryConfig } from "./config";

const base = { DATABASE_URL: "postgres://kq:kq@localhost:5432/kuintessence" };
const enabled = {
  ...base,
  SPACK_UPSTREAM_ENABLED: "true",
  SPACK_RECIPE_STORE_DIR: "/var/lib/registry/recipes",
  SPACK_UPSTREAM_PROXY_URL: "socks5h://operator:secret@proxy.example.org:1080",
  SPACK_UPSTREAM_ALLOWED_ORIGINS: '["https://downloads.example.org"]',
};

describe("Registry Spack upstream configuration", () => {
  test("defaults to disabled without inheriting ambient proxy settings", () => {
    const config = loadRegistryConfig({ ...base, HTTPS_PROXY: "http://ambient.invalid" });
    expect(config).toMatchObject({
      SPACK_UPSTREAM_ENABLED: false,
      SPACK_UPSTREAM_ALLOWED_ORIGINS: [],
      SPACK_UPSTREAM_MAX_CONCURRENT: 2,
    });
    expect(config.SPACK_UPSTREAM_PROXY_URL).toBeUndefined();
    expect(loadRegistryConfig(enabled).SPACK_UPSTREAM_ENABLED).toBe(true);
  });

  test.each([
    { SPACK_UPSTREAM_PROXY_URL: "" },
    { SPACK_RECIPE_STORE_DIR: "" },
    { SPACK_UPSTREAM_ALLOWED_ORIGINS: "[]" },
    { SPACK_UPSTREAM_ALLOWED_ORIGINS: '["https://127.0.0.1"]' },
    { SPACK_UPSTREAM_MAX_CONCURRENT: "5" },
    { SPACK_UPSTREAM_MAX_BYTES: String(16 * 1024 ** 3 + 1) },
    { SPACK_UPSTREAM_TIMEOUT_MS: "1800001" },
    { SPACK_UPSTREAM_TIMEOUT_MS: "100" },
    { SPACK_UPSTREAM_CA_BUNDLE: "relative/ca.pem" },
  ])("rejects an incomplete or unbounded configuration: %j", (overrides) => {
    expect(() => loadRegistryConfig({ ...enabled, ...overrides })).toThrow();
  });

  test("configuration errors do not reveal the proxy credential", () => {
    try {
      loadRegistryConfig({
        ...enabled,
        SPACK_UPSTREAM_PROXY_URL: "socks4://operator:do-not-log-this@proxy.example.org",
      });
      throw new Error("Invalid proxy unexpectedly accepted");
    } catch (error) {
      expect(String(error)).toContain("Invalid Spack upstream proxy configuration");
      expect(String(error)).not.toContain("do-not-log-this");
    }
  });
});
