import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  type AgentMessage,
  AgentMessageSchema,
  type ServerMessage,
  SshClosedSchema,
  SshOutputSchema,
} from "@kuintessence/proto";
import pino from "pino";
import { AgentDispatcher } from "../grpc/dispatcher";
import { type SshAuditEvent, SshGateway, type WsConnectionLike } from "./ssh-gateway";
import type { SshSessionRecording } from "./ssh-recording";

const silent = pino({ level: "silent" });

function mockChannel() {
  const messages: ServerMessage[] = [];
  return {
    messages,
    push: (m: ServerMessage) => messages.push(m),
    close: () => {},
  };
}

function mockWs(): {
  ws: WsConnectionLike;
  sent: Array<string | ArrayBufferView | ArrayBufferLike>;
  closed: Array<{ code?: number; reason?: string }>;
} {
  const sent: Array<string | ArrayBufferView | ArrayBufferLike> = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    sent,
    closed,
    ws: {
      send: (d) => sent.push(d),
      close: (code, reason) => closed.push({ code, reason }),
    },
  };
}

describe("SshGateway", () => {
  test("openSession pushes SshOpen on the agent channel and returns minted sessionId", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "fixed-uuid",
    });
    const { ws } = mockWs();

    const sessionId = gw.openSession({
      agentId: "agent-1",
      ws,
      credentials: {
        host: "login01",
        port: 22,
        username: "alice",
        password: "secret",
      },
      user: "alice@example.com",
      sourceIp: "10.0.0.1",
    });

    expect(sessionId).toBe("fixed-uuid");
    expect(ch.messages).toHaveLength(1);
    const m = ch.messages[0];
    expect(m?.payload.case).toBe("sshOpen");
    if (m?.payload.case === "sshOpen") {
      expect(m.payload.value.sessionId).toBe("fixed-uuid");
      expect(m.payload.value.host).toBe("login01");
      expect(m.payload.value.username).toBe("alice");
      expect(m.payload.value.auth?.password).toBe("secret");
    }
    expect(gw.activeCount()).toBe(1);
    expect(gw.hasSession("fixed-uuid")).toBe(true);
  });

  test("openSession forwards the host-key pin in SshOpen", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({ dispatcher, logger: silent, newSessionId: () => "s1" });
    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: { host: "h", port: 22, username: "u", password: "p", hostKeySha256: "PINB64" },
      user: "a",
    });
    const m = ch.messages[0];
    expect(m?.payload.case).toBe("sshOpen");
    if (m?.payload.case === "sshOpen") {
      expect(m.payload.value.hostKeySha256).toBe("PINB64");
    }
  });

  test("openSession on an offline agent throws", () => {
    const dispatcher = new AgentDispatcher();
    const gw = new SshGateway({ dispatcher, logger: silent });
    const { ws } = mockWs();

    expect(() =>
      gw.openSession({
        agentId: "ghost",
        ws,
        credentials: { host: "h", port: 22, username: "u", password: "p" },
        user: "alice",
      }),
    ).toThrow(/not online/);
  });

  test("forwardResize encodes SshResize with cols/rows and pushes to agent", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({ dispatcher, logger: silent, newSessionId: () => "s1" });
    const { ws } = mockWs();
    gw.openSession({
      agentId: "agent-1",
      ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "alice",
    });
    ch.messages.length = 0; // drop the SshOpen so we assert only the resize

    gw.forwardResize("s1", 120, 40);
    expect(ch.messages).toHaveLength(1);
    const m = ch.messages[0];
    expect(m?.payload.case).toBe("sshResize");
    if (m?.payload.case === "sshResize") {
      expect(m.payload.value.sessionId).toBe("s1");
      expect(m.payload.value.cols).toBe(120);
      expect(m.payload.value.rows).toBe(40);
    }
  });

  test("forwardResize on an unknown session is a no-op", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({ dispatcher, logger: silent });
    gw.forwardResize("nope", 80, 24);
    expect(ch.messages).toHaveLength(0);
  });

  test("enforces the per-(user, agent) concurrent-session cap", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let n = 0;
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => `s${++n}`,
      limits: { maxPerUserAgent: 2 },
    });
    const creds = { host: "h", port: 22, username: "u", password: "p" };
    const open = (user: string) =>
      gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user });

    open("alice@x");
    open("alice@x");
    expect(() => open("alice@x")).toThrow(/session limit/);
    // A different user is counted independently.
    expect(() => open("bob@x")).not.toThrow();
  });

  test("closing a session frees a slot under the cap and invokes close hook", async () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let n = 0;
    const closedEvents: unknown[] = [];
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => `s${++n}`,
      limits: { maxPerUserAgent: 1 },
      onSessionClosed: async (event) => {
        closedEvents.push(event);
      },
    });
    const creds = { host: "h", port: 22, username: "u", password: "p" };
    const id = gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: creds,
      user: "a",
      actorUserId: "user-a",
    });
    expect(() =>
      gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user: "a" }),
    ).toThrow(/session limit/);
    gw.closeSession(id, "done");
    await Promise.resolve();
    expect(closedEvents).toEqual([
      { sessionId: "s1", agentId: "agent-1", actorUserId: "user-a", reason: "done" },
    ]);
    expect(() =>
      gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user: "a" }),
    ).not.toThrow();
  });

  test("enforces the per-user cap across different agents", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    dispatcher.register("agent-2", mockChannel());
    let n = 0;
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => `s${++n}`,
      limits: { maxPerUser: 2, maxPerUserAgent: 5 },
    });
    const creds = { host: "h", port: 22, username: "u", password: "p" };
    gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user: "a" });
    gw.openSession({ agentId: "agent-2", ws: mockWs().ws, credentials: creds, user: "a" });
    expect(() =>
      gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user: "a" }),
    ).toThrow(/session limit/);
  });

  test("sweepIdleSessions closes idle sessions; activity resets the idle clock", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 0;
    let n = 0;
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => `s${++n}`,
      now: () => now,
      idleTimeoutMs: 1000,
    });
    const creds = { host: "h", port: 22, username: "u", password: "p" };
    gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user: "a" }); // s1@0
    now = 500;
    gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user: "b" }); // s2@500

    now = 1100; // s1 idle 1100 ≥ 1000 → closed; s2 idle 600 < 1000 → kept
    expect(gw.sweepIdleSessions()).toBe(1);
    expect(gw.hasSession("s1")).toBe(false);
    expect(gw.hasSession("s2")).toBe(true);

    gw.forwardClientData("s2", new TextEncoder().encode("x")); // touches s2 at now=1100
    now = 1700;
    expect(gw.sweepIdleSessions()).toBe(0); // s2 idle 600 < 1000
    now = 2200;
    expect(gw.sweepIdleSessions()).toBe(1); // s2 idle 1100 ≥ 1000
    expect(gw.hasSession("s2")).toBe(false);
  });

  test("forwardResize counts as activity and resets the idle clock", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 0;
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
      now: () => now,
      idleTimeoutMs: 1000,
    });
    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "a",
    });
    now = 900;
    gw.forwardResize("s1", 120, 40); // client traffic — must reset the idle timer
    now = 1700; // 800ms since the resize < 1000 → still alive
    expect(gw.sweepIdleSessions()).toBe(0);
    expect(gw.hasSession("s1")).toBe(true);
  });

  test("closeSessionsForAgent closes every session bound to a disconnected agent", async () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    dispatcher.register("agent-2", mockChannel());
    let n = 0;
    const closedEvents: unknown[] = [];
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => `s${++n}`,
      onSessionClosed: (event) => {
        closedEvents.push(event);
      },
    });
    const creds = { host: "h", port: 22, username: "u", password: "p" };
    const ws1 = mockWs();
    const ws3 = mockWs();
    gw.openSession({
      agentId: "agent-1",
      ws: ws1.ws,
      credentials: creds,
      user: "a",
      actorUserId: "user-a",
    }); // s1
    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: creds,
      user: "b",
      actorUserId: "user-b",
    }); // s2
    gw.openSession({ agentId: "agent-2", ws: ws3.ws, credentials: creds, user: "c" }); // s3

    // agent-1's connectRPC stream just dropped — its ssh2 channels are gone, so
    // the gateway must free the orphaned sessions instead of leaving the clients
    // on a frozen terminal that still counts against their concurrent cap.
    const closed = gw.closeSessionsForAgent("agent-1", "agent disconnected");
    expect(closed).toBe(2);
    expect(gw.hasSession("s1")).toBe(false);
    expect(gw.hasSession("s2")).toBe(false);
    expect(gw.hasSession("s3")).toBe(true); // a different agent is untouched
    // The affected client got a clean WS close carrying the reason.
    expect(ws1.closed[0]?.reason).toContain("agent disconnected");
    expect(ws3.closed.length).toBe(0);
    await Promise.resolve();
    expect(closedEvents).toEqual([
      {
        sessionId: "s1",
        agentId: "agent-1",
        actorUserId: "user-a",
        reason: "agent disconnected",
      },
      {
        sessionId: "s2",
        agentId: "agent-1",
        actorUserId: "user-b",
        reason: "agent disconnected",
      },
    ]);
  });

  test("closeSessionsForAgent returns 0 when the agent has no sessions", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    const gw = new SshGateway({ dispatcher, logger: silent, newSessionId: () => "s1" });
    expect(gw.closeSessionsForAgent("agent-1")).toBe(0);
  });

  test("sweepAgedSessions force-closes sessions older than the max duration", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 0;
    let n = 0;
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => `s${++n}`,
      now: () => now,
      maxSessionMs: 1000,
    });
    const creds = { host: "h", port: 22, username: "u", password: "p" };
    gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user: "a" }); // s1@0
    now = 500;
    gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user: "b" }); // s2@500

    now = 1100; // s1 age 1100 ≥ 1000 → closed; s2 age 600 < 1000 → kept
    expect(gw.sweepAgedSessions()).toBe(1);
    expect(gw.hasSession("s1")).toBe(false);
    expect(gw.hasSession("s2")).toBe(true);

    // Unlike idle, activity does NOT reset the max-duration clock — it bounds
    // total session lifetime, so a continuously-active session still expires.
    gw.forwardClientData("s2", new TextEncoder().encode("x"));
    now = 1200; // s2 age 700 < 1000
    expect(gw.sweepAgedSessions()).toBe(0);
    now = 1500; // s2 age 1000 ≥ 1000
    expect(gw.sweepAgedSessions()).toBe(1);
    expect(gw.hasSession("s2")).toBe(false);
  });

  test("sweepAgedSessions is a no-op when the max duration is disabled (0)", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 0;
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
      now: () => now,
    });
    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "a",
    });
    now = 10_000_000;
    expect(gw.sweepAgedSessions()).toBe(0);
    expect(gw.hasSession("s1")).toBe(true);
  });

  test("idle timeout disabled (0) never sweeps", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 0;
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
      now: () => now,
    });
    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "a",
    });
    now = 10_000_000;
    expect(gw.sweepIdleSessions()).toBe(0);
    expect(gw.hasSession("s1")).toBe(true);
  });

  test("listSessions snapshots live sessions (metadata only, no secrets)", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 1000;
    let n = 0;
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => `s${++n}`,
      now: () => now,
    });
    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: { host: "h", port: 22, username: "u", password: "secret" },
      user: "alice",
      sourceIp: "10.0.0.1",
    });
    now = 1500;
    const sessions = gw.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "s1",
      agentId: "agent-1",
      user: "alice",
      sourceIp: "10.0.0.1",
      durationMs: 500,
    });
    expect(JSON.stringify(sessions)).not.toContain("secret");
  });

  test("rate-limits session opens per user within the time window", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 0;
    let n = 0;
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => `s${++n}`,
      now: () => now,
      limits: { maxOpensPerWindow: 2, openWindowMs: 1000, maxPerUserAgent: 100 },
    });
    const creds = { host: "h", port: 22, username: "u", password: "p" };
    const open = (user: string) =>
      gw.openSession({ agentId: "agent-1", ws: mockWs().ws, credentials: creds, user });

    open("a");
    open("a");
    // 3rd open within the same 1000ms window is rate-limited.
    expect(() => open("a")).toThrow(/rate limit/i);
    // A different user has an independent budget.
    expect(() => open("b")).not.toThrow();
    // After the window elapses, the original user can open again.
    now = 1500;
    expect(() => open("a")).not.toThrow();
  });

  test("forwardClientData encodes SshData and pushes to agent", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
    });
    const { ws } = mockWs();

    gw.openSession({
      agentId: "agent-1",
      ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "u",
    });
    gw.forwardClientData("s1", new TextEncoder().encode("ls\n"));

    expect(ch.messages).toHaveLength(2);
    const second = ch.messages[1];
    expect(second?.payload.case).toBe("sshData");
    if (second?.payload.case === "sshData") {
      expect(second.payload.value.sessionId).toBe("s1");
      expect(new TextDecoder().decode(second.payload.value.data)).toBe("ls\n");
    }
  });

  test("forwardClientData for unknown session is a no-op", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({ dispatcher, logger: silent });

    gw.forwardClientData("ghost", new TextEncoder().encode("x"));
    expect(ch.messages).toHaveLength(0);
  });

  test("handleAgentMessage with sshOutput forwards bytes to the WS client", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
    });
    const { ws, sent } = mockWs();

    gw.openSession({
      agentId: "agent-1",
      ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "u",
    });
    const out = create(AgentMessageSchema, {
      payload: {
        case: "sshOutput",
        value: create(SshOutputSchema, {
          sessionId: "s1",
          data: new TextEncoder().encode("hello"),
        }),
      },
    }) as AgentMessage;
    const consumed = gw.handleAgentMessage(out);

    expect(consumed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(new TextDecoder().decode(sent[0] as Uint8Array)).toBe("hello");
  });

  test("records terminal output and hands the recording to the sink on close", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 1000;
    const recordings: SshSessionRecording[] = [];
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
      now: () => now,
      recordSink: async (rec) => {
        recordings.push(rec);
      },
    });
    const output = (text: string) =>
      gw.handleAgentMessage(
        create(AgentMessageSchema, {
          payload: {
            case: "sshOutput",
            value: create(SshOutputSchema, {
              sessionId: "s1",
              data: new TextEncoder().encode(text),
            }),
          },
        }) as AgentMessage,
      );

    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "alice",
      actorUserId: "user-1",
    });
    now = 1500;
    output("hello");
    now = 2000;
    output("world");
    now = 3000;
    gw.closeSession("s1", "done");

    expect(recordings).toHaveLength(1);
    const rec = recordings[0];
    expect(rec?.events).toHaveLength(2);
    expect(rec?.events[0]?.tMs).toBe(500); // 1500 - 1000
    expect(new TextDecoder().decode(rec?.events[0]?.data)).toBe("hello");
    expect(rec?.startedAtMs).toBe(1000);
    expect(rec?.endedAtMs).toBe(3000);
    expect(rec?.reason).toBe("done");
    expect(rec?.user).toBe("alice");
    expect(rec?.actorUserId).toBe("user-1");
  });

  test("recording captures the session's negotiated terminal size", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 1000;
    const recordings: SshSessionRecording[] = [];
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
      now: () => now,
      recordSink: async (rec) => {
        recordings.push(rec);
      },
    });
    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "alice",
    });
    gw.forwardResize("s1", 160, 50);
    gw.handleAgentMessage(
      create(AgentMessageSchema, {
        payload: {
          case: "sshOutput",
          value: create(SshOutputSchema, { sessionId: "s1", data: new TextEncoder().encode("x") }),
        },
      }) as AgentMessage,
    );
    now = 2000;
    gw.closeSession("s1", "done");

    expect(recordings[0]?.cols).toBe(160);
    expect(recordings[0]?.rows).toBe(50);
  });

  test("recording stops at the byte cap and appends a truncation marker", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    let now = 0;
    const recordings: SshSessionRecording[] = [];
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
      now: () => now,
      recordSink: async (rec) => {
        recordings.push(rec);
      },
      maxRecordingBytes: 10,
    });
    const output = (text: string) =>
      gw.handleAgentMessage(
        create(AgentMessageSchema, {
          payload: {
            case: "sshOutput",
            value: create(SshOutputSchema, {
              sessionId: "s1",
              data: new TextEncoder().encode(text),
            }),
          },
        }) as AgentMessage,
      );

    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "alice",
    });
    output("12345"); // used = 5
    output("67890"); // used = 10 → cap reached, marker appended
    output("EXTRA"); // dropped — over cap
    now = 100;
    gw.closeSession("s1", "done");

    const all = (recordings[0]?.events ?? []).map((e) => new TextDecoder().decode(e.data)).join("");
    expect(all).toContain("1234567890");
    expect(all).toContain("recording truncated");
    expect(all).not.toContain("EXTRA");
  });

  test("no recording sink: a session opens, outputs, and closes without recording", () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    const gw = new SshGateway({ dispatcher, logger: silent, newSessionId: () => "s1" });
    gw.openSession({
      agentId: "agent-1",
      ws: mockWs().ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "u",
    });
    expect(() => gw.closeSession("s1", "done")).not.toThrow();
  });

  test("handleAgentMessage with sshClosed sends close frame and frees session", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
    });
    const { ws, closed } = mockWs();

    gw.openSession({
      agentId: "agent-1",
      ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "u",
    });
    const closedMsg = create(AgentMessageSchema, {
      payload: {
        case: "sshClosed",
        value: create(SshClosedSchema, {
          sessionId: "s1",
          reason: "remote eof",
        }),
      },
    }) as AgentMessage;

    const consumed = gw.handleAgentMessage(closedMsg);
    expect(consumed).toBe(true);
    expect(closed[0]?.code).toBe(1000);
    expect(closed[0]?.reason).toBe("remote eof");
    expect(gw.activeCount()).toBe(0);
  });

  test("handleAgentMessage returns false for non-SSH variants", () => {
    const dispatcher = new AgentDispatcher();
    const gw = new SshGateway({ dispatcher, logger: silent });

    const heartbeat = create(AgentMessageSchema, {
      payload: { case: "heartbeat", value: { agentId: "x" } },
    }) as AgentMessage;
    expect(gw.handleAgentMessage(heartbeat)).toBe(false);
  });

  test("closeSession sends SshClose to agent and closes the WS", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
    });
    const { ws, closed } = mockWs();

    gw.openSession({
      agentId: "agent-1",
      ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "u",
    });
    gw.closeSession("s1", "client gone");

    const closeMsg = ch.messages.find((m) => m.payload.case === "sshClose");
    expect(closeMsg).toBeDefined();
    if (closeMsg?.payload.case === "sshClose") {
      expect(closeMsg.payload.value.sessionId).toBe("s1");
      expect(closeMsg.payload.value.reason).toBe("client gone");
    }
    expect(closed[0]?.reason).toBe("client gone");
    expect(gw.activeCount()).toBe(0);
  });

  test("audit hook is called on open + close", async () => {
    const dispatcher = new AgentDispatcher();
    dispatcher.register("agent-1", mockChannel());
    const events: SshAuditEvent[] = [];
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
      auditLog: async (e) => {
        events.push(e);
      },
    });
    const { ws } = mockWs();

    gw.openSession({
      agentId: "agent-1",
      ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "alice",
      sourceIp: "10.0.0.1",
    });
    gw.closeSession("s1", "done");

    // Audit log calls are not awaited inside the gateway; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("session_open");
    expect(events[1]?.kind).toBe("session_close");
    if (events[0]?.kind === "session_open") {
      expect(events[0].user).toBe("alice");
      expect(events[0].sourceIp).toBe("10.0.0.1");
    }
    if (events[1]?.kind === "session_close") {
      expect(events[1].reason).toBe("done");
      expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("WS send failure triggers a session close", () => {
    const dispatcher = new AgentDispatcher();
    const ch = mockChannel();
    dispatcher.register("agent-1", ch);
    const gw = new SshGateway({
      dispatcher,
      logger: silent,
      newSessionId: () => "s1",
    });
    const sent: Array<unknown> = [];
    const closed: Array<{ code?: number; reason?: string }> = [];
    const ws: WsConnectionLike = {
      send: () => {
        throw new Error("ws gone");
      },
      close: (code, reason) => closed.push({ code, reason }),
    };

    gw.openSession({
      agentId: "agent-1",
      ws,
      credentials: { host: "h", port: 22, username: "u", password: "p" },
      user: "u",
    });
    const out = create(AgentMessageSchema, {
      payload: {
        case: "sshOutput",
        value: create(SshOutputSchema, {
          sessionId: "s1",
          data: new TextEncoder().encode("x"),
        }),
      },
    }) as AgentMessage;
    gw.handleAgentMessage(out);

    expect(sent).toHaveLength(0);
    expect(closed[0]?.reason).toBe("ws send failed");
    expect(gw.activeCount()).toBe(0);
  });
});
