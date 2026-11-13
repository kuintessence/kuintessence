import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "./index";

test("Agent SQLite waits for a short independent watchdog write without losing either update", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-sqlite-contention-"));
  const path = join(root, "agent.db");
  const db = createSqliteDb(path);
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
    expect(db.$client.query("SELECT writer FROM contention_probe ORDER BY writer").all()).toEqual([
      { writer: "agent" },
      { writer: "watchdog" },
    ]);
  } finally {
    child.kill();
    await child.exited;
    db.$client.close();
    await rm(root, { recursive: true, force: true });
  }
});
