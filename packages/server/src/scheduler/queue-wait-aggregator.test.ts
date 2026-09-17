import { describe, expect, test } from "bun:test";
import { aggregateP95ByAgent, QueueWaitAggregator } from "./queue-wait-aggregator";

describe("aggregateP95ByAgent (pure)", () => {
  test("groups wait seconds by agent and takes p95", () => {
    const rows = [
      { agentId: "a", waitSec: 10 },
      { agentId: "a", waitSec: 20 },
      { agentId: "a", waitSec: 1000 },
      { agentId: "b", waitSec: 5 },
    ];
    const out = aggregateP95ByAgent(rows);
    expect(out.get("a")).toBe(1000);
    expect(out.get("b")).toBe(5);
  });

  test("empty input -> empty map", () => {
    expect(aggregateP95ByAgent([]).size).toBe(0);
  });

  test("rounds p95 to an integer", () => {
    const out = aggregateP95ByAgent([
      { agentId: "a", waitSec: 1.4 },
      { agentId: "a", waitSec: 1.4 },
    ]);
    expect(out.get("a")).toBe(1);
  });
});

// PG-backed: requires a live Postgres. recomputeAll selects from `jobs`, computes
// wait = startedAt - submittedAt, and UPDATEs agents.historicalP95WaitSec. Without
// DATABASE_URL this would throw at the query — deferred to a Postgres box. The
// type wiring is proven by `bun run --filter '@kuintessence/server' typecheck`.
describe.skip("QueueWaitAggregator.recomputeAll (PG-backed, deferred)", () => {
  test("writes per-agent P95 wait to agents.historicalP95WaitSec", async () => {
    const { createPgDb } = await import("@kuintessence/db");
    const db = createPgDb(process.env.DATABASE_URL ?? "");
    const aggregator = new QueueWaitAggregator(db);
    const updated = await aggregator.recomputeAll();
    expect(typeof updated).toBe("number");
  });
});
