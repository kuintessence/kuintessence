import { type PgDb, type PgTransaction, terminalSessions as table } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  type TerminalAuditFrame,
  TerminalAuditFrameSchema,
  type TerminalSession,
  type TerminalSessionCreate,
  TerminalSessionSchema,
} from "@kuintessence/shared";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../auth/secret-cipher";

const AUDIT_CAP = 200;

interface InternalSession extends TerminalSession {
  audit: TerminalAuditFrame[];
}

export class TerminalService {
  constructor(
    private readonly db: PgDb,
    private readonly secret: string,
    private readonly retentionDays: number,
  ) {}
  private expiry() {
    return sql`clock_timestamp() + ${this.retentionDays} * interval '1 day'`;
  }
  async cleanup() {
    await this.db.delete(table).where(lte(table.expiresAt, sql`clock_timestamp()`));
  }
  async list(userId: string): Promise<TerminalSession[]> {
    const rows = await this.db
      .select({ state: table.state })
      .from(table)
      .where(and(eq(table.userId, userId), gt(table.expiresAt, sql`clock_timestamp()`)));
    return rows.map((r) => TerminalSessionSchema.parse(r.state));
  }
  async get(userId: string, id: string) {
    return TerminalSessionSchema.parse((await this.read(this.db, userId, id)).state);
  }
  async audit(userId: string, id: string) {
    return this.frames(userId, id, (await this.read(this.db, userId, id)).audit);
  }
  private async frames(userId: string, id: string, encrypted: string) {
    return z
      .array(TerminalAuditFrameSchema)
      .parse(
        JSON.parse(await decryptSecret(encrypted, this.secret, `kq-terminal-v1/${userId}/${id}`)),
      );
  }
  private seal(s: InternalSession) {
    return encryptSecret(
      JSON.stringify(s.audit),
      this.secret,
      `kq-terminal-v1/${s.userId}/${s.id}`,
    );
  }
  async create(userId: string, data: TerminalSessionCreate): Promise<TerminalSession> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const session: InternalSession = {
      id,
      userId,
      siteId: data.siteId,
      agentId: data.agentId,
      remoteUser: data.remoteUser,
      authMethod: data.authMethod,
      state: "open",
      cols: 120,
      rows: 32,
      openedAt: now,
      closedAt: null,
      bytesIn: 0,
      bytesOut: 0,
      reason: null,
      audit: [
        {
          ts: now,
          kind: "stdout",
          data: `Command session opened through Agent ${data.agentId}`,
        },
      ],
    };
    await this.db.insert(table).values({
      id,
      userId,
      state: stripAudit(session),
      audit: await this.seal(session),
      expiresAt: this.expiry(),
    });
    return stripAudit(session);
  }

  resize(userId: string, id: string, cols: number, rows: number) {
    return this.change(userId, id, (s) => {
      s.cols = cols;
      s.rows = rows;
      pushFrame(s, {
        ts: new Date().toISOString(),
        kind: "resize",
        data: JSON.stringify({ cols, rows }),
      });
      return stripAudit(s);
    });
  }

  async admitExec(userId: string, id: string, input: string) {
    await this.change(userId, id, (s) => {
      if (s.state !== "open")
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Terminal session is closed", 409);
      s.bytesIn += Buffer.byteLength(input, "utf8");
      pushFrame(s, { ts: new Date().toISOString(), kind: "stdin", data: input });
    });
  }

  recordOutput(userId: string, id: string, realOutput: string) {
    return this.change(userId, id, (s) => {
      const prompt = `[agent:${s.agentId}]$ `;
      const normalizedOutput = realOutput.replace(/\r?\n$/, "");
      const composed = normalizedOutput.length > 0 ? `${normalizedOutput}\n${prompt}` : prompt;
      s.bytesOut += Buffer.byteLength(composed, "utf8");
      const now = new Date().toISOString();
      pushFrame(s, { ts: now, kind: "stdout", data: composed });
      return { output: composed, session: stripAudit(s) };
    });
  }

  close(userId: string, id: string) {
    return this.change(userId, id, (s) => {
      if (s.state === "closed") return stripAudit(s);
      s.state = "closed";
      s.closedAt = new Date().toISOString();
      s.reason = s.reason ?? "closed by user";
      pushFrame(s, {
        ts: s.closedAt,
        kind: "exit",
        data: "0",
      });
      return stripAudit(s);
    });
  }
  private async read(db: PgDb | PgTransaction, userId: string, id: string, lock = false) {
    if (!z.uuid().safeParse(id).success)
      throw new AppError(ErrorCode.NOT_FOUND, "Session not found", 404);
    const query = db
      .select()
      .from(table)
      .where(
        and(
          eq(table.id, id),
          eq(table.userId, userId),
          gt(table.expiresAt, sql`clock_timestamp()`),
        ),
      );
    const [row] = await (lock ? query.for("update") : query);
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, "Session not found", 404);
    return row;
  }
  private change<T>(userId: string, id: string, update: (s: InternalSession) => T) {
    return this.db.transaction(async (tx) => {
      const row = await this.read(tx, userId, id, true);
      const session = {
        ...TerminalSessionSchema.parse(row.state),
        audit: await this.frames(userId, id, row.audit),
      };
      const result = update(session);
      await tx
        .update(table)
        .set({
          state: stripAudit(session),
          audit: await this.seal(session),
          expiresAt: this.expiry(),
        })
        .where(eq(table.id, id));
      return result;
    });
  }
}

function pushFrame(s: InternalSession, frame: TerminalAuditFrame): void {
  s.audit.push(frame);
  if (s.audit.length > AUDIT_CAP) {
    s.audit.splice(0, s.audit.length - AUDIT_CAP);
  }
}

function stripAudit(s: InternalSession): TerminalSession {
  const { audit: _audit, ...rest } = s;
  return rest;
}
