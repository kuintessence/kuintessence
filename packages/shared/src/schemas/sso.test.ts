import { describe, expect, test } from "bun:test";
import {
  resolveRoleFromGroups,
  SSO_SECRET_REDACTED,
  SsoConfigUpdateSchema,
  SsoConfigViewSchema,
  SsoGroupMappingSchema,
  SsoPublicConfigSchema,
  SsoTestRequestSchema,
} from "./sso";

describe("SsoGroupMappingSchema", () => {
  test("accepts a flat group→role record", () => {
    const out = SsoGroupMappingSchema.parse({
      "platform-admins": "platform_admin",
      operators: "operator",
      researchers: "user",
    });
    expect(out["platform-admins"]).toBe("platform_admin");
    expect(out.operators).toBe("operator");
  });

  test("rejects empty group key", () => {
    expect(() => SsoGroupMappingSchema.parse({ "": "user" })).toThrow();
  });

  test("rejects unknown role value", () => {
    expect(() => SsoGroupMappingSchema.parse({ admins: "ceo" })).toThrow();
  });
});

describe("SsoConfigUpdateSchema", () => {
  test("applies defaults when fields are missing", () => {
    const out = SsoConfigUpdateSchema.parse({});
    expect(out.enabled).toBe(false);
    expect(out.providerType).toBe("oidc");
    expect(out.providerDisplayName).toBe("");
    expect(out.loginWelcomeZh).toBe("");
    expect(out.loginWelcomeEn).toBe("");
    expect(out.autoCreateUsers).toBe(true);
    expect(out.groupMapping).toEqual({});
    expect(out.issuerUrl).toBe("");
    expect(out.clientId).toBe("");
    expect(out.redirectUri).toBe("");
  });

  test("accepts a fully filled-out OIDC config", () => {
    const out = SsoConfigUpdateSchema.parse({
      enabled: true,
      providerType: "oidc",
      issuerUrl: "https://idp.example.com",
      clientId: "kuintessence",
      clientSecret: "s3cret",
      redirectUri: "https://kq.example.com/api/auth/oidc/callback",
      groupMapping: { admins: "platform_admin" },
      autoCreateUsers: true,
    });
    expect(out.enabled).toBe(true);
    expect(out.clientSecret).toBe("s3cret");
  });

  test("clientSecret is optional on update (rotation: keep existing)", () => {
    const out = SsoConfigUpdateSchema.parse({
      enabled: true,
      issuerUrl: "https://idp.example.com",
      clientId: "kq",
    });
    expect(out.clientSecret).toBeUndefined();
  });

  test("rejects malformed issuer URL when non-empty", () => {
    expect(() =>
      SsoConfigUpdateSchema.parse({
        enabled: true,
        issuerUrl: "not-a-url",
        clientId: "kq",
      }),
    ).toThrow();
  });
});

describe("SsoConfigViewSchema", () => {
  test("accepts redacted secret marker", () => {
    const out = SsoConfigViewSchema.parse({
      enabled: false,
      providerType: "oidc",
      providerDisplayName: "",
      loginWelcomeZh: "",
      loginWelcomeEn: "",
      issuerUrl: "",
      clientId: "",
      clientSecret: SSO_SECRET_REDACTED,
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedAt: null,
      updatedBy: null,
    });
    expect(out.clientSecret).toBe(SSO_SECRET_REDACTED);
  });

  test("rejects raw secret value (must be redacted)", () => {
    expect(() =>
      SsoConfigViewSchema.parse({
        enabled: true,
        providerType: "oidc",
        providerDisplayName: "Research SSO",
        loginWelcomeZh: "欢迎访问科研平台",
        loginWelcomeEn: "Welcome to the research platform",
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "real-secret-leaked",
        redirectUri: "",
        groupMapping: {},
        autoCreateUsers: true,
        updatedAt: null,
        updatedBy: null,
      }),
    ).toThrow();
  });
});

describe("SsoTestRequestSchema", () => {
  test("accepts a discovery probe payload", () => {
    const out = SsoTestRequestSchema.parse({
      issuerUrl: "https://idp.example.com",
      clientId: "kq",
    });
    expect(out.clientSecret).toBeUndefined();
  });

  test("rejects bad URL", () => {
    expect(() =>
      SsoTestRequestSchema.parse({
        issuerUrl: "not a url at all",
        clientId: "kq",
      }),
    ).toThrow();
  });
});

describe("SsoPublicConfigSchema", () => {
  test("public read carries user-facing login display metadata", () => {
    const out = SsoPublicConfigSchema.parse({
      enabled: true,
      providerName: "Acme SSO",
      welcomeMessage: { zh: "欢迎", en: "Welcome" },
    });
    expect(out.enabled).toBe(true);
    expect(out.providerName).toBe("Acme SSO");
    expect(out.welcomeMessage.zh).toBe("欢迎");
  });
});

describe("resolveRoleFromGroups", () => {
  const mapping = {
    "platform-admins": "platform_admin",
    operators: "operator",
    "org-admins": "org_admin",
    researchers: "user",
  } as const;

  test("returns 'user' when group list is empty", () => {
    expect(resolveRoleFromGroups([], mapping)).toBe("user");
  });

  test("returns 'user' default when no group matches mapping", () => {
    expect(resolveRoleFromGroups(["unknown-group"], mapping)).toBe("user");
  });

  test("maps a single matching group", () => {
    expect(resolveRoleFromGroups(["researchers"], mapping)).toBe("user");
    expect(resolveRoleFromGroups(["operators"], mapping)).toBe("operator");
    expect(resolveRoleFromGroups(["platform-admins"], mapping)).toBe("platform_admin");
  });

  test("picks highest-priority role when user is in multiple groups", () => {
    expect(resolveRoleFromGroups(["researchers", "platform-admins", "operators"], mapping)).toBe(
      "platform_admin",
    );
  });

  test("ignores groups not present in the mapping", () => {
    expect(resolveRoleFromGroups(["random-group", "researchers"], mapping)).toBe("user");
  });

  test("super_admin beats platform_admin when both are mapped", () => {
    const m = { sa: "super_admin", pa: "platform_admin" } as const;
    expect(resolveRoleFromGroups(["pa", "sa"], m)).toBe("super_admin");
  });

  test("operator beats org_admin but not platform_admin", () => {
    expect(resolveRoleFromGroups(["org-admins", "operators"], mapping)).toBe("operator");
    expect(resolveRoleFromGroups(["operators", "platform-admins"], mapping)).toBe("platform_admin");
  });
});
