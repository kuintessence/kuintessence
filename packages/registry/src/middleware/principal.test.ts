import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import {
  createPrincipalMiddleware,
  type RegistryEnv,
  readOptionalPrincipal,
  verifyJwtPrincipal,
} from "./principal";

const SECRET = "registry-jwt-test-secret";
const ISSUER = "https://issuer.example";
const AUDIENCE = "kuintessence-registry";

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode(payload);
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function appFor(requirePublisher = false) {
  const app = new Hono<RegistryEnv>();
  app.use(
    "*",
    createPrincipalMiddleware({
      authMode: "jwt",
      jwtSecret: SECRET,
      jwtIssuer: ISSUER,
      jwtAudience: AUDIENCE,
      requirePublisher,
    }),
  );
  app.get("/", (c) => c.json({ principal: c.get("principal") }));
  return app;
}

function appWithCanonicalResolver(
  resolver?: () => Promise<{
    sub: string;
    role: "platform_admin" | "user";
    orgIds: string[];
    suspended: boolean;
  } | null>,
) {
  const app = new Hono<RegistryEnv>();
  app.use(
    "*",
    createPrincipalMiddleware({
      authMode: "jwt",
      jwtSecret: SECRET,
      jwtIssuer: ISSUER,
      jwtAudience: AUDIENCE,
      requireCanonicalPrincipal: true,
      requirePublisher: true,
      resolveCanonicalPrincipal: resolver ? async () => resolver() : undefined,
    }),
  );
  app.get("/", (c) => c.json({ principal: c.get("principal") }));
  return app;
}

describe("Registry principal middleware", () => {
  test("verifyJwtPrincipal accepts a valid HS256 token with issuer and audience", () => {
    const token = sign({
      sub: "publisher-1",
      role: "platform_admin",
      orgIds: ["org-a"],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect(
      verifyJwtPrincipal(token, { secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
    ).toEqual({
      sub: "publisher-1",
      role: "platform_admin",
      orgIds: ["org-a"],
    });
  });

  test("accepts the shared operator role", () => {
    const token = sign({
      sub: "operator-1",
      role: "operator",
      orgIds: ["org-a"],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect(
      verifyJwtPrincipal(token, { secret: SECRET, issuer: ISSUER, audience: AUDIENCE }),
    ).toEqual({ sub: "operator-1", role: "operator", orgIds: ["org-a"] });
  });

  test("rejects a token with the wrong audience", async () => {
    const token = sign({
      sub: "publisher-1",
      role: "platform_admin",
      orgIds: [],
      iss: ISSUER,
      aud: "other-service",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await appFor().request("/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("INVALID_TOKEN");
  });

  test("rejects write middleware when the JWT principal lacks a publisher role", async () => {
    const token = sign({
      sub: "user-1",
      role: "user",
      orgIds: ["org-a"],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await appFor(true).request("/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe("PUBLISHER_ROLE_REQUIRED");
  });

  test("ignores X-Test-Principal in jwt mode unless explicitly allowed", async () => {
    const res = await appFor().request("/", {
      headers: {
        "X-Test-Principal": JSON.stringify({ sub: "x", role: "platform_admin", orgIds: [] }),
      },
    });
    expect(res.status).toBe(401);
  });

  test("fails closed when canonical principal resolution is required but unavailable", async () => {
    const token = sign({
      sub: crypto.randomUUID(),
      role: "platform_admin",
      orgIds: [],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await appWithCanonicalResolver().request("/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("uses the current canonical role instead of a stale publisher claim", async () => {
    const token = sign({
      sub: crypto.randomUUID(),
      role: "platform_admin",
      orgIds: [],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await appWithCanonicalResolver(async () => ({
      sub: crypto.randomUUID(),
      role: "user",
      orgIds: [],
      suspended: false,
    })).request("/", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  test("rejects missing and suspended canonical principals", async () => {
    const token = sign({
      sub: crypto.randomUUID(),
      role: "platform_admin",
      orgIds: [],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const missing = await appWithCanonicalResolver(async () => null).request("/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const suspended = await appWithCanonicalResolver(async () => ({
      sub: crypto.randomUUID(),
      role: "platform_admin",
      orgIds: [],
      suspended: true,
    })).request("/", { headers: { Authorization: `Bearer ${token}` } });
    expect(missing.status).toBe(401);
    expect(suspended.status).toBe(401);
  });

  test("replaces stale token organizations with current canonical memberships", async () => {
    const token = sign({
      sub: crypto.randomUUID(),
      role: "platform_admin",
      orgIds: ["stale-org"],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const currentOrg = crypto.randomUUID();
    const res = await appWithCanonicalResolver(async () => ({
      sub: crypto.randomUUID(),
      role: "platform_admin",
      orgIds: [currentOrg],
      suspended: false,
    })).request("/", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal: { orgIds: string[] } };
    expect(body.principal.orgIds).toEqual([currentOrg]);
  });

  test("rebinds optional authenticated reads to current memberships", async () => {
    const token = sign({
      sub: crypto.randomUUID(),
      role: "user",
      orgIds: ["stale-org"],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const currentOrg = crypto.randomUUID();
    const app = new Hono();
    app.get("/", async (c) =>
      c.json({
        principal: await readOptionalPrincipal(c, {
          authMode: "jwt",
          jwtSecret: SECRET,
          jwtIssuer: ISSUER,
          jwtAudience: AUDIENCE,
          resolveCanonicalPrincipal: async (subject) => ({
            sub: subject,
            role: "user",
            orgIds: [currentOrg],
            suspended: false,
          }),
        }),
      }),
    );
    const res = await app.request("/", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal: { orgIds: string[] } };
    expect(body.principal.orgIds).toEqual([currentOrg]);
  });
});
