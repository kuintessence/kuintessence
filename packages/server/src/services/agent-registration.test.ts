import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCsr } from "@kuintessence/agent/auth";
import {
  agentCerts,
  agentRegistrationIntents,
  agents,
  authzOutbox,
  createPgDb,
  orgs,
  type PgDb,
  users,
} from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { ensureCa } from "../auth/ca";
import type { AuthzService, AuthzTuple } from "../authz/service";
import { AgentRegistrationService } from "./agent-registration";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const PROVIDER_ID = "00000000-0000-4000-8000-00000000b001";
const USER_ID = "00000000-0000-4000-8000-00000000b002";
const AGENT_ID = "agent-registration-test-agent";

function capturingAuthz(enqueued: AuthzTuple[]): AuthzService {
  return {
    mode: "enforce",
    enqueueMany: async (tuples: AuthzTuple[]) => {
      enqueued.push(...tuples);
    },
  } as unknown as AuthzService;
}

describe("AgentRegistrationService", () => {
  let db: PgDb;
  let caDir: string;
  let service: AgentRegistrationService;
  let enqueued: AuthzTuple[];

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    caDir = mkdtempSync(join(tmpdir(), "kq-agent-registration-ca-"));
    const ca = await ensureCa(caDir);
    enqueued = [];
    service = new AgentRegistrationService(db, ca, capturingAuthz(enqueued));
  });

  beforeEach(async () => {
    enqueued.length = 0;
    await db.delete(agentCerts).where(eq(agentCerts.agentId, AGENT_ID));
    await db
      .delete(agentRegistrationIntents)
      .where(like(agentRegistrationIntents.agentId, `${AGENT_ID}%`));
    await db.delete(agents).where(like(agents.agentId, `${AGENT_ID}%`));
    await db.delete(authzOutbox).where(eq(authzOutbox.resourceId, AGENT_ID));
    await db
      .insert(orgs)
      .values({ id: PROVIDER_ID, name: "agent-registration-provider" })
      .onConflictDoNothing();
    await db
      .insert(users)
      .values({ id: USER_ID, email: "agent-registration@test.example", role: "platform_admin" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(agentCerts).where(eq(agentCerts.agentId, AGENT_ID));
    await db
      .delete(agentRegistrationIntents)
      .where(like(agentRegistrationIntents.agentId, `${AGENT_ID}%`));
    await db.delete(agents).where(like(agents.agentId, `${AGENT_ID}%`));
    await db.delete(users).where(eq(users.id, USER_ID));
    await db.delete(orgs).where(eq(orgs.id, PROVIDER_ID));
    rmSync(caDir, { recursive: true, force: true });
  });

  test("metadata does not consume token and complete binds provider plus cert", async () => {
    const token = await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site",
      providerOrgId: PROVIDER_ID,
      expiresInSec: 3600,
      createdBy: USER_ID,
    });

    const firstMetadata = await service.metadata(token.token);
    const secondMetadata = await service.metadata(token.token);
    expect(firstMetadata.agentId).toBe(AGENT_ID);
    expect(secondMetadata.agentId).toBe(AGENT_ID);

    const csr = generateCsr({ agentId: AGENT_ID });
    const completed = await service.complete({
      token: token.token,
      csrPem: csr.csrPem,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    expect(completed.certPem).toContain("BEGIN CERTIFICATE");
    expect(completed.caCertPem).toContain("BEGIN CERTIFICATE");

    const [agent] = await db.select().from(agents).where(eq(agents.agentId, AGENT_ID)).limit(1);
    expect(agent?.providerOrgId).toBe(PROVIDER_ID);
    expect(agent?.status).toBe("offline");

    const [cert] = await db
      .select()
      .from(agentCerts)
      .where(eq(agentCerts.agentId, AGENT_ID))
      .limit(1);
    expect(cert?.fingerprintSha256).toBe(completed.fingerprintSha256);

    const [intent] = await db
      .select()
      .from(agentRegistrationIntents)
      .where(eq(agentRegistrationIntents.id, token.id))
      .limit(1);
    expect(intent?.usedAt).toBeInstanceOf(Date);
    expect(intent?.tokenHash).not.toBe(token.token);
    expect(enqueued).toEqual([
      {
        operation: "create",
        resource: { type: "agent", id: AGENT_ID },
        relation: "platform",
        subject: { type: "platform", id: "root" },
      },
      {
        operation: "create",
        resource: { type: "agent", id: AGENT_ID },
        relation: "provider",
        subject: { type: "provider", id: PROVIDER_ID },
      },
    ]);
  });

  test("complete cannot replay a used token", async () => {
    const token = await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site",
      providerOrgId: PROVIDER_ID,
      expiresInSec: 3600,
      createdBy: USER_ID,
    });
    const csr = generateCsr({ agentId: AGENT_ID });
    await service.complete({
      token: token.token,
      csrPem: csr.csrPem,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    await expect(
      service.complete({
        token: token.token,
        csrPem: csr.csrPem,
        schedulerType: "slurm",
        schedulerVersion: "23.02.7",
      }),
    ).rejects.toThrow(/used/i);
  });

  test("invalid and expired tokens are rejected before registration", async () => {
    await expect(service.metadata("kqagt-invalid")).rejects.toThrow(/invalid/i);

    const token = await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site",
      providerOrgId: PROVIDER_ID,
      expiresInSec: -1,
      createdBy: USER_ID,
    });

    await expect(service.metadata(token.token)).rejects.toThrow(/expired/i);
    const csr = generateCsr({ agentId: AGENT_ID });
    await expect(
      service.complete({
        token: token.token,
        csrPem: csr.csrPem,
        schedulerType: "slurm",
        schedulerVersion: "23.02.7",
      }),
    ).rejects.toThrow(/expired/i);
  });

  test("agent id can only have one active registration intent", async () => {
    await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site",
      providerOrgId: PROVIDER_ID,
      expiresInSec: 3600,
      createdBy: USER_ID,
    });

    await expect(
      service.createToken({
        agentId: AGENT_ID,
        siteName: "registration-site-2",
        providerOrgId: PROVIDER_ID,
        expiresInSec: 3600,
        createdBy: USER_ID,
      }),
    ).rejects.toThrow(/active registration token/i);
  });

  test("expired or revoked unused intents release the agent id for reissue", async () => {
    const expired = await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site-expired",
      providerOrgId: PROVIDER_ID,
      expiresInSec: -1,
      createdBy: USER_ID,
    });
    await expect(service.metadata(expired.token)).rejects.toThrow(/expired/i);

    const reissuedAfterExpiry = await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site-reissued",
      providerOrgId: PROVIDER_ID,
      expiresInSec: 3600,
      createdBy: USER_ID,
    });
    expect(reissuedAfterExpiry.agentId).toBe(AGENT_ID);

    await service.revoke({
      id: reissuedAfterExpiry.id,
      providerOrgIds: [PROVIDER_ID],
      isPlatformWide: false,
      revokedBy: USER_ID,
    });
    const reissuedAfterRevoke = await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site-revoked-reissue",
      providerOrgId: PROVIDER_ID,
      expiresInSec: 3600,
      createdBy: USER_ID,
    });
    expect(reissuedAfterRevoke.agentId).toBe(AGENT_ID);
  });

  test("registered agents cannot receive a new registration token", async () => {
    const token = await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site",
      providerOrgId: PROVIDER_ID,
      expiresInSec: 3600,
      createdBy: USER_ID,
    });
    const csr = generateCsr({ agentId: AGENT_ID });
    await service.complete({
      token: token.token,
      csrPem: csr.csrPem,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });

    await expect(
      service.createToken({
        agentId: AGENT_ID,
        siteName: "registration-site-2",
        providerOrgId: PROVIDER_ID,
        expiresInSec: 3600,
        createdBy: USER_ID,
      }),
    ).rejects.toThrow(/already registered/i);
  });

  test("CSR common name must match pre-created agent id", async () => {
    const token = await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site",
      providerOrgId: PROVIDER_ID,
      expiresInSec: 3600,
      createdBy: USER_ID,
    });
    const csr = generateCsr({ agentId: `${AGENT_ID}-other` });

    await expect(
      service.complete({
        token: token.token,
        csrPem: csr.csrPem,
        schedulerType: "slurm",
        schedulerVersion: "23.02.7",
      }),
    ).rejects.toThrow(/CN mismatch/i);

    const [intent] = await db
      .select()
      .from(agentRegistrationIntents)
      .where(eq(agentRegistrationIntents.id, token.id))
      .limit(1);
    expect(intent?.usedAt).toBeNull();
  });

  test("revoked token cannot be used", async () => {
    const token = await service.createToken({
      agentId: AGENT_ID,
      siteName: "registration-site",
      providerOrgId: PROVIDER_ID,
      expiresInSec: 3600,
      createdBy: USER_ID,
    });
    await service.revoke({
      id: token.id,
      providerOrgIds: [PROVIDER_ID],
      isPlatformWide: false,
      revokedBy: USER_ID,
    });

    await expect(service.metadata(token.token)).rejects.toThrow(/revoked/i);
  });
});
