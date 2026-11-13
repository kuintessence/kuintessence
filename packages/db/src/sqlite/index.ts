import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { runSqliteMigrations } from "./migrate";
import * as schema from "./schema";

export function createSqliteDb(path: string) {
  const sqlite = new Database(path, { create: true });
  // The independently supervised watchdog writes this file too; wait for its short transactions.
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA synchronous = FULL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  runSqliteMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

export type SqliteDb = ReturnType<typeof createSqliteDb>;
export { runSqliteMigrations };
