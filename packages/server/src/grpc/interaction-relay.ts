import { createHmac, timingSafeEqual } from "node:crypto";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  type AgentMessage,
  AgentMessageSchema,
  type ServerMessage,
  ServerMessageSchema,
} from "@kuintessence/proto";
import { z } from "zod";
import type { AgentSessions } from "./agent-sessions";
import type { AgentChannel } from "./dispatcher";
import {
  cancelInteraction,
  commandFlow,
  type Interaction,
  lostInteraction,
  replyFlow,
} from "./interaction-flow";

export const relayPath = "/internal/agent-interactions";
const limit = 4 * 1024 * 1024;
const maxFlows = 1024;
// Bound silent peers even if the Agent stays connected after a caller times out.
const replyTimeoutMs = { shell: 30_000, logs: 10_000, transfer: 600_000, accounting: 60_000 };
const bindingSchema = z.strictObject({
  origin: z.uuid(),
  owner: z.uuid(),
  session: z.uuid(),
  agent: z.string().min(1).max(255),
  kind: z.enum(["ssh", "shell", "logs", "transfer", "accounting"]),
  id: z.string().min(1).max(128),
  nonce: z.uuid(),
  until: z.number().int(),
});
type Binding = z.infer<typeof bindingSchema>;
interface Route {
  serverId: string;
  sessionId: string;
  relayOrigin: string | null;
  expiresAt: Date;
}
export interface RelaySocket {
  send(data: Uint8Array): void;
  close(): void;
  readonly bufferedAmount: number;
}
interface Flow {
  binding: Binding;
  finish(): void;
  complete?(): void;
  send(bytes: Uint8Array): void;
}
function key(agent: string, flow: Interaction) {
  return JSON.stringify([agent, flow.kind, flow.id]);
}
function matches(flow: Interaction | undefined, binding: Binding) {
  return flow?.kind === binding.kind && flow.id === binding.id;
}
export class InteractionRelay {
  private readonly outgoing = new Map<string, Flow>();
  private readonly incoming = new Map<string, Flow>();
  private readonly nonces = new Map<string, number>();
  private routes = new Map<string, Route>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      sessions: Pick<AgentSessions, "live" | "serverId">;
      origins: readonly string[];
      secret: string;
      local: (agent: string) => AgentChannel | undefined;
      receive: (
        agent: string,
        message: AgentMessage,
        send: (response: ServerMessage) => void,
      ) => Promise<void>;
      connect?: (url: string, token: string) => WebSocket;
    },
  ) {}
  async refresh() {
    const routes = await this.options.sessions.live();
    this.routes = new Map(
      [...routes].filter(
        ([, r]) =>
          r.serverId !== this.options.sessions.serverId &&
          !!r.relayOrigin &&
          this.options.origins.includes(r.relayOrigin),
      ),
    );
    for (const flow of this.outgoing.values())
      if (this.route(flow.binding.agent)?.sessionId !== flow.binding.session) flow.finish();
    for (const flow of this.incoming.values())
      if (
        this.options.local(flow.binding.agent)?.controlSessionId !== flow.binding.session ||
        routes.get(flow.binding.agent)?.sessionId !== flow.binding.session
      )
        flow.finish();
  }
  async start() {
    await this.refresh();
    let busy = false;
    this.timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.refresh()
        .catch(() => {
          this.routes.clear();
          for (const f of [...this.incoming.values(), ...this.outgoing.values()]) f.finish();
        })
        .finally(() => {
          busy = false;
        });
    }, 1000);
  }
  stop() {
    clearInterval(this.timer);
    this.routes.clear();
    for (const f of [...this.incoming.values(), ...this.outgoing.values()]) f.finish();
  }
  private route(agent: string) {
    const r = this.routes.get(agent);
    return r && r.expiresAt.getTime() > Date.now() ? r : undefined;
  }
  online() {
    return [...this.routes.keys()].filter((a) => this.route(a));
  }
  channel(agent: string): AgentChannel | undefined {
    const route = this.route(agent);
    if (!route) return;
    return {
      controlSessionId: route.sessionId,
      close: () => {},
      push: (m) => this.push(agent, route, m),
    };
  }
  private sign(body: string) {
    return createHmac("sha256", this.options.secret)
      .update("kq-agent-relay-v1.")
      .update(body)
      .digest();
  }
  private push(agent: string, route: Route, message: ServerMessage) {
    const desc = commandFlow(message);
    if (!desc?.id || desc.id.length > 128 || this.route(agent)?.sessionId !== route.sessionId)
      throw new Error("Invalid Agent interaction route");
    const k = key(agent, desc);
    const existing = this.outgoing.get(k);
    const bytes = toBinary(ServerMessageSchema, message);
    if (bytes.length > limit) throw new Error("Agent interaction frame exceeds limit");
    if (!desc.open) {
      if (existing?.binding.session !== route.sessionId)
        throw new Error("Agent interaction expired");
      existing.send(bytes);
      return;
    }
    if (existing || this.outgoing.size >= maxFlows)
      throw new Error("Agent interaction unavailable");
    const binding: Binding = {
      agent,
      kind: desc.kind,
      id: desc.id,
      owner: route.serverId,
      origin: this.options.sessions.serverId,
      session: route.sessionId,
      nonce: crypto.randomUUID(),
      until: Date.now() + 15000,
    };
    const body = Buffer.from(JSON.stringify(binding)).toString("base64url");
    const token = body + "." + this.sign(body).toString("base64url");
    const url = route.relayOrigin + relayPath;
    const socket =
      this.options.connect?.(url, token) ??
      new WebSocket(url, { headers: { Authorization: "Bearer " + token } });
    socket.binaryType = "arraybuffer";
    const pending: Uint8Array[] = [bytes];
    let queued = bytes.length,
      done = false;
    const finish = () => {
      if (this.outgoing.get(k) !== flow) return;
      this.outgoing.delete(k);
      clearTimeout(deadline);
      pending.length = 0;
      socket.close();
      const lost = !done && lostInteraction(desc);
      if (lost) void this.options.receive(agent, lost, () => {}).catch(() => {});
    };
    const send = (chunk: Uint8Array) => {
      if (socket.readyState === 0 && queued + chunk.length <= limit) {
        pending.push(chunk);
        queued += chunk.length;
        return;
      }
      if (socket.readyState !== 1 || socket.bufferedAmount + chunk.length > limit) {
        finish();
        throw new Error("Agent relay unavailable");
      }
      socket.send(chunk);
    };
    const flow = { binding, finish, send };
    this.outgoing.set(k, flow);
    let deadline = setTimeout(finish, 15000);
    socket.onopen = () => {
      clearTimeout(deadline);
      if (desc.kind !== "ssh") deadline = setTimeout(finish, replyTimeoutMs[desc.kind]);
      try {
        for (const chunk of pending) send(chunk);
      } catch {
        finish();
      }
      pending.length = 0;
      queued = 0;
    };
    socket.onerror = socket.onclose = finish;
    socket.onmessage = (e) => {
      if (this.outgoing.get(k) !== flow) return;
      try {
        if (!(e.data instanceof ArrayBuffer) || e.data.byteLength > limit) throw new Error();
        const m = fromBinary(AgentMessageSchema, new Uint8Array(e.data));
        const response = replyFlow(m);
        if (!matches(response, binding)) throw new Error();
        done = !!response?.terminal;
        void this.options
          .receive(agent, m, (r) => {
            if (this.outgoing.get(k) === flow && matches(commandFlow(r), binding))
              send(toBinary(ServerMessageSchema, r));
          })
          .catch(finish);
        if (done) finish();
      } catch {
        finish();
      }
    };
  }
  authorize(header: string | undefined) {
    if (!header?.startsWith("Bearer ") || header.length > 4096) return;
    const parts = header.slice(7).split(".");
    if (parts.length !== 2) return;
    const [body, tag] = parts;
    if (!body || !tag) return;
    const mac = Buffer.from(tag, "base64url"),
      expected = this.sign(body);
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return;
    try {
      const b = bindingSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString()));
      const now = Date.now();
      for (const [id, expiry] of this.nonces) if (expiry <= now) this.nonces.delete(id);
      if (
        b.until <= now ||
        b.until > now + 30000 ||
        b.owner !== this.options.sessions.serverId ||
        this.options.local(b.agent)?.controlSessionId !== b.session ||
        this.nonces.has(b.nonce) ||
        this.nonces.size >= 32768
      )
        return;
      this.nonces.set(b.nonce, b.until);
      return b;
    } catch {
      return;
    }
  }
  accept(binding: Binding, socket: RelaySocket) {
    const k = key(binding.agent, binding);
    const channel = this.options.local(binding.agent);
    if (
      !channel ||
      channel.controlSessionId !== binding.session ||
      this.incoming.has(k) ||
      this.incoming.size >= maxFlows
    ) {
      socket.close();
      return;
    }
    let opened = false,
      done = false;
    const finish = () => {
      if (this.incoming.get(k) !== flow) return;
      this.incoming.delete(k);
      clearTimeout(deadline);
      socket.close();
      const cancel = opened && !done && cancelInteraction(binding);
      if (cancel && this.options.local(binding.agent) === channel) {
        try {
          channel.push(cancel);
        } catch {
          /* disconnected */
        }
      }
    };
    const flow = {
      binding,
      finish,
      complete: () => {
        done = true;
        finish();
      },
      send: (chunk: Uint8Array) => {
        if (chunk.length + socket.bufferedAmount > limit) {
          finish();
          return;
        }
        socket.send(chunk);
      },
    };
    this.incoming.set(k, flow);
    let deadline = setTimeout(finish, 15000);
    return {
      finish,
      command: (data: unknown) => {
        if (this.incoming.get(k) !== flow) return;
        try {
          if (
            !(data instanceof ArrayBuffer) ||
            data.byteLength > limit ||
            this.options.local(binding.agent) !== channel
          )
            throw new Error();
          const message = fromBinary(ServerMessageSchema, new Uint8Array(data));
          const desc = commandFlow(message);
          if (
            !matches(desc, binding) ||
            Boolean(desc?.open) === opened ||
            (desc?.kind === "accounting" && !channel.federationAccountingV1)
          )
            throw new Error();
          channel.push(message);
          if (!opened) {
            opened = true;
            clearTimeout(deadline);
            if (binding.kind !== "ssh") deadline = setTimeout(finish, replyTimeoutMs[binding.kind]);
          }
        } catch {
          finish();
        }
      },
    };
  }
  reply(agent: string, session: string, message: AgentMessage) {
    const desc = replyFlow(message);
    if (!desc) return false;
    const flow = this.incoming.get(key(agent, desc));
    if (!flow || flow.binding.session !== session) return false;
    try {
      flow.send(toBinary(AgentMessageSchema, message));
      if (desc.terminal) flow.complete?.();
    } catch {
      flow.finish();
    }
    return true;
  }
}
