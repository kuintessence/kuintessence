import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createPgDb, fileTransfers, users } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { UploadCheckpointGc } from "../../packages/agent/src/staging/upload-checkpoint-gc";
import { PgTransferSessionStore } from "../../packages/server/src/services/transfer-session-store";

const url = process.env.DATABASE_URL;
test.skipIf(!url || !new URL(url).pathname.startsWith("/kuintessence_unit_"))(
  "heartbeat reconciliation releases only offered, unchanged checkpoints for terminal uploads on this Agent",
  async () => {
    if (!url) throw new Error("Missing test database");
    const db = createPgDb(url);
    const userId = crypto.randomUUID();
    const dir = await mkdtemp(join(tmpdir(), "kq-checkpoint-"));
    const store = new PgTransferSessionStore(db);
    const gc = new UploadCheckpointGc(dir);
    async function seed(
      state: string,
      agentId: string | null = "agent",
      direction = "cluster_to_cloud",
      id = crypto.randomUUID(),
    ) {
      const key = createHash("sha256").update(id).digest("hex");
      await db
        .insert(fileTransfers)
        .values({ id, userId, state, agentId, direction, source: "src", target: "dst" });
      await writeFile(join(dir, `${key}.json`), "receipt", { mode: 0o600 });
      return key;
    }
    try {
      await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.invalid`, role: "user" });
      const done = await seed("succeeded");
      const cancelled = await seed("cancelled");
      const resolvedId = crypto.randomUUID();
      const resolved = await seed("running", null, "cluster_to_cloud", resolvedId);
      await store.save(userId, resolvedId, {
        agentId: "agent",
        source: "src",
        target: "dst",
        storageKey: "key",
        uploadId: "upload",
        partSize: 32,
        size: 64,
      });
      await db
        .update(fileTransfers)
        .set({ state: "cancelled" })
        .where(eq(fileTransfers.id, resolvedId));
      await store.save(userId, resolvedId, null);
      const unknown = await seed("cancelled", null);
      const changed = await seed("succeeded");
      const foreign = await seed("succeeded", "another-agent");
      const download = await seed("succeeded", "agent", "cloud_to_cluster");
      const live = await Promise.all(["queued", "running", "failed"].map((state) => seed(state)));
      const temporary = join(dir, `${done}.json.${crypto.randomUUID()}.tmp`);
      await writeFile(temporary, "temporary", { mode: 0o600 });
      const offered = await gc.inventory(1n);
      const released = await store.releasedCheckpointKeys("agent", offered);
      expect(released.sort()).toEqual([done, cancelled, resolved, changed].sort());
      await gc.release(2n, released);
      expect(await readFile(join(dir, `${done}.json`), "utf8")).toBe("receipt");
      await rename(join(dir, `${changed}.json`), join(dir, "original"));
      await writeFile(join(dir, `${changed}.json`), "new", { mode: 0o600 });
      await gc.release(1n, released);
      for (const name of [
        `${done}.json`,
        `${cancelled}.json`,
        `${resolved}.json`,
        basename(temporary),
      ])
        await expect(readFile(join(dir, name))).rejects.toMatchObject({ code: "ENOENT" });
      for (const key of [foreign, download, unknown, ...live])
        expect(await readFile(join(dir, `${key}.json`), "utf8")).toBe("receipt");
      expect(await readFile(join(dir, `${changed}.json`), "utf8")).toBe("new");
    } finally {
      await gc.close();
      await db.delete(users).where(eq(users.id, userId));
      await db.$client.end();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a lost acknowledgement is retried after scanning all checkpoint pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kq-checkpoint-pages-"));
  const gc = new UploadCheckpointGc(dir);
  try {
    const keys = Array.from({ length: 65 }, (_, i) =>
      createHash("sha256").update(String(i)).digest("hex"),
    );
    await Promise.all(
      keys.map((key) => writeFile(join(dir, `${key}.json`), "receipt", { mode: 0o600 })),
    );
    const first = await gc.inventory(1n, 0);
    const second = await gc.inventory(2n, 0);
    expect(first.length).toBe(64);
    expect(second.length).toBe(1);
    expect([...first, ...second].sort()).toEqual(keys.sort());
    await gc.release(1n, first);
    expect((await readdir(dir)).length).toBe(65);
    expect(await gc.inventory(3n, 0)).toEqual([]);
    expect(await gc.inventory(4n, 3_599_999)).toEqual([]);
    const retry = await gc.inventory(5n, 3_600_000);
    await gc.release(5n, retry);
    const last = await gc.inventory(6n, 3_600_000);
    expect([...retry, ...last].sort()).toEqual(keys);
    await gc.release(6n, last);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await gc.close();
    await rm(dir, { recursive: true, force: true });
  }
});
