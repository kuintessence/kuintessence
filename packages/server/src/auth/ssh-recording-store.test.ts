import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import type { StoredRecordingMeta } from "../services/ssh-recording";
import {
  insertRecordingRow,
  listRecordings,
  listRecordingsBySessionIds,
  sweepOldRecordings,
} from "./ssh-recording-store";

/** Fake db capturing inserts and serving a fixed select result. */
function fakeDb(rows: unknown[] = []): {
  db: PgDb;
  inserts: Record<string, unknown>[];
  deletes: number;
} {
  const inserts: Record<string, unknown>[] = [];
  const state = { deletes: 0 };
  const selectableRows = () =>
    Object.assign(Promise.resolve(rows), {
      limit: async () => rows,
      orderBy: () => ({ limit: async () => rows }),
    });
  const fromChain = {
    orderBy: () => ({ limit: async () => rows }),
    where: selectableRows,
  };
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserts.push(row);
        return { onConflictDoNothing: async () => {} };
      },
    }),
    select: () => ({ from: () => fromChain }),
    delete: () => ({
      where: async () => {
        state.deletes += 1;
      },
    }),
  } as unknown as PgDb;
  return {
    db,
    inserts,
    get deletes() {
      return state.deletes;
    },
  };
}

const meta: StoredRecordingMeta = {
  agentId: "agent-1",
  sessionId: "sess-1",
  user: "alice@x",
  storageKey: "ssh-recordings/agent-1/sess-1.cast",
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_005_000,
  durationMs: 5000,
  sizeBytes: 2048,
  reason: "client closed",
};

describe("ssh-recording-store", () => {
  test("insertRecordingRow maps metadata to a row (timestamps as Dates)", async () => {
    const { db, inserts } = fakeDb();
    await insertRecordingRow(db, meta);
    expect(inserts).toHaveLength(1);
    const row = inserts[0] as Record<string, unknown>;
    expect(row.agentId).toBe("agent-1");
    expect(row.actorUser).toBe("alice@x");
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.sizeBytes).toBe(2048);
  });

  test("insertRecordingRow enqueues SpiceDB recording relationships when authz is provided", async () => {
    const { db } = fakeDb();
    const enqueued: unknown[][] = [];
    await insertRecordingRow(db, meta, {
      authz: {
        enqueueMany: async (tuples: unknown[]) => {
          enqueued.push(tuples);
        },
      } as never,
      resolveActorUserId: async () => "user-1",
    });
    expect(enqueued).toEqual([
      [
        {
          operation: "create",
          resource: { type: "ssh_recording", id: "sess-1" },
          relation: "agent",
          subject: { type: "agent", id: "agent-1" },
        },
        {
          operation: "create",
          resource: { type: "ssh_recording", id: "sess-1" },
          relation: "platform",
          subject: { type: "platform", id: "root" },
        },
        {
          operation: "create",
          resource: { type: "ssh_recording", id: "sess-1" },
          relation: "actor",
          subject: { type: "user", id: "user-1" },
        },
      ],
    ]);
  });

  test("insertRecordingRow prefers canonical actorUserId over display user", async () => {
    const { db, inserts } = fakeDb();
    const enqueued: unknown[][] = [];
    await insertRecordingRow(
      db,
      { ...meta, actorUserId: "user-canonical-1" },
      {
        authz: {
          enqueueMany: async (tuples: unknown[]) => {
            enqueued.push(tuples);
          },
        } as never,
        resolveActorUserId: async () => {
          throw new Error("resolver should not be called when actorUserId is present");
        },
      },
    );
    expect((inserts[0] as Record<string, unknown>).actorUser).toBe("user-canonical-1");
    expect(enqueued[0]?.[2]).toEqual({
      operation: "create",
      resource: { type: "ssh_recording", id: "sess-1" },
      relation: "actor",
      subject: { type: "user", id: "user-canonical-1" },
    });
  });

  test("listRecordings maps rows to the secret-free view", async () => {
    const { db } = fakeDb([
      {
        agentId: "agent-1",
        sessionId: "sess-1",
        actorUser: "alice@x",
        storageKey: "k",
        startedAt: new Date("2026-06-04T00:00:00Z"),
        endedAt: new Date("2026-06-04T00:05:00Z"),
        durationMs: 300000,
        sizeBytes: 4096,
      },
    ]);
    const rows = await listRecordings(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      agentId: "agent-1",
      sessionId: "sess-1",
      user: "alice@x",
      startedAt: "2026-06-04T00:00:00.000Z",
      endedAt: "2026-06-04T00:05:00.000Z",
      durationMs: 300000,
      sizeBytes: 4096,
    });
  });

  test("listRecordingsBySessionIds maps SQL-filtered rows and preserves newest-first query", async () => {
    const { db } = fakeDb([
      {
        agentId: "agent-1",
        sessionId: "sess-1",
        actorUser: "user-1",
        storageKey: "k",
        startedAt: new Date("2026-07-13T00:00:00Z"),
        endedAt: new Date("2026-07-13T00:05:00Z"),
        durationMs: 300000,
        sizeBytes: 4096,
      },
    ]);

    const rows = await listRecordingsBySessionIds(db, ["sess-1"]);

    expect(rows.map((row) => row.sessionId)).toEqual(["sess-1"]);
  });

  test("listRecordingsBySessionIds skips SQL for an empty authorization set", async () => {
    let selects = 0;
    const db = {
      select: () => {
        selects += 1;
        throw new Error("select should not run");
      },
    } as unknown as PgDb;

    expect(await listRecordingsBySessionIds(db, [])).toEqual([]);
    expect(selects).toBe(0);
  });

  test("sweepOldRecordings deletes blob + index row for each old recording", async () => {
    const f = fakeDb([
      { agentId: "a1", sessionId: "s1", storageKey: "ssh-recordings/a1/s1.cast" },
      { agentId: "a2", sessionId: "s2", storageKey: "ssh-recordings/a2/s2.cast" },
    ]);
    const deletedKeys: string[] = [];
    const store = {
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    };
    const pruned = await sweepOldRecordings(f.db, store, new Date("2026-06-04T00:00:00Z"));
    expect(pruned).toBe(2);
    expect(deletedKeys).toEqual(["ssh-recordings/a1/s1.cast", "ssh-recordings/a2/s2.cast"]);
    expect(f.deletes).toBe(2); // live getter: one index-row delete per recording
  });

  test("sweepOldRecordings deletes SpiceDB recording relationships when authz is provided", async () => {
    const f = fakeDb([
      {
        agentId: "agent-1",
        sessionId: "sess-1",
        actorUser: "recording-user@example.test",
        storageKey: "ssh-recordings/agent-1/sess-1.cast",
      },
    ]);
    const enqueued: unknown[][] = [];
    const store = {
      delete: async () => {},
    };

    const pruned = await sweepOldRecordings(f.db, store, new Date("2026-06-04T00:00:00Z"), {
      authz: {
        enqueueMany: async (tuples: unknown[]) => {
          enqueued.push(tuples);
        },
      } as never,
      resolveActorUserId: async () => "user-1",
    });

    expect(pruned).toBe(1);
    expect(enqueued).toEqual([
      [
        {
          operation: "delete",
          resource: { type: "ssh_recording", id: "sess-1" },
          relation: "agent",
          subject: { type: "agent", id: "agent-1" },
        },
        {
          operation: "delete",
          resource: { type: "ssh_recording", id: "sess-1" },
          relation: "platform",
          subject: { type: "platform", id: "root" },
        },
        {
          operation: "delete",
          resource: { type: "ssh_recording", id: "sess-1" },
          relation: "actor",
          subject: { type: "user", id: "user-1" },
        },
      ],
    ]);
  });
});
