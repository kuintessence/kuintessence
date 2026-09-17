import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { desensitizeConfig as cfgTable, createPgDb, type PgDb } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { loadDesensitizeConfig } from "./config-loader";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("loadDesensitizeConfig", () => {
  let db: PgDb;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
  });

  beforeEach(async () => {
    // Clean up only rows owned by this test suite (specific field paths).
    await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "test-cfgloader-actorEmail"));
    await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "test-cfgloader-command"));
  });

  afterAll(async () => {
    await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "test-cfgloader-actorEmail"));
    await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "test-cfgloader-command"));
  });

  test("returns globalEnabled=false default with empty config tables", async () => {
    // Note: `globalEnabled` derives from a synthetic field row; if not set,
    // we default to false.
    const cfg = await loadDesensitizeConfig(db);
    expect(cfg.globalEnabled).toBe(false);
  });

  test("derives globalEnabled=true from a synthetic '__enabled__' global row", async () => {
    await db
      .insert(cfgTable)
      .values({ scope: "global", fieldPath: "__enabled__", action: "redact" });
    try {
      const cfg = await loadDesensitizeConfig(db);
      expect(cfg.globalEnabled).toBe(true);
    } finally {
      await db.delete(cfgTable).where(eq(cfgTable.fieldPath, "__enabled__"));
    }
  });

  test("groups rows by scope into providers/clusters/fields", async () => {
    await db.insert(cfgTable).values([
      { scope: "global", fieldPath: "test-cfgloader-actorEmail", action: "hash" },
      {
        scope: "provider",
        scopeId: "p1",
        fieldPath: "test-cfgloader-command",
        action: "redact",
      },
      {
        scope: "cluster",
        scopeId: "c1",
        fieldPath: "test-cfgloader-command",
        action: "hide",
      },
    ]);
    const cfg = await loadDesensitizeConfig(db);
    expect(cfg.fields.some((f) => f.field === "test-cfgloader-actorEmail")).toBe(true);
    expect(cfg.providers.some((p) => p.providerId === "p1")).toBe(true);
    expect(cfg.clusters.some((c) => c.clusterId === "c1")).toBe(true);
  });
});
