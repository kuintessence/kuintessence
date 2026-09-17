import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentCerts, agents, auditLog, createPgDb, type PgDb } from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
import { createPgAgentCertLookup, createPgCertStore } from "./pg-cert-store";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("PG CertStore", () => {
  let db: PgDb;
  const TEST_AGENT = "agent-test-pgcert";

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    // Idempotent agent row for FK
    await db
      .insert(agents)
      .values({
        agentId: TEST_AGENT,
        siteName: "test-site",
        schedulerType: "slurm",
        schedulerVersion: "20.11",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(agentCerts).where(eq(agentCerts.agentId, TEST_AGENT));
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.action, "agent_cert_issued"), eq(auditLog.target, TEST_AGENT)));
    await db.delete(agents).where(eq(agents.agentId, TEST_AGENT));
  });

  test("insertCert persists row and lookup retrieves agentId", async () => {
    const store = createPgCertStore(db);
    const lookup = createPgAgentCertLookup(db);
    const fp = `aabbccdd${"0".repeat(56)}`;
    await store.insertCert({
      agentId: TEST_AGENT,
      fingerprintSha256: fp,
      subjectCn: TEST_AGENT,
      certPem: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      revokedAt: null,
      issuedBy: null,
    });

    const row = await lookup(fp);
    expect(row).not.toBeNull();
    expect(row?.agentId).toBe(TEST_AGENT);
    expect(row?.revokedAt).toBeNull();
  });

  test("revokeByFingerprint sets revoked_at and lookup reflects it", async () => {
    const store = createPgCertStore(db);
    const lookup = createPgAgentCertLookup(db);
    const fp = `bbccdd00${"1".repeat(56)}`;
    await store.insertCert({
      agentId: TEST_AGENT,
      fingerprintSha256: fp,
      subjectCn: TEST_AGENT,
      certPem: "x",
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
      issuedBy: null,
    });

    const beforeRev = await lookup(fp);
    expect(beforeRev?.revokedAt).toBeNull();

    await store.revokeByFingerprint(fp, new Date());
    const afterRev = await lookup(fp);
    expect(afterRev?.revokedAt).toBeInstanceOf(Date);
  });

  test("lookup returns null for unknown fingerprint", async () => {
    const lookup = createPgAgentCertLookup(db);
    const row = await lookup("0".repeat(64));
    expect(row).toBeNull();
  });

  test("appendAudit writes audit_log row", async () => {
    const store = createPgCertStore(db);
    await store.appendAudit({
      actor: "user-pgtest",
      action: "agent_cert_issued",
      target: TEST_AGENT,
      diff: { after: { fingerprint: "x" } },
    });
    const rows = await db.select().from(auditLog).where(eq(auditLog.actor, "user-pgtest"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.action).toBe("agent_cert_issued");
    // Cleanup
    await db.delete(auditLog).where(eq(auditLog.actor, "user-pgtest"));
  });
});
