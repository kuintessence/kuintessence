import { expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { PgTransferSessionStore, type TransferSession } from "./transfer-session-store";

const session: TransferSession = {
  storageKey: "netdrive/owner/object",
  uploadId: "upload",
  partSize: 5242880,
  agentId: "agent",
  source: "/output",
  target: "output",
  size: 4,
};
const completion = {
  copiedBytes: 4,
  sha256: "a".repeat(64),
  parts: [{ partNumber: 1, etag: "part" }],
};

function fixture() {
  let row: { session: TransferSession | null; state: string } | undefined = {
    session: null,
    state: "running",
  };
  let queue = Promise.resolve();
  let locked = false;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async (mode: string) => {
              expect(mode).toBe("update");
              locked = true;
              return row ? [structuredClone(row)] : [];
            },
          }),
        }),
      }),
    }),
    update: () => ({
      set: (value: { resumeSession: TransferSession | null }) => ({
        where: async () => {
          expect(locked).toBe(true);
          if (row) row.session = structuredClone(value.resumeSession);
        },
      }),
    }),
  };
  const db = {
    transaction: <T>(callback: (transaction: typeof tx) => Promise<T>) => {
      const result = queue.then(async () => {
        locked = false;
        return callback(tx);
      });
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  } as unknown as PgDb;
  return {
    store: new PgTransferSessionStore(db),
    row: () => row,
    cancel: () => {
      if (row) row.state = "cancelled";
    },
    remove: () => {
      row = undefined;
    },
  };
}

test("a stale concurrent session save cannot erase a durable completion", async () => {
  const f = fixture();
  await f.store.save("owner", "transfer", session);
  const results = await Promise.all([
    f.store.save("owner", "transfer", { ...session, completion }),
    f.store.save("owner", "transfer", session),
  ]);
  expect(results[1]?.completion).toEqual(completion);
  expect(f.row()?.session?.completion).toEqual(completion);
  await f.store.save("owner", "transfer", { ...session, completion });
  expect(f.row()?.session?.completion).toEqual(completion);
});

test("session binding and completed content are immutable across writers", async () => {
  const f = fixture();
  await f.store.save("owner", "transfer", { ...session, completion });
  for (const change of [
    { uploadId: "other" },
    { storageKey: "other" },
    { agentId: "other" },
    { source: "/other" },
    { target: "other" },
    { size: 5 },
  ]) {
    await expect(f.store.save("owner", "transfer", { ...session, ...change })).rejects.toThrow(
      "binding changed",
    );
  }
  await expect(
    f.store.save("owner", "transfer", {
      ...session,
      completion: { ...completion, sha256: "b".repeat(64) },
    }),
  ).rejects.toThrow("completion content changed");
  expect(f.row()?.session?.completion).toEqual(completion);
});

test("explicit cleanup clears a session; a cancelled row and missing owner binding reject later writes", async () => {
  const f = fixture();
  await f.store.save("owner", "transfer", { ...session, completion });
  await f.store.save("owner", "transfer", null);
  expect(f.row()?.session).toBeNull();
  f.cancel();
  await expect(f.store.save("owner", "transfer", session)).rejects.toThrow("cancelled");
  f.remove();
  await expect(f.store.save("other-owner", "transfer", session)).rejects.toThrow(
    "owner binding unavailable",
  );
});
