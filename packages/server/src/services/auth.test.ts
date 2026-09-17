import { describe, expect, test } from "bun:test";
import { Role } from "@kuintessence/shared";
import { signSessionRefreshToken, signToken, verifySessionRefreshToken, verifyToken } from "./auth";

describe("auth service", () => {
  const secret = "test-secret-at-least-32-chars-long-yes!";

  test("sign and verify round-trip", async () => {
    const payload = {
      sub: "user-123",
      role: Role.USER,
      email: "test@test.com",
      orgIds: ["11111111-1111-4111-8111-111111111111"],
    };
    const token = await signToken(payload, secret, 3600);
    const decoded = await verifyToken(token, secret);
    expect(decoded.sub).toBe("user-123");
    expect(decoded.role).toBe("user");
    expect(decoded.email).toBe("test@test.com");
    expect(decoded.orgIds).toEqual(payload.orgIds);
  });

  test("rejects tampered token", async () => {
    const payload = { sub: "user-123", role: Role.USER, email: "test@test.com" };
    const token = await signToken(payload, secret, 3600);
    const tampered = `${token.slice(0, -5)}XXXXX`;
    expect(verifyToken(tampered, secret)).rejects.toThrow();
  });

  test("rejects expired token", async () => {
    const payload = { sub: "user-123", role: Role.USER, email: "test@test.com" };
    const token = await signToken(payload, secret, -1);
    expect(verifyToken(token, secret)).rejects.toThrow();
  });

  test("rejects token with wrong secret", async () => {
    const payload = { sub: "user-123", role: Role.USER, email: "test@test.com" };
    const token = await signToken(payload, secret, 3600);
    expect(verifyToken(token, "different-secret-also-32-chars-long!")).rejects.toThrow();
  });

  test("keeps access and refresh credentials type-separated", async () => {
    const payload = { sub: "user-123", role: Role.USER, email: "test@test.com" };
    const refreshToken = await signSessionRefreshToken(payload, secret, 3600);
    await expect(verifySessionRefreshToken(refreshToken, secret)).resolves.toMatchObject(payload);
    await expect(verifyToken(refreshToken, secret)).rejects.toThrow();
    const accessToken = await signToken(payload, secret, 3600);
    await expect(verifySessionRefreshToken(accessToken, secret)).rejects.toThrow();
  });
});
