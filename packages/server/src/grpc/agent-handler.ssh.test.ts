import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import {
  type AgentMessage,
  AgentMessageSchema,
  RegisterRequestSchema,
  SchedulerType,
  SshClosedSchema,
  SshOutputSchema,
} from "@kuintessence/proto";
import pino from "pino";
import type { AgentManager } from "../services/agent-manager";
import type { JobService } from "../services/job-service";
import type { SshGateway } from "../services/ssh-gateway";
import { registerAgentHandler } from "./agent-handler";
import { AgentDispatcher } from "./dispatcher";

// The reverse SSH path (Agent → Server `sshOutput`/`sshClosed`) is the only thing
// that carries terminal output back to the subscribed WebSocket client. Its
// dispatch arm in registerAgentHandler touches only the gateway — not the
// DB-backed agentManager/jobService — so this guard runs with fake deps and no
// database, unlike the integration-style `agent-handler.test.ts`.

const silent = pino({ level: "silent" });

type ConnectImpl = (requests: AsyncIterable<unknown>) => AsyncIterable<unknown>;

function createMockRouter(): { router: ConnectRouter; handlers: { connect?: ConnectImpl } } {
  const handlers: { connect?: ConnectImpl } = {};
  const router = {
    service: (_service: unknown, impls: { connect?: ConnectImpl }) => {
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

async function drain<T>(stream: AsyncIterable<T>): Promise<void> {
  for await (const _ of stream) {
    // discard outbound frames — this guard only asserts the gateway saw the input
  }
}

describe("agent-handler SSH reverse dispatch", () => {
  test("routes sshOutput and sshClosed AgentMessages to the gateway", async () => {
    const seen: string[] = [];
    const fakeGateway = {
      handleAgentMessage: (m: AgentMessage) => {
        seen.push(m.payload.case ?? "");
        return true;
      },
    } as unknown as SshGateway;

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: {} as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      sshGateway: fakeGateway,
    });

    const outputMsg = create(AgentMessageSchema, {
      payload: {
        case: "sshOutput",
        value: create(SshOutputSchema, { sessionId: "s1", data: new TextEncoder().encode("hi") }),
      },
    });
    const closedMsg = create(AgentMessageSchema, {
      payload: {
        case: "sshClosed",
        value: create(SshClosedSchema, { sessionId: "s1", reason: "done" }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    await drain(handlers.connect(iter(outputMsg, closedMsg)));

    expect(seen).toEqual(["sshOutput", "sshClosed"]);
  });

  test("closes orphaned SSH sessions for the agent when its stream ends", async () => {
    const closedFor: string[] = [];
    const fakeGateway = {
      handleAgentMessage: () => true,
      closeSessionsForAgent: (agentId: string) => {
        closedFor.push(agentId);
        return 1;
      },
    } as unknown as SshGateway;

    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: { register: async () => undefined } as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      sshGateway: fakeGateway,
    });

    const registerMsg = create(AgentMessageSchema, {
      payload: {
        case: "register",
        value: create(RegisterRequestSchema, {
          agentId: "agent-9",
          siteName: "site-9",
          schedulerType: SchedulerType.SLURM,
          schedulerVersion: "23.02.7",
        }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    // The stream yields a register then completes (agent disconnected). The
    // handler's finally block must free the agent's SSH sessions.
    await drain(handlers.connect(iter(registerMsg)));
    expect(closedFor).toEqual(["agent-9"]);
  });

  test("drops SSH frames cleanly when no gateway is attached", async () => {
    const { router, handlers } = createMockRouter();
    registerAgentHandler(router, {
      agentManager: {} as unknown as AgentManager,
      jobService: {} as unknown as JobService,
      logger: silent,
      dispatcher: new AgentDispatcher(),
      // no sshGateway
    });

    const outputMsg = create(AgentMessageSchema, {
      payload: {
        case: "sshOutput",
        value: create(SshOutputSchema, { sessionId: "s1", data: new TextEncoder().encode("x") }),
      },
    });

    if (!handlers.connect) throw new Error("connect handler not registered");
    // Must not throw when the gateway is absent (dev/test mode without WS).
    await drain(handlers.connect(iter(outputMsg)));
  });
});
