import { describe, expect, test } from "bun:test";
import { oidcExternalIdentityKey } from "./auth";

describe("oidcExternalIdentityKey", () => {
  test("normalizes trailing slash, query, and fragment", () => {
    const subject = "user-1";
    expect(oidcExternalIdentityKey("https://idp.example.com/realms/demo/", subject)).toBe(
      oidcExternalIdentityKey("https://idp.example.com/realms/demo?ignored=1#fragment", subject),
    );
  });

  test("isolates the same subject across issuers", () => {
    const subject = "shared-subject";
    expect(oidcExternalIdentityKey("https://idp-a.example.com", subject)).not.toBe(
      oidcExternalIdentityKey("https://idp-b.example.com", subject),
    );
  });

  test("produces a fixed-length non-plaintext database key", () => {
    const subject = "sensitive/".repeat(1_000);
    const key = oidcExternalIdentityKey("https://idp.example.com", subject);
    expect(key).toMatch(/^oidc:[0-9a-f]{64}$/);
    expect(key.length).toBeLessThanOrEqual(255);
    expect(key).not.toContain("sensitive");
  });
});
