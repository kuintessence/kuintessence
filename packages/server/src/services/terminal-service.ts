import {
  AppError,
  ErrorCode,
  type TerminalAuditFrame,
  type TerminalSession,
  type TerminalSessionCreate,
} from "@kuintessence/shared";

const AUDIT_CAP = 200;

interface InternalSession extends TerminalSession {
  audit: TerminalAuditFrame[];
}

export class TerminalService {
  private readonly sessions = new Map<string, InternalSession>();

  list(userId: string): TerminalSession[] {
    return [...this.sessions.values()].filter((s) => s.userId === userId).map(stripAudit);
  }

  get(userId: string, id: string): TerminalSession {
    const s = this.requireOwned(userId, id);
    return stripAudit(s);
  }

  audit(userId: string, id: string): TerminalAuditFrame[] {
    return this.requireOwned(userId, id).audit;
  }

  create(userId: string, data: TerminalSessionCreate): TerminalSession {
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
    this.sessions.set(id, session);
    return stripAudit(session);
  }

  resize(userId: string, id: string, cols: number, rows: number): TerminalSession {
    const s = this.requireOwned(userId, id);
    s.cols = cols;
    s.rows = rows;
    pushFrame(s, {
      ts: new Date().toISOString(),
      kind: "resize",
      data: JSON.stringify({ cols, rows }),
    });
    return stripAudit(s);
  }

  recordExec(
    userId: string,
    id: string,
    input: string,
    realOutput: string,
  ): { output: string; session: TerminalSession } {
    const s = this.requireOwned(userId, id);
    if (s.state !== "open") {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `Session is ${s.state}; cannot exec`, 409);
    }
    const prompt = `[agent:${s.agentId}]$ `;
    const normalizedOutput = realOutput.replace(/\r?\n$/, "");
    const composed = normalizedOutput.length > 0 ? `${normalizedOutput}\n${prompt}` : prompt;
    s.bytesIn += Buffer.byteLength(input, "utf8");
    s.bytesOut += Buffer.byteLength(composed, "utf8");
    const now = new Date().toISOString();
    pushFrame(s, { ts: now, kind: "stdin", data: input });
    pushFrame(s, { ts: now, kind: "stdout", data: composed });
    return { output: composed, session: stripAudit(s) };
  }

  close(userId: string, id: string): TerminalSession {
    const s = this.requireOwned(userId, id);
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
  }

  private requireOwned(userId: string, id: string): InternalSession {
    const s = this.sessions.get(id);
    if (!s || s.userId !== userId) {
      throw new AppError(ErrorCode.NOT_FOUND, "Session not found", 404);
    }
    return s;
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
