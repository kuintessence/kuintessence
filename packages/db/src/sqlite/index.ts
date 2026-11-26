import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { runSqliteMigrations } from "./migrate";
import * as schema from "./schema";

export function createSqliteDb(path: string, journalMode: "wal" | "delete" = "wal") {
  if (journalMode !== "wal" && journalMode !== "delete") {
    throw new Error("Unsupported SQLite journal mode");
  }
  const sqlite = new Database(path, { create: true });
  try {
    // The independently supervised watchdog writes this file too; wait for its short transactions.
    sqlite.exec("PRAGMA busy_timeout = 5000;");
    // Shared HOME uses rollback journals; WAL's shared-memory index requires local storage.
    const actual = sqlite
      .query<{ journal_mode: string }, []>(`PRAGMA journal_mode = ${journalMode}`)
      .get();
    if (
      actual?.journal_mode !== journalMode &&
      !(path === ":memory:" && actual?.journal_mode === "memory")
    ) {
      throw new Error("SQLite could not select the required journal mode");
    }
    sqlite.exec(
      journalMode === "delete" ? "PRAGMA synchronous = EXTRA;" : "PRAGMA synchronous = FULL;",
    );
    sqlite.exec("PRAGMA foreign_keys = ON;");
    runSqliteMigrations(sqlite);
    return drizzle(sqlite, { schema });
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type SqliteDb = ReturnType<typeof createSqliteDb>;
export { runSqliteMigrations };
