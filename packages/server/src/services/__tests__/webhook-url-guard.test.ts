import { describe, expect, it } from "bun:test";
import { isPubliclyRoutableHttpUrl, resolvePublicWebhookTarget } from "../webhook-url-guard";

describe("isPubliclyRoutableHttpUrl", () => {
  const rejected = [
    "http://169.254.169.254/latest/meta-data",
    "http://localhost:9000",
    "http://127.0.0.1",
    "http://10.1.2.3",
    "http://100.64.0.1",
    "http://192.168.0.5",
    "http://172.16.0.1",
    "https://[::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "ftp://example.com",
    "not-a-url",
  ];
  for (const url of rejected) {
    it(`rejects ${url}`, () => {
      expect(isPubliclyRoutableHttpUrl(url)).toBe(false);
    });
  }

  const accepted = [
    "https://example.com/hook",
    "https://hooks.billing.example.com:8443/x",
    "http://203.0.113.5/h",
  ];
  for (const url of accepted) {
    it(`accepts ${url}`, () => {
      expect(isPubliclyRoutableHttpUrl(url)).toBe(true);
    });
  }
});

describe("resolvePublicWebhookTarget", () => {
  it("rejects a hostname when any DNS answer is private", async () => {
    await expect(
      resolvePublicWebhookTarget("http://localtest.me/hook", async () => [
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow(/non-public/);
  });

  it("accepts a hostname only when every DNS answer is public", async () => {
    const target = await resolvePublicWebhookTarget("https://hooks.example.com/hook", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    expect(target.addresses).toHaveLength(2);
  });
});
