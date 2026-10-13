import { auditLog, type PgDb } from "@kuintessence/db";
import { and, desc, eq, sql } from "drizzle-orm";

export interface DeliveryReceipts {
  exclusive<T>(run: () => Promise<T>): Promise<T>;
  read(target: string): Promise<unknown>;
  append(target: string, actor: string, value: unknown): Promise<void>;
  history(target: string): Promise<unknown[]>;
}

// Append-only audit records survive partial failure; the lock never implies batch rollback.
export class PgDeliveryReceipts implements DeliveryReceipts {
  constructor(
    private readonly db: PgDb,
    private readonly lockDb: PgDb,
  ) {}
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    return this.lockDb
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '30s'`);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('offline-delivery')) AS acquired`,
        );
        return run();
      })
      .catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "55P03")
          throw new Error("DELIVERY_BUSY");
        throw error;
      });
  }
  async read(target: string): Promise<unknown> {
    const [row] = await this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "offline-delivery"), eq(auditLog.target, target)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    return row?.diff?.after;
  }
  async append(target: string, actor: string, value: unknown) {
    await this.db
      .insert(auditLog)
      .values({ actor, action: "offline-delivery", target, diff: { after: value } });
  }
  async history(target: string): Promise<unknown[]> {
    return this.db
      .select({ actor: auditLog.actor, createdAt: auditLog.createdAt, diff: auditLog.diff })
      .from(auditLog)
      .where(and(eq(auditLog.action, "offline-delivery"), eq(auditLog.target, target)))
      .orderBy(desc(auditLog.createdAt))
      .limit(200);
  }
}
