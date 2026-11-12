import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { createRegistryTokenRoutes } from "./registry-token";

const now = () => Math.floor(Date.now() / 1000);
const accessToken = (exp = now() + 90) =>
  `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
const basic = (token = accessToken(), username = "user@example.com") =>
  `Basic ${btoa(`${username}:${token}`)}`;
const authenticate: MiddlewareHandler = async (c, next) => {
  c.set("user", { sub: "user-1", email: "user@example.com", role: "user" });
  await next();
};
const bind: MiddlewareHandler = async (c, next) => {
  c.set("principal" as never, { userId: "user-1", role: "user", orgIds: ["org-1"] } as never);
  await next();
};
function fixture() {
  const app = new Hono();
  app.onError((_error, c) => c.json({ error: "unauthorized" }, 401));
  app.route(
    "/api",
    createRegistryTokenRoutes(
      {} as PgDb,
      "platform-secret",
      {
        publicOrigin: "https://platform.example.com",
        secret: "registry-secret",
        issuer: "platform",
        audience: "registry",
      },
      authenticate,
      bind,
    ),
  );
  return app;
}
const endpoint = "/api/registry/token?service=platform.example.com";
const tokenResponseSchema = z.object({
  token: z.string(),
  expires_in: z.number(),
});

describe("native OCI token exchange", () => {
  test("Docker login Basic exchange issues short scoped token with canonical identity", async () => {
    const response = await fixture().request(`${endpoint}&scope=repository:org/org-1/image:pull`, {
      headers: { Authorization: basic() },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = tokenResponseSchema.parse(await response.json());
    const payload = z.string().min(1).parse(body.token.split(".")[1]);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.sub).toBe("user-1");
    expect(claims.access).toEqual([
      { type: "repository", name: "org/org-1/image", actions: ["pull"] },
    ]);
    expect(claims.aud).toBe("registry");
    expect(body.expires_in).toBeLessThanOrEqual(90);
  });
  test("Docker offline-token hint returns only a bounded access token for login and scoped pull", async () => {
    const sourceExpiry = now() + 90;
    for (const scope of ["", "&scope=repository:org/org-1/image:pull"]) {
      const response = await fixture().request(`${endpoint}&offline_token=true${scope}`, {
        headers: { Authorization: basic(accessToken(sourceExpiry)) },
      });
      expect(response.status).toBe(200);
      const raw: unknown = await response.json();
      const body = tokenResponseSchema.parse(raw);
      expect(raw).not.toHaveProperty("refresh_token");
      expect(raw).toHaveProperty("access_token", body.token);
      expect(body.expires_in).toBeGreaterThan(0);
      expect(body.expires_in).toBeLessThanOrEqual(90);
      const encoded = z.string().min(1).parse(body.token.split(".")[1]);
      const claims = JSON.parse(Buffer.from(encoded, "base64url").toString());
      expect(claims.exp).toBeLessThanOrEqual(sourceExpiry);
      expect(claims.access).toEqual(
        scope ? [{ type: "repository", name: "org/org-1/image", actions: ["pull"] }] : [],
      );
    }
    expect((await fixture().request(`${endpoint}&offline_token=true`)).status).toBe(401);
    expect(
      (
        await fixture().request(`${endpoint}&offline_token=true`, {
          headers: { Authorization: basic(accessToken(now() - 1)) },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fixture().request(
          `${endpoint}&offline_token=true&scope=repository:org/other/image:pull`,
          {
            headers: { Authorization: basic() },
          },
        )
      ).status,
    ).toBe(403);
  });
  test("refresh-token grants remain unsupported even with valid Basic credentials", async () => {
    for (const query of [
      "grant_type=refresh_token",
      "refresh_token=not-a-token",
      "grant_type=refresh_token&offline_token=true",
    ]) {
      const response = await fixture().request(`${endpoint}&${query}`, {
        headers: { Authorization: basic() },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "unsupported_grant_type" });
    }
    expect(
      (
        await fixture().request(endpoint, {
          method: "POST",
          headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=refresh_token&refresh_token=not-a-token",
        })
      ).status,
    ).toBe(404);
  });
  test("Apptainer challenge scopes cannot expand subject repository or publisher permissions", async () => {
    for (const scope of [
      "repository:org/other/image:pull",
      "repository:user/other/image:pull",
      "repository:public/image:pull,push",
    ]) {
      expect(
        (
          await fixture().request(`${endpoint}&scope=${scope}`, {
            headers: { Authorization: basic() },
          })
        ).status,
      ).toBe(403);
    }
  });
  test("rejects missing/invalid Basic, username mismatch, automation, service spoof and unsupported scope", async () => {
    for (const authorization of [
      "",
      "Basic !!!",
      basic("kqac_example"),
      basic(accessToken(), "other@example.com"),
    ]) {
      expect(
        (await fixture().request(endpoint, { headers: { Authorization: authorization } })).status,
      ).toBe(401);
    }
    expect(
      (
        await fixture().request("/api/registry/token?service=internal:3100", {
          headers: { Authorization: basic() },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fixture().request(`${endpoint}&scope=registry:catalog:*`, {
          headers: { Authorization: basic() },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fixture().request(endpoint, {
          headers: { Authorization: basic(accessToken(now() - 1)) },
        })
      ).status,
    ).toBe(401);
  });
  test("empty login grants cannot authorize a repository", async () => {
    const response = await fixture().request(endpoint, { headers: { Authorization: basic() } });
    const body = tokenResponseSchema.parse(await response.json());
    const payload = z.string().min(1).parse(body.token.split(".")[1]);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).access).toEqual([]);
  });
});
