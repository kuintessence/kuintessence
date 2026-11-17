import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "./index";

for (const mode of ["wal", "delete"] as const) {
  test(`Agent SQLite ${mode} waits for an independent writer without losing either update`, async () => {
    const root = await mkdtemp(join(tmpdir(), "kq-sqlite-contention-"));
    const path = join(root, "agent.db");
    const db = createSqliteDb(path, mode);
    expect(db.$client.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: mode });
    expect(db.$client.query("PRAGMA synchronous").get()).toEqual({
      synchronous: mode === "delete" ? 3 : 2,
    });
    db.$client.exec("CREATE TABLE contention_probe (writer TEXT PRIMARY KEY)");
    const child = Bun.spawn(
      [
        "python3",
        "-u",
        "-c",
        `
import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1])
db.execute("BEGIN IMMEDIATE")
db.execute("INSERT INTO contention_probe VALUES ('watchdog')")
print("locked", flush=True)
time.sleep(0.3)
db.commit()
db.close()
`,
        path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("locked");
      reader.releaseLock();
      db.$client.exec("INSERT INTO contention_probe VALUES ('agent')");
      expect(await child.exited).toBe(0);
      expect(db.$client.query("SELECT writer FROM contention_probe ORDER BY writer").all()).toEqual(
        [{ writer: "agent" }, { writer: "watchdog" }],
      );
    } finally {
      child.kill();
      await child.exited;
      db.$client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("rollback journal recovers an interrupted writer and preserves committed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-sqlite-recovery-"));
  const path = join(root, "agent.db");
  const db = createSqliteDb(path, "delete");
  db.$client.exec(
    "CREATE TABLE recovery_probe (value TEXT); INSERT INTO recovery_probe VALUES ('committed')",
  );
  db.$client.close();
  const child = Bun.spawn(
    [
      "python3",
      "-u",
      "-c",
      `
import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA cache_size=1")
db.execute("BEGIN IMMEDIATE")
db.execute("UPDATE recovery_probe SET value = ?", ('uncommitted' * 100000,))
print("uncommitted", flush=True)
time.sleep(30)
`,
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("uncommitted");
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
    const reopened = createSqliteDb(path, "delete");
    try {
      expect(reopened.$client.query("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
      expect(reopened.$client.query("SELECT value FROM recovery_probe").all()).toEqual([
        { value: "committed" },
      ]);
    } finally {
      reopened.$client.close();
    }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
