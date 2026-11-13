import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { createPgDb } from "./index";
import { workflowRuns } from "./schema";

test("database defaults and application timestamps share UTC even on a non-UTC connection", async () => {
  const value = process.env.DATABASE_URL;
  if (!value || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(value).pathname))
    throw new Error("Timezone test requires an isolated kuintessence_unit_* database");
  const url = new URL(value);
  url.searchParams.set("options", "-c TimeZone=Asia/Shanghai");
  const raw = postgres(url.toString(), { max: 1 });
  const db = createPgDb(url.toString());
  const id = randomUUID();
  try {
    const [original] = await raw`SHOW TimeZone`;
    expect(original?.TimeZone).toBe("Asia/Shanghai");
    const [session] = await db.execute(sql`SELECT current_setting('TimeZone') AS timezone`);
    expect(session?.timezone).toBe("UTC");
    const before = Date.now();
    const [created] = await db
      .insert(workflowRuns)
      .values({ id, name: "Timezone fixture" })
      .returning();
    expect(created?.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(created?.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    const [finished] = await db
      .update(workflowRuns)
      .set({ completedAt: new Date() })
      .where(eq(workflowRuns.id, id))
      .returning();
    expect(finished?.completedAt?.getTime()).toBeGreaterThanOrEqual(
      created?.createdAt.getTime() ?? Infinity,
    );
  } finally {
    await db.delete(workflowRuns).where(eq(workflowRuns.id, id));
    await db.$client.end();
    await raw.end();
  }
});
