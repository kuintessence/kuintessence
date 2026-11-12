import { fileTransfers, type PgDb } from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
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
  load(ownerId: string, id: string): Promise<TransferSession | undefined>;
  save(
    ownerId: string,
    id: string,
    session: TransferSession | null,
  ): Promise<TransferSession | null>;
}
export class PgTransferSessionStore implements TransferSessionStore {
  constructor(private readonly db: PgDb) {}
  async load(ownerId: string, id: string) {
    const [row] = await this.db
      .select({ session: fileTransfers.resumeSession })
      .from(fileTransfers)
      .where(and(eq(fileTransfers.userId, ownerId), eq(fileTransfers.id, id)))
      .limit(1);
    return row?.session ? schema.parse(row.session) : undefined;
  }
  async save(ownerId: string, id: string, session: TransferSession | null) {
    const incoming = session ? schema.parse(session) : null;
    return this.db.transaction(async (tx) => {
      const binding = and(eq(fileTransfers.userId, ownerId), eq(fileTransfers.id, id));
      const [row] = await tx
        .select({ session: fileTransfers.resumeSession, state: fileTransfers.state })
        .from(fileTransfers)
        .where(binding)
        .limit(1)
        .for("update");
      if (!row) throw new Error("Transfer session owner binding unavailable");
      if (incoming && row.state === "cancelled") throw new Error("Transfer was cancelled");
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
      await tx
        .update(fileTransfers)
        .set({ resumeSession: next, updatedAt: new Date() })
        .where(binding);
      return next;
    });
  }
}
