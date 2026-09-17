import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createPgDb, type PgDb, ssoConfig } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { DEFAULT_SSO_CONFIG, loadSsoConfig, saveSsoConfig } from "./sso-config-store";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const db: PgDb = createPgDb(TEST_DB_URL);

async function clearSsoConfig() {
  await db.delete(ssoConfig).where(eq(ssoConfig.singletonId, "default"));
}

afterAll(async () => {
  await clearSsoConfig();
});

describe("sso-config-store", () => {
  beforeEach(async () => {
    await clearSsoConfig();
  });

  test("loadSsoConfig returns DEFAULT when no row exists", async () => {
    const cfg = await loadSsoConfig(db);
    expect(cfg).toEqual(DEFAULT_SSO_CONFIG);
  });

  test("saveSsoConfig inserts a new row", async () => {
    await saveSsoConfig(db, {
      enabled: true,
      providerType: "oidc",
      providerDisplayName: "Research SSO",
      loginWelcomeZh: "欢迎访问科研平台",
      loginWelcomeEn: "Welcome to the research platform",
      issuerUrl: "https://idp.example.com",
      clientId: "kq-client",
      clientSecretEncrypted: "ciphertext-blob",
      redirectUri: "https://kq.example.com/api/auth/oidc/callback",
      groupMapping: { admins: "platform_admin" },
      autoCreateUsers: true,
      updatedBy: "operator@example.com",
    });

    const cfg = await loadSsoConfig(db);
    expect(cfg.enabled).toBe(true);
    expect(cfg.providerDisplayName).toBe("Research SSO");
    expect(cfg.loginWelcomeZh).toBe("欢迎访问科研平台");
    expect(cfg.loginWelcomeEn).toBe("Welcome to the research platform");
    expect(cfg.issuerUrl).toBe("https://idp.example.com");
    expect(cfg.clientId).toBe("kq-client");
    expect(cfg.clientSecretEncrypted).toBe("ciphertext-blob");
    expect(cfg.redirectUri).toBe("https://kq.example.com/api/auth/oidc/callback");
    expect(cfg.groupMapping).toEqual({ admins: "platform_admin" });
    expect(cfg.autoCreateUsers).toBe(true);
    expect(cfg.updatedBy).toBe("operator@example.com");
    expect(cfg.updatedAt).toBeInstanceOf(Date);
  });

  test("saveSsoConfig upserts (no duplicate row)", async () => {
    await saveSsoConfig(db, {
      enabled: false,
      providerType: "oidc",
      issuerUrl: "https://a.example.com",
      clientId: "a",
      clientSecretEncrypted: "old",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedBy: "x@a",
    });
    await saveSsoConfig(db, {
      enabled: true,
      providerType: "oidc",
      issuerUrl: "https://b.example.com",
      clientId: "b",
      clientSecretEncrypted: "new",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: false,
      updatedBy: "y@b",
    });
    const rows = await db.select().from(ssoConfig);
    expect(rows.length).toBe(1);
    const cfg = await loadSsoConfig(db);
    expect(cfg.enabled).toBe(true);
    expect(cfg.issuerUrl).toBe("https://b.example.com");
    expect(cfg.clientId).toBe("b");
    expect(cfg.clientSecretEncrypted).toBe("new");
    expect(cfg.autoCreateUsers).toBe(false);
  });

  test("saveSsoConfig with keepExistingSecret preserves the encrypted blob", async () => {
    await saveSsoConfig(db, {
      enabled: true,
      providerType: "oidc",
      issuerUrl: "https://a.example.com",
      clientId: "a",
      clientSecretEncrypted: "preserved-blob",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedBy: "x@a",
    });
    await saveSsoConfig(db, {
      enabled: false,
      providerType: "oidc",
      issuerUrl: "https://a.example.com",
      clientId: "a",
      keepExistingSecret: true,
      redirectUri: "",
      groupMapping: { foo: "user" },
      autoCreateUsers: false,
      updatedBy: "x@a",
    });
    const cfg = await loadSsoConfig(db);
    expect(cfg.clientSecretEncrypted).toBe("preserved-blob");
    expect(cfg.enabled).toBe(false);
    expect(cfg.groupMapping).toEqual({ foo: "user" });
  });

  test("saveSsoConfig without secret + without keepExistingSecret clears it", async () => {
    await saveSsoConfig(db, {
      enabled: true,
      providerType: "oidc",
      issuerUrl: "https://a",
      clientId: "a",
      clientSecretEncrypted: "old-blob",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedBy: "x@a",
    });
    await saveSsoConfig(db, {
      enabled: false,
      providerType: "oidc",
      issuerUrl: "https://a",
      clientId: "a",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedBy: "x@a",
    });
    const cfg = await loadSsoConfig(db);
    expect(cfg.clientSecretEncrypted).toBe("");
  });

  test("groupMapping JSONB round-trips arbitrary keys", async () => {
    const mapping = {
      "platform-admins": "platform_admin",
      "research/group with space": "user",
      中文组: "org_admin",
    } as const;
    await saveSsoConfig(db, {
      enabled: true,
      providerType: "oidc",
      issuerUrl: "https://idp",
      clientId: "k",
      redirectUri: "",
      groupMapping: { ...mapping },
      autoCreateUsers: true,
      updatedBy: "x",
    });
    const cfg = await loadSsoConfig(db);
    expect(cfg.groupMapping).toEqual(mapping);
  });
});
