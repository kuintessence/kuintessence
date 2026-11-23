import { type PgDb, sshLiveSessions as sessions } from "@kuintessence/db";
import { AppError, createLogger, ErrorCode } from "@kuintessence/shared";
import { and, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { SshGateway, SshSessionSummary } from "./ssh-gateway";

const expiresAt = sql`clock_timestamp() + interval '30 seconds'`;
const live = and(eq(sessions.closed, false), gt(sessions.expiresAt, sql`clock_timestamp()`));
const logger = createLogger("ssh-session-directory");

export class SshSessionDirectory {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private lastSync = performance.now();

  constructor(
    private readonly db: PgDb,
    private readonly serverId: string,
    private readonly gateway: Pick<SshGateway, "listSessions" | "closeSession">,
  ) {}

  start() {
    this.timer = setInterval(() => {
      void this.sync().catch((err) => logger.error({ err }, "Could not synchronize SSH sessions"));
    }, 1000);
    this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    await this.inFlight;
  }

  sync() {
    if (performance.now() - this.lastSync >= 30_000)
      for (const session of this.gateway.listSessions())
        this.gateway.closeSession(session.sessionId, "Session directory lease expired");
    this.inFlight ??= this.reconcile().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async reconcile() {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.serverId, this.serverId), eq(sessions.closed, false)))
        .for("update");
      for (const row of rows)
        if (row.closeReason) this.gateway.closeSession(row.sessionId, row.closeReason);
      const current = this.gateway.listSessions();
      const ids = new Set(current.map((s) => s.sessionId));
      const gone = rows.filter((r) => !ids.has(r.sessionId));
      const natural = gone.filter((r) => !r.closeReason).map((r) => r.sessionId);
      const requested = gone.filter((r) => r.closeReason).map((r) => r.sessionId);
      if (natural.length) await tx.delete(sessions).where(inArray(sessions.sessionId, natural));
      if (requested.length)
        await tx
          .update(sessions)
          .set({ closed: true, expiresAt })
          .where(inArray(sessions.sessionId, requested));
      if (current.length)
        await tx
          .insert(sessions)
          .values(
            current.map((s) => ({
              sessionId: s.sessionId,
              serverId: this.serverId,
              agentId: s.agentId,
              user: s.user,
              sourceIp: s.sourceIp,
              openedAt: new Date(s.openedAtMs),
              expiresAt,
            })),
          )
          .onConflictDoUpdate({ target: sessions.sessionId, set: { expiresAt } });
      await tx.delete(sessions).where(lt(sessions.expiresAt, sql`clock_timestamp()`));
    });
    this.lastSync = performance.now();
  }

  async listSessions(): Promise<SshSessionSummary[]> {
    const rows = await this.db.select().from(sessions).where(live);
    return rows.map((row) => ({
      sessionId: row.sessionId,
      agentId: row.agentId,
      user: row.user,
      sourceIp: row.sourceIp ?? undefined,
      openedAtMs: row.openedAt.getTime(),
      durationMs: Math.max(0, Date.now() - row.openedAt.getTime()),
    }));
  }

  async closeSession(id: string, reason: string) {
    const [request] = await this.db
      .update(sessions)
      .set({ closeReason: sql`coalesce(${sessions.closeReason}, ${reason})` })
      .where(and(eq(sessions.sessionId, id), live))
      .returning({ owner: sessions.serverId });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND, "No such active session", 404);
    if (request.owner === this.serverId) await this.sync();
    const deadline = performance.now() + 5000;
    do {
      const [row] = await this.db
        .select({ closed: sessions.closed })
        .from(sessions)
        .where(and(eq(sessions.sessionId, id), isNotNull(sessions.closeReason)));
      if (row?.closed) return;
      if (!row) break;
      await Bun.sleep(100);
    } while (performance.now() < deadline);
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      "SSH session owner has not confirmed closure",
      503,
    );
  }
}
