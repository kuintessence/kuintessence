// Test isolation: agent ID prefix `sg-installed-test-agent`.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { agentInstalledSoftware, agents, createPgDb, type PgDb } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { InstalledRegistry } from "./installed-registry";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const AGENT_ID = "sg-installed-test-agent";

async function reset(db: PgDb): Promise<void> {
  await db.delete(agentInstalledSoftware).where(eq(agentInstalledSoftware.agentId, AGENT_ID));
  await db.delete(agents).where(eq(agents.agentId, AGENT_ID));
}

describe("InstalledRegistry", () => {
  let db: PgDb;
  let registry: InstalledRegistry;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    registry = new InstalledRegistry(db);
    await reset(db);
  });

  beforeEach(async () => {
    await reset(db);
    await db.insert(agents).values({
      agentId: AGENT_ID,
      siteName: "sg-test",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
  });

  afterAll(async () => {
    await reset(db);
  });

  test("listForAgent returns [] when no rows", async () => {
    const out = await registry.listForAgent(AGENT_ID);
    expect(out).toEqual([]);
  });

  test("replaceForAgent inserts new rows", async () => {
    await registry.replaceForAgent(AGENT_ID, [
      {
        name: "gromacs",
        version: "2024.1",
        hash: "abc1234",
        spec: "gromacs@2024.1",
      },
      {
        name: "openmpi",
        version: "4.1.5",
        hash: "def5678",
        spec: "openmpi@4.1.5",
      },
    ]);
    const out = await registry.listForAgent(AGENT_ID);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.name).sort()).toEqual(["gromacs", "openmpi"]);
  });

  test("replaceForAgent tolerates duplicate hashes in one report", async () => {
    await registry.replaceForAgent(AGENT_ID, [
      {
        name: "gcc",
        version: "9.4.0",
        hash: "same-hash",
        spec: "gcc@9.4.0",
      },
      {
        name: "gcc-runtime",
        version: "9.4.0",
        hash: "same-hash",
        spec: "gcc-runtime@9.4.0",
      },
    ]);

    const out = await registry.listForAgent(AGENT_ID);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("gcc-runtime");
    expect(out[0]?.spec).toBe("gcc-runtime@9.4.0");
  });

  test("replaceForAgent removes stale rows (delete + upsert)", async () => {
    await registry.replaceForAgent(AGENT_ID, [
      { name: "gromacs", version: "2024.1", hash: "abc1234", spec: "gromacs@2024.1" },
      { name: "openmpi", version: "4.1.5", hash: "def5678", spec: "openmpi@4.1.5" },
    ]);
    // Second push: only gromacs remains, with a different hash (rebuild)
    await registry.replaceForAgent(AGENT_ID, [
      { name: "gromacs", version: "2024.2", hash: "xyz9999", spec: "gromacs@2024.2" },
    ]);
    const out = await registry.listForAgent(AGENT_ID);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("gromacs");
    expect(out[0]?.hash).toBe("xyz9999");
  });

  test("replaceForAgent with empty list clears the agent", async () => {
    await registry.replaceForAgent(AGENT_ID, [
      { name: "gromacs", version: "2024.1", hash: "abc1234", spec: "gromacs@2024.1" },
    ]);
    await registry.replaceForAgent(AGENT_ID, []);
    const out = await registry.listForAgent(AGENT_ID);
    expect(out).toEqual([]);
  });

  test("replaceForAgent serializes concurrent refreshes for one agent", async () => {
    await Promise.all([
      registry.replaceForAgent(AGENT_ID, [
        { name: "gcc", version: "9.4.0", hash: "hash-a", spec: "gcc@9.4.0" },
        { name: "glibc", version: "2.31", hash: "hash-b", spec: "glibc@2.31" },
      ]),
      registry.replaceForAgent(AGENT_ID, [
        { name: "gmake", version: "4.4.1", hash: "hash-c", spec: "gmake@4.4.1" },
      ]),
    ]);

    const out = await registry.listForAgent(AGENT_ID);
    expect(out.length).toBeGreaterThan(0);
    expect(new Set(out.map((r) => r.hash)).size).toBe(out.length);
  });
});
