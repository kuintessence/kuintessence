/**
 * agent-handler integration with mTLS context.
 *
 * Verifies that when an mTLS context is active, the agent-handler refuses
 * a RegisterRequest whose `agentId` doesn't match the verified
 * fingerprint -> agentId mapping from the cert ledger. This closes the
 * trust hole where the previous handler accepted whatever agentId the
 * client sent in the body.
 */
import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import {
  AgentMessageSchema,
  RegisterRequestSchema,
  SchedulerType,
  type ServerMessage,
} from "@kuintessence/proto";
import pino from "pino";
import { runWithMtlsContext } from "../auth/mtls-context";
import { registerAgentHandler } from "./agent-handler";
import { AgentDispatcher } from "./dispatcher";

type ConnectImpl = (requests: AsyncIterable<unknown>) => AsyncIterable<ServerMessage>;
function createMockRouter(): { router: ConnectRouter; handlers: { connect?: ConnectImpl } } {
  const handlers: { connect?: ConnectImpl } = {};
  const router = {
    service: (_s: unknown, impls: { connect?: ConnectImpl }) => {
      handlers.connect = impls.connect;
      return router;
    },
    rpc: () => router,
    handlers: [],
  } as unknown as ConnectRouter;
  return { router, handlers };
}

async function* iter<T>(...items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

const fakeAgentManager = {
  register: async () => undefined,
  heartbeat: async () => undefined,
  list: async () => [],
  getById: async () => null,
} as unknown as Parameters<typeof registerAgentHandler>[1]["agentManager"];

const fakeKnownAgentManager = {
  register: async () => undefined,
  heartbeat: async () => undefined,
  list: async () => [],
  getById: async () => ({ agentId: "agent-good" }),
} as unknown as Parameters<typeof registerAgentHandler>[1]["agentManager"];

const fakeJobService = {
  updateStatus: async () => undefined,
} as unknown as Parameters<typeof registerAgentHandler>[1]["jobService"];

describe("agent-handler under mTLS context", () => {
  test("rejects RegisterRequest whose agentId differs from verified cert agentId", async () => {
    const { router, handlers } = createMockRouter();
    const dispatcher = new AgentDispatcher();
    registerAgentHandler(router, {
      agentManager: fakeAgentManager,
      jobService: fakeJobService,
      logger: pino({ level: "silent" }),
      dispatcher,
    });

    const reg = create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: "agent-attacker", // body claims attacker
          siteName: "site-x",
          schedulerType: SchedulerType.SLURM,
          schedulerVersion: "20.11",
        }),
      },
    });

    const responses: ServerMessage[] = await runWithMtlsContext(
      { agentId: "agent-victim", fingerprintSha256: "f".repeat(64) },
      async () => {
        const out: ServerMessage[] = [];
        if (!handlers.connect) throw new Error("connect handler not registered");
        for await (const m of handlers.connect(iter(reg)) as AsyncIterable<ServerMessage>) {
          out.push(m);
          if (out.length >= 1) break;
        }
        return out;
      },
    );
    expect(responses.length).toBe(1);
    const first = responses[0];
    if (first?.payload.case !== "registerResponse") {
      throw new Error(`expected registerResponse, got ${first?.payload.case}`);
    }
    expect(first.payload.value.accepted).toBe(false);
    expect(first.payload.value.message).toMatch(/mismatch|cert|agent/i);
  });

  test("accepts RegisterRequest when body agentId matches a known verified context", async () => {
    const { router, handlers } = createMockRouter();
    const dispatcher = new AgentDispatcher();
    registerAgentHandler(router, {
      agentManager: fakeKnownAgentManager,
      jobService: fakeJobService,
      logger: pino({ level: "silent" }),
      dispatcher,
    });

    const reg = create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: "agent-good",
          siteName: "site-x",
          schedulerType: SchedulerType.SLURM,
          schedulerVersion: "20.11",
        }),
      },
    });

    const responses: ServerMessage[] = await runWithMtlsContext(
      { agentId: "agent-good", fingerprintSha256: "0".repeat(64) },
      async () => {
        const out: ServerMessage[] = [];
        if (!handlers.connect) throw new Error("connect handler not registered");
        for await (const m of handlers.connect(iter(reg)) as AsyncIterable<ServerMessage>) {
          out.push(m);
          if (out.length >= 1) break;
        }
        return out;
      },
    );
    const first = responses[0];
    if (first?.payload.case !== "registerResponse") {
      throw new Error(`expected registerResponse, got ${first?.payload.case}`);
    }
    expect(first.payload.value.accepted).toBe(true);
  });

  test("rejects matching mTLS RegisterRequest when the agent row was not pre-registered", async () => {
    const { router, handlers } = createMockRouter();
    const dispatcher = new AgentDispatcher();
    registerAgentHandler(router, {
      agentManager: fakeAgentManager,
      jobService: fakeJobService,
      logger: pino({ level: "silent" }),
      dispatcher,
    });

    const reg = create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: "agent-good",
          siteName: "site-x",
          schedulerType: SchedulerType.SLURM,
          schedulerVersion: "20.11",
        }),
      },
    });

    const responses: ServerMessage[] = await runWithMtlsContext(
      { agentId: "agent-good", fingerprintSha256: "0".repeat(64) },
      async () => {
        const out: ServerMessage[] = [];
        if (!handlers.connect) throw new Error("connect handler not registered");
        for await (const m of handlers.connect(iter(reg)) as AsyncIterable<ServerMessage>) {
          out.push(m);
          if (out.length >= 1) break;
        }
        return out;
      },
    );
    const first = responses[0];
    if (first?.payload.case !== "registerResponse") {
      throw new Error(`expected registerResponse, got ${first?.payload.case}`);
    }
    expect(first.payload.value.accepted).toBe(false);
    expect(first.payload.value.message).toMatch(/registered/i);
  });

  test("without mTLS context, accepts the body agentId in development mode", async () => {
    const { router, handlers } = createMockRouter();
    const dispatcher = new AgentDispatcher();
    registerAgentHandler(router, {
      agentManager: fakeAgentManager,
      jobService: fakeJobService,
      logger: pino({ level: "silent" }),
      dispatcher,
    });

    const reg = create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: "agent-anything",
          siteName: "site-x",
          schedulerType: SchedulerType.SLURM,
          schedulerVersion: "20.11",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    const out: ServerMessage[] = [];
    for await (const m of handlers.connect(iter(reg)) as AsyncIterable<ServerMessage>) {
      out.push(m);
      if (out.length >= 1) break;
    }
    const first = out[0];
    if (first?.payload.case !== "registerResponse") {
      throw new Error("expected registerResponse");
    }
    expect(first.payload.value.accepted).toBe(true);
  });
});
