// Test isolation: test agent ID prefix `sg-policy-test-agent`.
// Each suite touching software_policies / agents must use a distinct prefix
// so parallel runs don't collide.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { agents, createPgDb, type PgDb, softwarePolicies } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { PolicyStore } from "./policy-store";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const AGENT_A = "sg-policy-test-agent-a";
const AGENT_B = "sg-policy-test-agent-b";

async function resetAgent(db: PgDb, agentId: string): Promise<void> {
  await db.delete(softwarePolicies).where(eq(softwarePolicies.agentId, agentId));
  await db.delete(agents).where(eq(agents.agentId, agentId));
}

describe("PolicyStore", () => {
  let db: PgDb;
  let store: PolicyStore;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    store = new PolicyStore(db);
    await resetAgent(db, AGENT_A);
    await resetAgent(db, AGENT_B);
  });

  beforeEach(async () => {
    await db.delete(softwarePolicies).where(eq(softwarePolicies.agentId, AGENT_A));
    await db.delete(softwarePolicies).where(eq(softwarePolicies.agentId, AGENT_B));
    await db.delete(agents).where(eq(agents.agentId, AGENT_A));
    await db.delete(agents).where(eq(agents.agentId, AGENT_B));
    // Insert agents A + B
    for (const id of [AGENT_A, AGENT_B]) {
      await db.insert(agents).values({
        agentId: id,
        siteName: "sg-test",
        schedulerType: "slurm",
        schedulerVersion: "23.02.7",
      });
    }
  });

  afterAll(async () => {
    await resetAgent(db, AGENT_A);
    await resetAgent(db, AGENT_B);
  });

  test("getForAgent returns null when no policy stored", async () => {
    const out = await store.getForAgent(AGENT_A);
    expect(out).toBeNull();
  });

  test("upsertForAgent inserts a new row with a version stamp", async () => {
    const stored = await store.upsertForAgent(AGENT_A, {
      allowList: ["gromacs@*"],
      denyList: [],
      lockEnabled: true,
      mirrors: [{ name: "central", url: "https://mirror.example.com" }],
      preinstallList: [],
    });
    expect(stored.agentId).toBe(AGENT_A);
    expect(stored.lockEnabled).toBe(true);
    expect(stored.allowList).toEqual(["gromacs@*"]);
    expect(stored.version).toBeDefined();
    expect(stored.version.length).toBeGreaterThan(0);
  });

  test("upsertForAgent twice produces a distinct version stamp", async () => {
    const previousPolicy = await store.upsertForAgent(AGENT_A, {
      allowList: [],
      denyList: [],
      lockEnabled: false,
      mirrors: [],
      preinstallList: [],
    });
    const updatedPolicy = await store.upsertForAgent(AGENT_A, {
      allowList: ["gromacs@*"],
      denyList: [],
      lockEnabled: false,
      mirrors: [],
      preinstallList: [],
    });
    expect(updatedPolicy.version).not.toBe(previousPolicy.version);
    expect(updatedPolicy.allowList).toEqual(["gromacs@*"]);
  });

  test("listAll returns rows for all agents", async () => {
    await store.upsertForAgent(AGENT_A, {
      allowList: ["a@*"],
      denyList: [],
      lockEnabled: false,
      mirrors: [],
      preinstallList: [],
    });
    await store.upsertForAgent(AGENT_B, {
      allowList: ["b@*"],
      denyList: [],
      lockEnabled: true,
      mirrors: [],
      preinstallList: [],
    });
    const all = await store.listAll();
    const ids = all.map((r) => r.agentId);
    expect(ids).toContain(AGENT_A);
    expect(ids).toContain(AGENT_B);
  });

  test("getForAgent returns latest after upsert", async () => {
    await store.upsertForAgent(AGENT_A, {
      allowList: [],
      denyList: ["bad@*"],
      lockEnabled: false,
      mirrors: [],
      preinstallList: [],
    });
    const got = await store.getForAgent(AGENT_A);
    expect(got?.denyList).toEqual(["bad@*"]);
  });
});
