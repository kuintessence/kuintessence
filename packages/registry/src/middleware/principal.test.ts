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

describe("native OCI challenge and repository tokens", () => {
  function scopedApp() {
    const app = new Hono<RegistryEnv>();
    app.use(
      "*",
      createPrincipalMiddleware({
        authMode: "jwt",
        jwtSecret: SECRET,
        jwtIssuer: ISSUER,
        jwtAudience: AUDIENCE,
        ociPublicOrigin: "https://platform.example.com",
        resolveCanonicalPrincipal: async () => ({
          sub: "u1",
          role: "user",
          orgIds: [],
          suspended: false,
        }),
      }),
    );
    app.all("*", (c) => c.json({ ok: true }));
    return app;
  }
  const credential = (access: unknown) =>
    sign({
      sub: "u1",
      role: "platform_admin",
      orgIds: [],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
      access,
    });
  test("discovers HTTPS realm through an internal HTTP upstream without trusting forwarded host", async () => {
    const response = await scopedApp().request(
      "http://registry:3100/v2/public/image/manifests/latest",
      {
        headers: { "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http" },
      },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="https://platform.example.com/api/registry/token",service="platform.example.com",scope="repository:public/image:pull"',
    );
    expect(response.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");
  });
  test("repository pull cannot push, cross repositories, catalog, or mount without source pull", async () => {
    const app = scopedApp();
    const headers = {
      Authorization: `Bearer ${credential([{ type: "repository", name: "public/image", actions: ["pull"] }])}`,
    };
    expect((await app.request("/v2/", { headers })).status).toBe(200);
    const unscoped = sign({
      sub: "u1",
      role: "user",
      orgIds: [],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    expect(
      (await app.request("/v2/", { headers: { Authorization: `Bearer ${unscoped}` } })).status,
    ).toBe(401);
    expect((await app.request("/v2/public/image/manifests/latest", { headers })).status).toBe(200);
    expect((await app.request("/v2/public/other/manifests/latest", { headers })).status).toBe(401);
    expect(
      (await app.request("/v2/public/image/manifests/latest", { method: "PUT", headers })).status,
    ).toBe(401);
    expect((await app.request("/v2/_catalog", { headers })).status).toBe(401);
    const pushHeaders = {
      Authorization: `Bearer ${credential([{ type: "repository", name: "public/image", actions: ["push"] }])}`,
    };
    expect(
      (
        await app.request("/v2/public/image/blobs/uploads/?from=public/other&mount=sha256:123", {
          method: "POST",
          headers: pushHeaders,
        })
      ).status,
    ).toBe(401);
  });
  test("malformed grants and missing expiry are rejected", () => {
    expect(() =>
      verifyJwtPrincipal(
        credential([{ type: "repository", name: "public/image", actions: ["delete"] }]),
        { secret: SECRET },
      ),
    ).toThrow();
    expect(() =>
      verifyJwtPrincipal(sign({ sub: "u1", role: "user", orgIds: [], access: [] }), {
        secret: SECRET,
      }),
    ).toThrow();
  });
  test("repository token cannot become a general principal on catalog or usecase APIs", async () => {
    const app = new Hono();
    app.onError((_error, c) => c.json({ error: "unauthorized" }, 401));
    app.get("*", async (c) =>
      c.json({
        principal: await readOptionalPrincipal(c, {
          authMode: "jwt",
          jwtSecret: SECRET,
          jwtIssuer: ISSUER,
          jwtAudience: AUDIENCE,
        }),
      }),
    );
    const headers = {
      Authorization: `Bearer ${credential([{ type: "repository", name: "public/image", actions: ["pull"] }])}`,
    };
    expect((await app.request("/spack/catalog", { headers })).status).toBe(401);
    expect((await app.request("/usecase-packages/private", { headers })).status).toBe(401);
    expect((await app.request("/spack/catalog")).status).toBe(200);
  });
});
