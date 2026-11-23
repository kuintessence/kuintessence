import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, notificationDeliveries, notifications, users } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { enqueueNotification, NotificationService } from "./notifications";

describe("notification channels", () => {
  const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");
  const id = crypto.randomUUID();
  const inboxEvent = {
    userId: id,
    orgId: null,
    eventKey: "workflow:one:path",
    kind: "workflow.milestone",
    message: "Stage complete",
  };
  beforeAll(async () => {
    await db.insert(users).values({ id, email: `${id}@test.invalid` });
  });
  afterAll(async () => {
    await db.delete(users).where(eq(users.id, id));
  });

  test("durably enqueues once, isolates recipients and retries each selected channel independently", async () => {
    const emails: string[] = [];
    const deliveries: string[] = [];
    const service = new NotificationService(
      db,
      {
        send: async (config, event) => {
          expect(config.url).toBe("https://receiver.test/kq");
          deliveries.push((event.payload as { id: string }).id);
          return { ok: deliveries.length > 1, attempts: 1 };
        },
      },
      async (recipient, notice) => {
        expect(recipient).toBe(`${id}@test.invalid`);
        emails.push(notice.id);
      },
    );
    await service.configure(id, {
      emailEnabled: true,
      webhookUrl: "https://receiver.test/kq",
      webhookSecret: "test-signing-secret",
    });
    await expect(
      db.transaction((tx) =>
        enqueueNotification(tx, inboxEvent, { requiredWebhook: "https://other.test" }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await Promise.all(
      [1, 2].map(() => db.transaction((tx) => enqueueNotification(tx, inboxEvent))),
    );
    const inbox = await service.inbox(id, 0);
    expect(inbox).toHaveLength(1);
    const notice = inbox[0];
    if (!notice) throw new Error("Missing inbox notification");
    await expect(service.read(crypto.randomUUID(), notice.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await service.read(id, notice.id);
    expect((await service.inbox(id, 0))[0]?.readAt).toBeInstanceOf(Date);
    const now = new Date(Date.now() + 1000);
    await Promise.all([service.deliverDue(now), service.deliverDue(now)]);
    expect(emails).toEqual([notice.id]);
    expect(deliveries).toEqual([notice.id]);
    await service.deliverDue(new Date(now.getTime() + 60_000));
    expect(deliveries).toEqual([notice.id, notice.id]);
    expect(emails).toHaveLength(1);
    const rows = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, notice.id));
    expect(rows.every((row) => row.deliveredAt && row.nextAttemptAt === null)).toBe(true);
    await db.transaction((tx) =>
      enqueueNotification(tx, { ...inboxEvent, eventKey: "restricted" }, { inboxOnly: true }),
    );
    await service.deliverDue(new Date(now.getTime() + 120_000));
    expect(await db.select().from(notifications).where(eq(notifications.userId, id))).toHaveLength(
      2,
    );
    expect(deliveries).toHaveLength(2);
  });
  test("a disabled channel and a replaced webhook do not receive old retries", async () => {
    const sent: string[] = [];
    let mailAttempts = 0;
    const service = new NotificationService(
      db,
      {
        send: async (config) => {
          sent.push(config.url);
          return { ok: false, attempts: 1 };
        },
      },
      async () => {
        mailAttempts++;
        throw new Error("unavailable");
      },
    );
    const old = "https://original.example/notice",
      replacement = "https://replacement.example/notice";
    await service.configure(id, {
      emailEnabled: true,
      webhookUrl: old,
      webhookSecret: "test-original-secret",
    });
    await db.transaction((tx) =>
      enqueueNotification(tx, { ...inboxEvent, eventKey: "retry-before-switch" }),
    );
    const now = Date.now() + 1000;
    await service.deliverDue(new Date(now));
    expect(sent).toEqual([old]);
    await service.configure(id, {
      emailEnabled: false,
      webhookUrl: replacement,
      webhookSecret: "test-replacement-secret",
    });
    await service.deliverDue(new Date(now + 60_000));
    expect(sent).toEqual([old]);
    expect(mailAttempts).toBe(1);
    await db.transaction((tx) =>
      enqueueNotification(tx, { ...inboxEvent, eventKey: "after-switch" }),
    );
    await service.deliverDue(new Date(now + 65_000));
    expect(sent).toEqual([old, replacement]);
    expect(mailAttempts).toBe(1);
  });
});
