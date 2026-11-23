import {
  notificationDeliveries,
  notificationPreferences,
  notifications,
  type PgDb,
  type PgTransaction,
  users,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { WebhookDispatcher } from "./metering-webhook";

type Notice = typeof notifications.$inferSelect;
type Preferences = typeof notificationPreferences.$inferSelect;
type Event = Pick<Notice, "userId" | "orgId" | "eventKey" | "kind" | "message">;

export async function enqueueNotification(
  tx: PgTransaction,
  event: Event,
  options: { inboxOnly?: boolean; requiredWebhook?: string } = {},
) {
  const [notice] = await tx
    .insert(notifications)
    .values(event)
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!notice || options.inboxOnly) return;
  const [preferences] = await tx
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, event.userId))
    .for("share");
  if (options.requiredWebhook && options.requiredWebhook !== preferences?.webhookUrl)
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Milestone URL must match your configured notification webhook",
      400,
    );
  const channels: Array<"email" | "webhook"> = [];
  if (preferences?.emailEnabled) channels.push("email");
  if (preferences?.webhookUrl) channels.push("webhook");
  if (channels.length)
    await tx
      .insert(notificationDeliveries)
      .values(channels.map((channel) => ({ notificationId: notice.id, channel })));
}

export class NotificationService {
  constructor(
    private readonly db: PgDb,
    private readonly webhook: Pick<WebhookDispatcher, "send">,
    private readonly email?: (recipient: string, notice: Notice) => Promise<void>,
  ) {}

  async inbox(userId: string, offset: number) {
    return this.db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        message: notifications.message,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(25)
      .offset(offset);
  }

  async read(userId: string, id: string) {
    const [item] = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    if (!item) throw new AppError(ErrorCode.NOT_FOUND, "Notification not found", 404);
  }

  async preferences(userId: string) {
    const [row] = await this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));
    return {
      emailAvailable: Boolean(this.email),
      emailEnabled: row?.emailEnabled ?? false,
      webhookUrl: row?.webhookUrl ?? null,
    };
  }

  async configure(
    userId: string,
    input: { emailEnabled: boolean; webhookUrl: string | null; webhookSecret?: string },
  ) {
    if (input.emailEnabled && !this.email)
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Email delivery is not configured", 409);
    await this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
      const [prior] = await tx
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId))
        .for("update");
      const secret = input.webhookUrl
        ? (input.webhookSecret ??
          (prior?.webhookUrl === input.webhookUrl ? prior.webhookSecret : null))
        : null;
      if (input.webhookUrl && !secret)
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "A signing secret is required for this webhook",
          400,
        );
      const values = {
        emailEnabled: input.emailEnabled,
        webhookUrl: input.webhookUrl,
        webhookSecret: secret,
      };
      await tx
        .insert(notificationPreferences)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: notificationPreferences.userId, set: values });
      // Never redirect pending messages to a replacement endpoint.
      const changed: Array<"email" | "webhook"> = [];
      if (!input.emailEnabled) changed.push("email");
      if (prior?.webhookUrl !== input.webhookUrl || !input.webhookUrl) changed.push("webhook");
      for (const channel of changed)
        await tx.execute(sql`update ${notificationDeliveries} d set next_attempt_at = null from ${notifications} n
        where d.notification_id = n.id and n.user_id = ${userId} and d.channel = ${channel} and d.next_attempt_at is not null`);
    });
  }

  async deliverDue(now = new Date()) {
    for (let i = 0; i < 25; i++) {
      const claimed = await this.db.transaction(async (tx) => {
        const [pending] = await tx
          .select()
          .from(notificationDeliveries)
          .where(lte(notificationDeliveries.nextAttemptAt, now))
          .orderBy(asc(notificationDeliveries.nextAttemptAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!pending) return null;
        const attempts = pending.attempts + 1;
        const key = and(
          eq(notificationDeliveries.notificationId, pending.notificationId),
          eq(notificationDeliveries.channel, pending.channel),
        );
        await tx
          .update(notificationDeliveries)
          .set({ attempts, nextAttemptAt: new Date(now.getTime() + 5 * 60_000) })
          .where(key);
        const [item] = await tx
          .select({
            notice: notifications,
            recipient: users.email,
            suspended: users.suspended,
            preferences: notificationPreferences,
          })
          .from(notifications)
          .innerJoin(users, eq(users.id, notifications.userId))
          .leftJoin(notificationPreferences, eq(notificationPreferences.userId, users.id))
          .where(eq(notifications.id, pending.notificationId));
        return { attempts, key, channel: pending.channel, item };
      });
      if (!claimed) break;
      const { attempts, key, channel, item } = claimed;
      let deliveredAt: Date | null = null;
      let nextAttemptAt: Date | null = null;
      if (attempts <= 12 && item && !item.suspended && item.preferences) {
        try {
          if (await this.send(channel, item.notice, item.recipient, item.preferences))
            deliveredAt = now;
        } catch {
          if (attempts < 12)
            nextAttemptAt = new Date(
              now.getTime() + Math.min(3_600_000, 30_000 * 2 ** (attempts - 1)),
            );
        }
      }
      // Fence a late worker after a lease expires or the recipient cancels pending deliveries.
      await this.db
        .update(notificationDeliveries)
        .set({ deliveredAt, nextAttemptAt })
        .where(
          and(
            key,
            eq(notificationDeliveries.attempts, attempts),
            isNotNull(notificationDeliveries.nextAttemptAt),
          ),
        );
    }
  }

  private async send(
    channel: "email" | "webhook",
    notice: Notice,
    recipient: string,
    prefs: Preferences,
  ) {
    if (channel === "email") {
      if (!prefs.emailEnabled) return false;
      if (!this.email) throw new Error("Mail transport unavailable");
      await this.email(recipient, notice);
      return true;
    }
    if (!prefs.webhookUrl || !prefs.webhookSecret) return false;
    const result = await this.webhook.send(
      {
        id: notice.id,
        orgId: notice.orgId ?? "",
        url: prefs.webhookUrl,
        secret: prefs.webhookSecret,
        enabled: true,
        events: [notice.kind],
        failures: 0,
      },
      {
        event: notice.kind,
        orgId: notice.orgId ?? "",
        occurredAt: notice.createdAt,
        payload: { id: notice.id, message: notice.message },
      },
    );
    if (!result.ok) throw new Error("Webhook delivery failed");
    return true;
  }
}
