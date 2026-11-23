import { type PgDb, agentControlSessions as sessions } from "@kuintessence/db";
import { and, eq, gt, sql } from "drizzle-orm";

export class AgentSessions {
  readonly serverId = crypto.randomUUID();
  constructor(
    private readonly db: PgDb,
    private readonly ttlSeconds: number,
    private readonly relayOrigin: string | null = null,
  ) {}
  async claim(
    agentId: string,
    sessionId: string,
    capabilities: { schedulerLimits: boolean; pinnedSpack: boolean },
  ) {
    const row = {
      agentId,
      sessionId,
      serverId: this.serverId,
      relayOrigin: this.relayOrigin,
      ...capabilities,
      expiresAt: sql`clock_timestamp() + ${this.ttlSeconds} * interval '1 second'`,
    };
    await this.db
      .insert(sessions)
      .values(row)
      .onConflictDoUpdate({ target: sessions.agentId, set: row });
  }
  async release(agentId: string, sessionId: string) {
    await this.db
      .delete(sessions)
      .where(
        and(
          eq(sessions.agentId, agentId),
          eq(sessions.sessionId, sessionId),
          eq(sessions.serverId, this.serverId),
        ),
      );
  }
  async live() {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(gt(sessions.expiresAt, sql`clock_timestamp()`));
    return new Map(rows.map((row) => [row.agentId, row]));
  }
  // The separate control pool keeps a row lock until this message's handling completes.
  // A new registration cannot displace an in-flight operation. Disconnected owners expire.
  async enter(agentId: string, sessionId: string, heartbeat = false) {
    const conn = await this.db.$client.reserve();
    try {
      await conn`begin`;
      const rows = heartbeat
        ? await conn`update agent_control_sessions
        set expires_at=clock_timestamp() + ${this.ttlSeconds} * interval '1 second'
        where agent_id=${agentId} and session_id=${sessionId} and server_id=${this.serverId}
        and expires_at>clock_timestamp() returning session_id`
        : await conn`select session_id from agent_control_sessions where agent_id=${agentId}
        and session_id=${sessionId} and server_id=${this.serverId} and expires_at>clock_timestamp() for share`;
      if (rows.length)
        return async () => {
          try {
            await conn`commit`;
          } finally {
            conn.release();
          }
        };
      await conn`rollback`;
      conn.release();
      return undefined;
    } catch (error) {
      try {
        await conn`rollback`;
      } finally {
        conn.release();
      }
      throw error;
    }
  }
}
