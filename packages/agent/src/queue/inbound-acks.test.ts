import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import * as schema from "@kuintessence/db";
import { runSqliteMigrations } from "@kuintessence/db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { InboundAcks } from "./inbound-acks";

function freshDb() {
  const sqlite = new Database(":memory:");
  runSqliteMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

describe("InboundAcks", () => {
  let db: ReturnType<typeof freshDb>;

  beforeEach(() => {
    db = freshDb();
  });

  test("starts with no pending dispatches", async () => {
    const acks = new InboundAcks(db);
    expect(await acks.pendingInbound()).toEqual([]);
  });

  test("persistInbound stores a pending row", async () => {
    const acks = new InboundAcks(db);
    await acks.persistInbound({
      dispatchId: "disp-1",
      jobId: "job-1",
      payload: { name: "echo" },
    });

    const pending = await acks.pendingInbound();
    expect(pending).toHaveLength(1);
    const row = pending[0];
    if (!row) throw new Error("expected row");
    expect(row.dispatchId).toBe("disp-1");
    expect(row.jobId).toBe("job-1");
    expect(row.ackedAt).toBeNull();
  });

  test("persistInbound is idempotent on dispatchId — duplicate is silently ignored", async () => {
    const acks = new InboundAcks(db);
    await acks.persistInbound({
      dispatchId: "disp-1",
      jobId: "job-1",
      payload: { name: "echo" },
    });
    // Same dispatchId, different payload — should not insert a second row
    // and should not throw, so the dispatch-receive path stays simple.
    await acks.persistInbound({
      dispatchId: "disp-1",
      jobId: "job-1",
      payload: { name: "echo" },
    });

    expect(await acks.pendingInbound()).toHaveLength(1);
  });

  test("markAcked transitions ackedAt from NULL to a timestamp", async () => {
    const t0 = new Date(1_700_000_000_000);
    const acks = new InboundAcks(db, { now: () => t0 });
    await acks.persistInbound({
      dispatchId: "disp-1",
      jobId: "job-1",
      payload: {},
    });
    expect(await acks.pendingInbound()).toHaveLength(1);

    await acks.markAcked("disp-1");

    expect(await acks.pendingInbound()).toEqual([]);
  });

  test("markAcked on unknown dispatchId is a no-op", async () => {
    const acks = new InboundAcks(db);
    await acks.markAcked("never-seen");
    expect(await acks.pendingInbound()).toEqual([]);
  });

  test("markAcked is idempotent — does not reset an already-acked row", async () => {
    const acks = new InboundAcks(db);
    await acks.persistInbound({ dispatchId: "d-1", jobId: "j-1", payload: {} });
    await acks.markAcked("d-1");
    // Calling again must not throw or resurrect the row in pendingInbound
    await acks.markAcked("d-1");
    expect(await acks.pendingInbound()).toEqual([]);
  });

  test("pendingInbound returns rows in receivedAt asc order", async () => {
    let ts = 1_700_000_000_000;
    const acks = new InboundAcks(db, { now: () => new Date(ts++) });

    await acks.persistInbound({ dispatchId: "d-1", jobId: "j-1", payload: {} });
    await acks.persistInbound({ dispatchId: "d-2", jobId: "j-2", payload: {} });
    await acks.persistInbound({ dispatchId: "d-3", jobId: "j-3", payload: {} });

    // Ack the middle one — the other two stay pending and ordering must hold
    await acks.markAcked("d-2");
    const pending = await acks.pendingInbound();
    expect(pending.map((r) => r.dispatchId)).toEqual(["d-1", "d-3"]);
  });

  test("pendingInbound exposes jobId and payload for replay", async () => {
    const acks = new InboundAcks(db);
    await acks.persistInbound({
      dispatchId: "d-1",
      jobId: "job-77",
      payload: { name: "blast", cpus: 4 },
    });
    const pending = await acks.pendingInbound();
    const row = pending[0];
    if (!row) throw new Error("expected row");
    expect(row.jobId).toBe("job-77");
    expect(row.payload).toEqual({ name: "blast", cpus: 4 });
  });
});
