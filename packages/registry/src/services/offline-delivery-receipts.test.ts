import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { auditLog, createPgDb } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { PgDeliveryReceipts } from "./offline-delivery-receipts";

const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");
const lockDb = createPgDb(
  process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence",
  { max: 2 },
);
const target = `delivery-test:${randomUUID()}`;
afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.target, target));
  await db.$client.end();
  await lockDb.$client.end();
});

test("PostgreSQL serializes separate seed writers and retains receipts when a later step fails", async () => {
  const a = new PgDeliveryReceipts(db, lockDb);
  const b = new PgDeliveryReceipts(db, lockDb);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = a
    .exclusive(async () => {
      await a.append(target, "fixture", { status: "completed", item: "recipe" });
      entered.resolve();
      await release.promise;
      throw new Error("later-stage-failed");
    })
    .catch((error: unknown) => error);
  await entered.promise;
  const second = b.exclusive(async () => {
    expect(await b.read(target)).toEqual({ status: "completed", item: "recipe" });
    await b.append(target, "fixture", { status: "completed", item: "material" });
  });
  release.resolve();
  await first;
  await second;
  const restarted = new PgDeliveryReceipts(db, lockDb);
  expect(await restarted.history(target)).toHaveLength(2);
  expect(await restarted.read(target)).toEqual({ status: "completed", item: "material" });
});
