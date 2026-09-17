// Test isolation: agent ID prefix `sg-metrics-test-agent`.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { agentMetrics, agents, createPgDb, type PgDb } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { PgAgentMetricsRecorder } from "./metrics-recorder";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const AGENT_ID = "sg-metrics-test-agent";

async function reset(db: PgDb): Promise<void> {
  await db.delete(agentMetrics).where(eq(agentMetrics.agentId, AGENT_ID));
  await db.delete(agents).where(eq(agents.agentId, AGENT_ID));
}

describe("PgAgentMetricsRecorder", () => {
  let db: PgDb;
  let recorder: PgAgentMetricsRecorder;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    recorder = new PgAgentMetricsRecorder(db);
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

  test("record() with empty array is a no-op", async () => {
    await recorder.record([]);
    const rows = await db.select().from(agentMetrics).where(eq(agentMetrics.agentId, AGENT_ID));
    expect(rows).toEqual([]);
  });

  test("record() inserts samples with payload", async () => {
    await recorder.record([
      { agentId: AGENT_ID, metric: "disk_used_percent", value: 55 },
      {
        agentId: AGENT_ID,
        metric: "gpu",
        value: 35,
        payload: { index: 0, model: "A100", memUsedMb: 1024, memTotalMb: 40960 },
      },
    ]);
    const rows = await db.select().from(agentMetrics).where(eq(agentMetrics.agentId, AGENT_ID));
    expect(rows).toHaveLength(2);
    const gpu = rows.find((r) => r.metric === "gpu");
    expect(gpu).toBeDefined();
    expect(gpu?.value).toBe(35);
    expect(gpu?.payload).toMatchObject({ index: 0, model: "A100" });
    const disk = rows.find((r) => r.metric === "disk_used_percent");
    expect(disk?.value).toBe(55);
  });
});
