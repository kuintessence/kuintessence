import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { runSqliteMigrations } from "./migrate";
import * as schema from "./schema";

export function createSqliteDb(path: string) {
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  runSqliteMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

export type SqliteDb = ReturnType<typeof createSqliteDb>;
export { runSqliteMigrations };
