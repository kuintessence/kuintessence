import { expect, test } from "bun:test";
import { createPgDb } from "@kuintessence/db";
import { createPgEventBus } from "./pg-event-bus";

test("two PostgreSQL clients receive a job event once without echoing it", async () => {
  const url = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
  const a = createPgDb(url),
    b = createPgDb(url);
  const first = await createPgEventBus(a.$client),
    second = await createPgEventBus(b.$client);
  try {
    const id = crypto.randomUUID(),
      seen: string[] = [];
    first.bus.subscribeJob(id, (e) => seen.push(e.status));
    const received = new Promise<string>((resolve) =>
      second.bus.subscribeJob(id, (e) => resolve(e.status)),
    );
    first.bus.publishJobStatus({ jobId: id, status: "completed" });
    expect(await received).toBe("completed");
    expect(seen).toEqual(["completed"]);
  } finally {
    await first.close();
    await second.close();
    await Promise.all([a.$client.end(), b.$client.end()]);
  }
});
