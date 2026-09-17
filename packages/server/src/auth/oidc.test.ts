import { afterEach, describe, expect, test } from "bun:test";
import type { Configuration } from "openid-client";
import {
  buildOidcAuthUrl,
  completeOidcCallback,
  discoverOidc,
  extractGroups,
  type OidcClientImpl,
  resetOidcClientImpl,
  setOidcClientImplForTesting,
} from "./oidc";

afterEach(() => {
  resetOidcClientImpl();
});

describe("extractGroups", () => {
  test("returns array as-is when claim is array of strings", () => {
    expect(extractGroups(["a", "b"])).toEqual(["a", "b"]);
  });

  test("filters non-string array entries", () => {
    expect(extractGroups(["a", 1, true, "b"])).toEqual(["a", "b"]);
  });

  test("splits comma-separated string", () => {
    expect(extractGroups("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  test("splits space-separated string", () => {
    expect(extractGroups("admin user")).toEqual(["admin", "user"]);
  });

  test("undefined / null / object → empty array", () => {
    expect(extractGroups(undefined)).toEqual([]);
    expect(extractGroups(null)).toEqual([]);
    expect(extractGroups({ groups: ["a"] })).toEqual([]);
  });

  test("empty string → empty array", () => {
    expect(extractGroups("")).toEqual([]);
  });
});

// Build a minimal stub that stands in for `Configuration`. Only properties
// that the implementation reads (via `serverMetadata`) are needed.
function stubConfig(meta: Partial<Record<string, string>> = {}): Configuration {
  return {
    serverMetadata: () => ({
      issuer: meta.issuer ?? "https://idp.example.com",
      authorization_endpoint: meta.authorization_endpoint ?? "https://idp.example.com/auth",
      token_endpoint: meta.token_endpoint ?? "https://idp.example.com/token",
      userinfo_endpoint: meta.userinfo_endpoint ?? "https://idp.example.com/userinfo",
      jwks_uri: meta.jwks_uri ?? "https://idp.example.com/jwks",
    }),
  } as unknown as Configuration;
}

describe("discoverOidc + caching", () => {
  test("calls impl.discover on first call, returns endpoints", async () => {
    let calls = 0;
    const cfg = stubConfig();
    const fakeImpl: OidcClientImpl = {
      discover: async () => {
        calls += 1;
        return {
          config: cfg,
          endpoints: {
            issuer: "https://idp.example.com",
            authorizationEndpoint: "https://idp.example.com/auth",
            tokenEndpoint: "https://idp.example.com/token",
            userinfoEndpoint: "https://idp.example.com/userinfo",
            jwksUri: "https://idp.example.com/jwks",
          },
        };
      },
      buildAuthUrl: () => new URL("https://idp.example.com/auth"),
      exchangeCode: async () => ({ accessToken: "", idToken: null, sub: null }),
      fetchUserInfo: async () => ({
        sub: "",
        email: null,
        emailVerified: null,
        name: null,
        preferredUsername: null,
        rawGroups: null,
      }),
    };
    setOidcClientImplForTesting(fakeImpl);

    const r1 = await discoverOidc({
      issuerUrl: "https://idp.example.com",
      clientId: "kq",
      clientSecret: "s",
    });
    expect(r1.endpoints.issuer).toBe("https://idp.example.com");
    expect(calls).toBe(1);

    // Second call hits the cache (no new impl.discover call).
    const r2 = await discoverOidc({
      issuerUrl: "https://idp.example.com",
      clientId: "kq",
      clientSecret: "s",
    });
    expect(r2.config).toBe(cfg);
    expect(calls).toBe(1);

    // Force=true bypasses the cache.
    const r3 = await discoverOidc({
      issuerUrl: "https://idp.example.com",
      clientId: "kq",
      clientSecret: "s",
      force: true,
    });
    expect(r3.endpoints.issuer).toBe("https://idp.example.com");
    expect(calls).toBe(2);
  });

  test("different (issuer, clientId) produces independent cache entries", async () => {
    let calls = 0;
    setOidcClientImplForTesting({
      discover: async ({ issuerUrl }) => {
        calls += 1;
        return {
          config: stubConfig({ issuer: issuerUrl }),
          endpoints: {
            issuer: issuerUrl,
            authorizationEndpoint: null,
            tokenEndpoint: null,
            userinfoEndpoint: null,
            jwksUri: null,
          },
        };
      },
      buildAuthUrl: () => new URL("https://x/"),
      exchangeCode: async () => ({ accessToken: "", idToken: null, sub: null }),
      fetchUserInfo: async () => ({
        sub: "",
        email: null,
        emailVerified: null,
        name: null,
        preferredUsername: null,
        rawGroups: null,
      }),
    });
    await discoverOidc({ issuerUrl: "https://a", clientId: "x", clientSecret: "" });
    await discoverOidc({ issuerUrl: "https://b", clientId: "x", clientSecret: "" });
    expect(calls).toBe(2);
  });

  test("passes insecure discovery flag to the backing client", async () => {
    let allowInsecureIssuer: boolean | undefined;
    setOidcClientImplForTesting({
      discover: async (input) => {
        allowInsecureIssuer = input.allowInsecureIssuer;
        return {
          config: stubConfig({ issuer: input.issuerUrl }),
          endpoints: {
            issuer: input.issuerUrl,
            authorizationEndpoint: null,
            tokenEndpoint: null,
            userinfoEndpoint: null,
            jwksUri: null,
          },
        };
      },
      buildAuthUrl: () => new URL("https://x/"),
      exchangeCode: async () => ({ accessToken: "", idToken: null, sub: null }),
      fetchUserInfo: async () => ({
        sub: "",
        email: null,
        emailVerified: null,
        name: null,
        preferredUsername: null,
        rawGroups: null,
      }),
    });

    await discoverOidc({
      issuerUrl: "http://casdoor.localhost:15180/sso",
      clientId: "kuintessence-server",
      clientSecret: "",
      allowInsecureIssuer: true,
    });

    expect(allowInsecureIssuer).toBe(true);
  });
});

describe("buildOidcAuthUrl", () => {
  test("returns URL + state + codeVerifier", async () => {
    const captured: { codeChallengeMethod?: string; scope?: string } = {};
    setOidcClientImplForTesting({
      discover: async () => {
        throw new Error("not used");
      },
      buildAuthUrl: (_cfg, params) => {
        captured.codeChallengeMethod = params.codeChallengeMethod;
        captured.scope = params.scope;
        return new URL(
          `https://idp.example.com/auth?state=${params.state}&code_challenge=${params.codeChallenge}`,
        );
      },
      exchangeCode: async () => ({ accessToken: "", idToken: null, sub: null }),
      fetchUserInfo: async () => ({
        sub: "",
        email: null,
        emailVerified: null,
        name: null,
        preferredUsername: null,
        rawGroups: null,
      }),
    });

    const result = await buildOidcAuthUrl(stubConfig(), {
      redirectUri: "https://kq.example/api/auth/oidc/callback",
      scope: "openid profile email groups",
    });
    expect(result.url).toContain("https://idp.example.com/auth");
    expect(result.url).toContain(`state=${result.state}`);
    expect(result.codeVerifier.length).toBeGreaterThanOrEqual(43); // PKCE min
    expect(captured.codeChallengeMethod).toBe("S256");
    expect(captured.scope).toBe("openid profile email groups");
  });

  test("scope defaults to 'openid profile email groups'", async () => {
    let scope = "";
    setOidcClientImplForTesting({
      discover: async () => {
        throw new Error("not used");
      },
      buildAuthUrl: (_cfg, params) => {
        scope = params.scope;
        return new URL("https://idp.example.com/auth");
      },
      exchangeCode: async () => ({ accessToken: "", idToken: null, sub: null }),
      fetchUserInfo: async () => ({
        sub: "",
        email: null,
        emailVerified: null,
        name: null,
        preferredUsername: null,
        rawGroups: null,
      }),
    });
    await buildOidcAuthUrl(stubConfig(), {
      redirectUri: "https://kq.example/api/auth/oidc/callback",
    });
    expect(scope).toBe("openid profile email groups");
  });
});

describe("completeOidcCallback", () => {
  function setupMock(opts: {
    sub?: string | null;
    email?: string | null;
    name?: string | null;
    rawGroups?: unknown;
    tokenClaims?: Record<string, unknown>;
  }) {
    setOidcClientImplForTesting({
      discover: async () => {
        throw new Error("not used");
      },
      buildAuthUrl: () => new URL("https://idp.example.com/auth"),
      exchangeCode: async () => ({
        accessToken: "test-access-token",
        idToken: "id-token",
        sub: opts.sub === undefined ? "user-sub-123" : opts.sub,
        claims: opts.tokenClaims,
      }),
      fetchUserInfo: async () => ({
        sub: "user-sub-123",
        email: opts.email === undefined ? "user@example.com" : opts.email,
        emailVerified: true,
        name: opts.name === undefined ? "Alice Example" : opts.name,
        preferredUsername: null,
        rawGroups: opts.rawGroups,
      }),
    });
  }

  test("resolves role from group claim via group mapping", async () => {
    setupMock({ rawGroups: ["platform-admins"] });
    const result = await completeOidcCallback({
      config: stubConfig(),
      callbackUrl: new URL("https://kq.example/cb?code=c&state=s"),
      expectedState: "s",
      codeVerifier: "v",
      groupMapping: { "platform-admins": "platform_admin" },
    });
    expect(result.sub).toBe("user-sub-123");
    expect(result.email).toBe("user@example.com");
    expect(result.displayName).toBe("Alice Example");
    expect(result.groups).toEqual(["platform-admins"]);
    expect(result.resolvedRole).toBe("platform_admin");
  });

  test("resolves platform operator from group mapping", async () => {
    setupMock({ rawGroups: ["operators"] });
    const result = await completeOidcCallback({
      config: stubConfig(),
      callbackUrl: new URL("https://kq.example/cb?code=c&state=s"),
      expectedState: "s",
      codeVerifier: "v",
      groupMapping: { operators: "operator" },
    });
    expect(result.resolvedRole).toBe("operator");
  });

  test("defaults to 'user' role when no group matches mapping", async () => {
    setupMock({ rawGroups: ["random-group"] });
    const result = await completeOidcCallback({
      config: stubConfig(),
      callbackUrl: new URL("https://kq.example/cb?code=c&state=s"),
      expectedState: "s",
      codeVerifier: "v",
      groupMapping: { admins: "platform_admin" },
    });
    expect(result.resolvedRole).toBe("user");
    expect(result.groups).toEqual(["random-group"]);
  });

  test("handles missing groups claim", async () => {
    setupMock({ rawGroups: undefined });
    const result = await completeOidcCallback({
      config: stubConfig(),
      callbackUrl: new URL("https://kq.example/cb?code=c&state=s"),
      expectedState: "s",
      codeVerifier: "v",
      groupMapping: {},
    });
    expect(result.groups).toEqual([]);
    expect(result.resolvedRole).toBe("user");
  });

  test("falls back to ID token claims when userinfo omits email and groups", async () => {
    setupMock({
      email: null,
      rawGroups: undefined,
      tokenClaims: {
        email: "casdoor-admin@example.com",
        email_verified: true,
        groups: ["kq-platform-admins"],
      },
    });
    const result = await completeOidcCallback({
      config: stubConfig(),
      callbackUrl: new URL("https://kq.example/cb?code=c&state=s"),
      expectedState: "s",
      codeVerifier: "v",
      groupMapping: { "kq-platform-admins": "platform_admin" },
    });
    expect(result.email).toBe("casdoor-admin@example.com");
    expect(result.emailVerified).toBe(true);
    expect(result.groups).toEqual(["kq-platform-admins"]);
    expect(result.resolvedRole).toBe("platform_admin");
  });

  test("highest-priority role wins on multi-group user", async () => {
    setupMock({ rawGroups: ["user-group", "admin-group"] });
    const result = await completeOidcCallback({
      config: stubConfig(),
      callbackUrl: new URL("https://kq.example/cb?code=c&state=s"),
      expectedState: "s",
      codeVerifier: "v",
      groupMapping: {
        "user-group": "user",
        "admin-group": "platform_admin",
      },
    });
    expect(result.resolvedRole).toBe("platform_admin");
  });

  test("rejects when token exchange returns no sub", async () => {
    setupMock({ sub: null });
    await expect(
      completeOidcCallback({
        config: stubConfig(),
        callbackUrl: new URL("https://kq.example/cb?code=c&state=s"),
        expectedState: "s",
        codeVerifier: "v",
        groupMapping: {},
      }),
    ).rejects.toThrow(/no subject claim/);
  });

  test("falls back to preferredUsername when name is null", async () => {
    setOidcClientImplForTesting({
      discover: async () => {
        throw new Error("not used");
      },
      buildAuthUrl: () => new URL("https://idp.example.com/auth"),
      exchangeCode: async () => ({
        accessToken: "t",
        idToken: null,
        sub: "u",
      }),
      fetchUserInfo: async () => ({
        sub: "u",
        email: "u@x",
        emailVerified: false,
        name: null,
        preferredUsername: "alice",
        rawGroups: null,
      }),
    });
    const result = await completeOidcCallback({
      config: stubConfig(),
      callbackUrl: new URL("https://kq.example/cb?code=c&state=s"),
      expectedState: "s",
      codeVerifier: "v",
      groupMapping: {},
    });
    expect(result.displayName).toBe("alice");
  });
});
