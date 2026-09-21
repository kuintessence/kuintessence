import { describe, expect, test } from "bun:test";
import {
  isPublicIPv4,
  parseUpstreamOrigins,
  parseUpstreamProxy,
  SpackUpstreamError,
  validateUpstreamUrl,
} from "./spack-upstream-policy";

describe("Spack upstream policy", () => {
  test.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::ffff:8.8.8.8",
    "2130706433",
  ])("rejects non-public or noncanonical address %s", (address) => {
    expect(isPublicIPv4(address)).toBe(false);
  });

  test("permits public IPv4 only", () => {
    expect(isPublicIPv4("93.184.216.34")).toBe(true);
    expect(isPublicIPv4("8.8.8.8")).toBe(true);
  });

  test.each([
    "http://downloads.example.org/source.tgz",
    "https://downloads.example.org:8443/source.tgz",
    "https://user:secret@downloads.example.org/source.tgz",
    "https://@downloads.example.org/source.tgz",
    "https:downloads.example.org/source.tgz",
    "https://downloads.example.org/source.tgz?token=secret",
    "https://downloads.example.org/source.tgz#secret",
    "https://downloads.example.org/source.tgz?",
    "https://downloads.example.org/source.tgz#",
    "https://127.0.0.1/source.tgz",
    "https://[2606:4700:4700::1111]/source.tgz",
    "https://metadata.internal/source.tgz",
    "https://localhost/source.tgz",
    "https://downloads.example.org./source.tgz",
    "https://other.example.org/source.tgz",
  ])("rejects unsafe or unapproved URL without echoing it", (url) => {
    try {
      validateUpstreamUrl(url, ["https://downloads.example.org"]);
      throw new Error("URL unexpectedly accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(SpackUpstreamError);
      expect(String(error)).not.toContain(url);
      expect(String(error)).not.toContain("secret");
    }
  });

  test("allowlists complete origins, not suffixes", () => {
    expect(parseUpstreamOrigins('["https://downloads.example.org"]')).toEqual([
      "https://downloads.example.org",
    ]);
    expect(
      validateUpstreamUrl("https://downloads.example.org/source.tgz", [
        "https://downloads.example.org",
      ]).hostname,
    ).toBe("downloads.example.org");
    for (const input of [
      "{}",
      '["https://downloads.example.org/path"]',
      '["https://downloads.example.org","https://downloads.example.org"]',
    ]) {
      expect(() => parseUpstreamOrigins(input)).toThrow(SpackUpstreamError);
    }
  });

  test.each(["http", "https", "socks5", "socks5h"])("accepts %s proxies", (scheme) => {
    expect(parseUpstreamProxy(`${scheme}://user:password@proxy.example.org:1080`)).toContain(
      `${scheme}://`,
    );
  });

  test("makes conventional proxy ports explicit instead of losing them in URL normalization", () => {
    expect(parseUpstreamProxy("http://proxy.example.org:80")).toBe("http://proxy.example.org:80");
    expect(parseUpstreamProxy("https://proxy.example.org:443")).toBe("https://proxy.example.org:443");
    expect(parseUpstreamProxy("http://proxy.example.org")).toBe("http://proxy.example.org:80");
    expect(parseUpstreamProxy("socks5h://proxy.example.org")).toBe("socks5h://proxy.example.org:1080");
  });

  test.each([
    "file:///tmp/proxy",
    "socks4://proxy.example.org:1080",
    "http://proxy.example.org/path",
    "http://proxy.example.org?secret",
    "http://proxy.example.org#secret",
    "http://user:%0Asecret@proxy.example.org",
    " http://proxy.example.org",
  ])("rejects malformed proxy without leaking credentials", (value) => {
    expect(() => parseUpstreamProxy(value)).toThrow("Spack upstream request is not permitted");
  });
});
