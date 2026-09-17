import { type SqliteDb, sandboxReplayNonces } from "@kuintessence/db";
import { lt } from "drizzle-orm";

export interface SandboxReplayNonceStoreOptions {
  now?: () => Date;
}

export class SandboxReplayNonceStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqliteDb,
    options: SandboxReplayNonceStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async consume(nonce: string, jobId: string, expiresAt: Date): Promise<boolean> {
    const now = this.now();
    await this.db.delete(sandboxReplayNonces).where(lt(sandboxReplayNonces.expiresAt, now));
    const rows = await this.db
      .insert(sandboxReplayNonces)
      .values({ nonce, jobId, expiresAt, consumedAt: now })
      .onConflictDoNothing({ target: sandboxReplayNonces.nonce })
      .returning({ nonce: sandboxReplayNonces.nonce });
    return rows.length === 1;
  }
}
