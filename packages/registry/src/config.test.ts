import { describe, expect, test } from "bun:test";
import { loadRegistryConfig } from "./config";

const VALID_BASE = {
  DATABASE_URL: "postgres://kq:kq@localhost:5432/kuintessence",
};

describe("loadRegistryConfig", () => {
  test("DB pool config defaults to postgres-js compatible values", () => {
    const cfg = loadRegistryConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.DB_MAX_CONNECTIONS).toBe(10);
    expect(cfg.DB_IDLE_TIMEOUT_SEC).toBe(0);
  });

  test("DB pool config honors operator overrides", () => {
    const cfg = loadRegistryConfig({
      ...VALID_BASE,
      DB_MAX_CONNECTIONS: "3",
      DB_IDLE_TIMEOUT_SEC: "30",
    } as NodeJS.ProcessEnv);
    expect(cfg.DB_MAX_CONNECTIONS).toBe(3);
    expect(cfg.DB_IDLE_TIMEOUT_SEC).toBe(30);
  });

  test("loads the shared publisher role contract", () => {
    expect(
      loadRegistryConfig({ ...VALID_BASE } as NodeJS.ProcessEnv).REGISTRY_PUBLISHER_ROLES,
    ).toEqual(["super_admin", "platform_admin", "org_admin"]);
    expect(
      loadRegistryConfig({
        ...VALID_BASE,
        REGISTRY_PUBLISHER_ROLES: "platform_admin,operator",
      } as NodeJS.ProcessEnv).REGISTRY_PUBLISHER_ROLES,
    ).toEqual(["platform_admin", "operator"]);
  });

  test("ecosystem releases require explicit activation by default", () => {
    expect(
      loadRegistryConfig({ ...VALID_BASE } as NodeJS.ProcessEnv).ECOSYSTEM_RELEASE_AUTO_ACTIVATE,
    ).toBe(false);
    expect(
      loadRegistryConfig({
        ...VALID_BASE,
        ECOSYSTEM_RELEASE_AUTO_ACTIVATE: "true",
      } as NodeJS.ProcessEnv).ECOSYSTEM_RELEASE_AUTO_ACTIVATE,
    ).toBe(true);
  });
});
