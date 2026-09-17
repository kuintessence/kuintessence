/**
 * alias persistence helper.
 *
 * Wraps the `desensitize_alias_map` insert with idempotent upsert semantics:
 * the same `(salt, originalValue)` always produces the same `aliasId`, so a
 * conflict on the primary key just bumps `last_seen_at`. This means hot
 * fields (e.g. the same actor email returned on every page) don't blow up
 * the table.
 *
 * Errors are surfaced to the caller so the apply middleware can decide
 * whether to swallow them (it does — recording is best-effort).
 */
import { desensitizeAliasMap, type PgDb } from "@kuintessence/db";
import { sql } from "drizzle-orm";

export function makeAliasRecorder(db: PgDb) {
  return async (aliasId: string, salt: string, originalValue: string): Promise<void> => {
    await db
      .insert(desensitizeAliasMap)
      .values({ aliasId, salt, originalValue })
      .onConflictDoUpdate({
        target: desensitizeAliasMap.aliasId,
        set: { lastSeenAt: sql`now()` },
      });
  };
}
