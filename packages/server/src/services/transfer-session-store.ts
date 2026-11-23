import { fileTransfers, type PgDb } from "@kuintessence/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

const schema = z
  .object({
    storageKey: z.string().min(1),
    uploadId: z.string().min(1),
    partSize: z.number().int().positive(),
    agentId: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    size: z.number().nonnegative(),
    completion: z
      .object({
        copiedBytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i),
        parts: z
          .array(
            z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1) }),
          )
          .min(1)
          .max(10000),
      })
      .optional(),
  })
  .strict();
export type TransferSession = z.infer<typeof schema>;
export interface TransferSessionStore {
  verifyRunningOwner?(ownerId: string, id: string, db: Pick<PgDb, "select">): Promise<void>;
  load(ownerId: string, id: string): Promise<TransferSession | undefined>;
  save(
    ownerId: string,
    id: string,
    session: TransferSession | null,
  ): Promise<TransferSession | null>;
}
export class PgTransferSessionStore implements TransferSessionStore {
  constructor(
    private readonly db: PgDb,
    private readonly serverId?: string,
  ) {}
  async releasedCheckpointKeys(agentId: string, keys: string[]): Promise<string[]> {
    if (keys.length === 0 || keys.length > 64 || keys.some((key) => !/^[a-f0-9]{64}$/.test(key)))
      return [];
    const key = sql<string>`encode(sha256(${fileTransfers.id}::text::bytea), 'hex')`;
    const rows = await this.db
      .select({ key })
      .from(fileTransfers)
      .where(
        and(
          sql`direction = 'cluster_to_cloud' and state in ('succeeded', 'cancelled')`,
          sql`coalesce(${fileTransfers.resumeSession}->>'agentId', ${fileTransfers.agentId}) = ${agentId} and (${fileTransfers.agentId} is null or ${fileTransfers.agentId} = ${agentId})`,
          inArray(key, keys),
        ),
      );
    return rows.map((row) => row.key);
  }
  async load(ownerId: string, id: string) {
    const [row] = await this.db
      .select({ session: fileTransfers.resumeSession })
      .from(fileTransfers)
      .where(and(eq(fileTransfers.userId, ownerId), eq(fileTransfers.id, id)))
      .limit(1);
    return row?.session ? schema.parse(row.session) : undefined;
  }
  private binding(ownerId: string, id: string) {
    return and(
      eq(fileTransfers.userId, ownerId),
      eq(fileTransfers.id, id),
      this.serverId
        ? sql`${fileTransfers.dispatchOwner} = ${this.serverId}::uuid and ${fileTransfers.dispatchExpiresAt} > clock_timestamp()`
        : undefined,
    );
  }

  async verifyRunningOwner(ownerId: string, id: string, db: Pick<PgDb, "select">) {
    if (!this.serverId) return;
    const [row] = await db
      .select({ id: fileTransfers.id })
      .from(fileTransfers)
      .where(and(this.binding(ownerId, id), eq(fileTransfers.state, "running")))
      .for("share");
    if (!row) throw new Error("Transfer dispatch lease expired");
  }

  async save(ownerId: string, id: string, session: TransferSession | null) {
    const incoming = session ? schema.parse(session) : null;
    return this.db.transaction(async (tx) => {
      const binding = this.binding(ownerId, id);
      const [row] = await tx
        .select({ session: fileTransfers.resumeSession, state: fileTransfers.state })
        .from(fileTransfers)
        .where(binding)
        .limit(1)
        .for("update");
      if (!row) throw new Error("Transfer session owner binding unavailable");
      if (incoming && row.state === "cancelled") throw new Error("Transfer was cancelled");
      if (this.serverId && incoming && row.state !== "running")
        throw new Error("Transfer is no longer running");
      const previous = row.session ? schema.parse(row.session) : undefined;
      let next = incoming;
      if (previous && incoming) {
        const { completion: oldCompletion, ...oldBinding } = previous;
        const { completion: newCompletion, ...newBinding } = incoming;
        if (JSON.stringify(oldBinding) !== JSON.stringify(newBinding))
          throw new Error("Persisted transfer binding changed");
        if (
          oldCompletion &&
          newCompletion &&
          JSON.stringify(oldCompletion) !== JSON.stringify(newCompletion)
        )
          throw new Error("Persisted completion content changed");
        // A stale dispatcher must never erase the completion saved by another Server process.
        next = { ...incoming, ...(oldCompletion ? { completion: oldCompletion } : {}) };
      }
      const [saved] = await tx
        .update(fileTransfers)
        .set({
          resumeSession: next,
          agentId: sql`coalesce(${fileTransfers.agentId}, ${next?.agentId ?? previous?.agentId ?? null})`,
          updatedAt: new Date(),
        })
        .where(binding)
        .returning({ id: fileTransfers.id });
      if (!saved) throw new Error("Transfer dispatch lease expired");
      return next;
    });
  }
}
