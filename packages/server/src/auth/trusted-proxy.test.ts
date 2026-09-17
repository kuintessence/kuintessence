import { describe, expect, test } from "bun:test";
import {
  isTrustedProxyAddress,
  parseTrustedProxyCidrs,
  resolveHttpClientIp,
} from "./trusted-proxy";

describe("trusted proxy CIDR guard", () => {
  test("matches IPv4, IPv6 and IPv4-mapped addresses", () => {
    const cidrs = parseTrustedProxyCidrs("10.0.0.0/8, 2001:db8::/32");
    expect(isTrustedProxyAddress("10.2.3.4", cidrs)).toBe(true);
    expect(isTrustedProxyAddress("::ffff:10.2.3.4", cidrs)).toBe(true);
    expect(isTrustedProxyAddress("2001:db8::42", cidrs)).toBe(true);
    expect(isTrustedProxyAddress("192.168.1.2", cidrs)).toBe(false);
  });

  test("fails closed for missing ranges and rejects invalid CIDRs", () => {
    expect(isTrustedProxyAddress("127.0.0.1", [])).toBe(false);
    expect(() => parseTrustedProxyCidrs("10.0.0.0/99")).toThrow("invalid trusted proxy CIDR");
  });
});

describe("HTTP client IP resolver", () => {
  const trusted = parseTrustedProxyCidrs("10.20.0.0/16,fd00:20::/64");

  test("uses the direct IPv4 socket peer and ignores a forged XFF", () => {
    expect(
      resolveHttpClientIp({
        socketPeer: "198.51.100.9",
        xForwardedFor: "203.0.113.77",
        trustedProxyCidrs: trusted,
      }),
    ).toBe("198.51.100.9");
  });

  test("walks a trusted IPv4 proxy chain from right to left", () => {
    expect(
      resolveHttpClientIp({
        socketPeer: "10.20.0.9",
        xForwardedFor: "203.0.113.12, 10.20.0.8",
        trustedProxyCidrs: trusted,
      }),
    ).toBe("203.0.113.12");
  });

  test("supports IPv6 peers and IPv6 proxy hops", () => {
    expect(
      resolveHttpClientIp({
        socketPeer: "fd00:20::9",
        xForwardedFor: "2001:db8:1234::42, fd00:20::8",
        trustedProxyCidrs: trusted,
      }),
    ).toBe("2001:db8:1234::42");
  });

  test("fails closed to the trusted socket peer for malformed forwarded chains", () => {
    expect(
      resolveHttpClientIp({
        socketPeer: "10.20.0.9",
        xForwardedFor: "203.0.113.12, unknown",
        trustedProxyCidrs: trusted,
      }),
    ).toBe("10.20.0.9");
  });
});
