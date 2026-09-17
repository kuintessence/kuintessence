import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentMetrics, agents, createPgDb, orgs, type PgDb } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import {
  emptyQueueObservabilitySnapshot,
  QUEUE_SHADOW_REJECTION_METRIC,
  type QueueObservabilityEvent,
  QueueObservabilityService,
} from "./queue-observability";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const TEST_RUN_ID = crypto.randomUUID();
const AGENT_ID = `queue-observability-test-agent-${TEST_RUN_ID}`;

describe("QueueObservabilityService", () => {
  let db: PgDb;
  let observability: QueueObservabilityService;
  let providerOrgId: string;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    const [provider] = await db
      .insert(orgs)
      .values({ name: `queue-observability-test-provider-${TEST_RUN_ID}` })
      .returning();
    if (!provider) throw new Error("failed to create queue observability test provider");
    providerOrgId = provider.id;
    await db.insert(agents).values({
      agentId: AGENT_ID,
      siteName: "queue-observability-test-site",
      providerOrgId,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      status: "online",
    });
    observability = new QueueObservabilityService(db, {
      getCoverage: async () => emptyQueueObservabilitySnapshot().coverage,
    });
  });

  afterAll(async () => {
    await db.delete(agents).where(eq(agents.agentId, AGENT_ID));
    await db.delete(orgs).where(eq(orgs.id, providerOrgId));
  });

  test("increments the persistent counter only for the first durable event claim", async () => {
    const before = (await observability.snapshot()).failures.shadowRejections.QUEUE_CHANGED;
    const event: QueueObservabilityEvent = {
      agentId: AGENT_ID,
      eventId: `queue-observability-event-${TEST_RUN_ID}`,
      metric: QUEUE_SHADOW_REJECTION_METRIC,
      failureCode: "QUEUE_CHANGED",
    };

    expect(await observability.recordEvent(event)).toBe(true);
    expect(await observability.recordEvent(event)).toBe(false);

    const after = (await observability.snapshot()).failures.shadowRejections.QUEUE_CHANGED;
    expect(after - before).toBe(1);
  });

  test("keeps counters across service recreation and raw telemetry retention", async () => {
    await observability.recordEvent({
      agentId: AGENT_ID,
      eventId: `queue-observability-retention-${TEST_RUN_ID}`,
      metric: QUEUE_SHADOW_REJECTION_METRIC,
      failureCode: "QUEUE_NOT_FOUND",
    });
    await db.insert(agentMetrics).values({
      agentId: AGENT_ID,
      metric: "queue_validation_shadow_rejection",
      value: 1,
      payload: { failureCode: "QUEUE_NOT_FOUND" },
    });
    const beforeRetention = (await observability.snapshot()).failures.shadowRejections
      .QUEUE_NOT_FOUND;

    await db.delete(agentMetrics).where(eq(agentMetrics.agentId, AGENT_ID));
    const recreated = new QueueObservabilityService(db, {
      getCoverage: async () => emptyQueueObservabilitySnapshot().coverage,
    });

    expect((await recreated.snapshot()).failures.shadowRejections.QUEUE_NOT_FOUND).toBe(
      beforeRetention,
    );
  });
});
