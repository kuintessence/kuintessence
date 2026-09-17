import { Database } from "bun:sqlite";
import { runSqliteMigrations } from "../migrate";

const db = new Database(":memory:");
runSqliteMigrations(db);
const table = db
  .query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queued_operations'",
  )
  .get();

if (table?.name !== "queued_operations") {
  throw new Error("compiled SQLite migration did not create queued_operations");
}

console.log("compiled-sqlite-ok");
