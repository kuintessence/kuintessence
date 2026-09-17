import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Http2Server, type ServerHttp2Session } from "node:http2";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  AgentMessageSchema,
  AgentService,
  RegisterRequestSchema,
  SchedulerType,
} from "@kuintessence/proto";
import pino from "pino";
import type { AgentManager } from "../services/agent-manager";
import type { JobService } from "../services/job-service";
import { AgentDispatcher } from "./dispatcher";
import { createGrpcConnectNodeHandler } from "./server";

const servers: Http2Server[] = [];
const sessions: ServerHttp2Session[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("createGrpcConnectNodeHandler", () => {
  test("delivers the register response while the request stream remains open", async () => {
    const agentManager = {
      register: async () => ({ agentId: "transport-test-agent" }),
    } as unknown as AgentManager;
    const handler = createGrpcConnectNodeHandler(
      {
        agentManager,
        jobService: {} as JobService,
        logger: pino({ level: "silent" }),
        dispatcher: new AgentDispatcher(),
      },
      {
        enabled: false,
        fingerprintHeader: "x-agent-cert-fingerprint",
        lookup: async () => null,
      },
    );
    const server = createServer(handler);
    server.on("session", (session) => sessions.push(session));
    servers.push(server);
    await listenOnAvailablePort(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const transport = createConnectTransport({
      baseUrl: `http://127.0.0.1:${address.port}`,
      httpVersion: "2",
      useBinaryFormat: true,
    });
    const client = createClient(AgentService, transport);
    let closeRequestStream: (() => void) | undefined;
    async function* requests() {
      yield create(AgentMessageSchema, {
        payload: {
          case: "register",
          value: create(RegisterRequestSchema, {
            agentId: "transport-test-agent",
            siteName: "transport-test-site",
            schedulerType: SchedulerType.SLURM,
            schedulerVersion: "23.02",
          }),
        },
      });
      await new Promise<void>((resolve) => {
        closeRequestStream = resolve;
      });
    }

    const responses = client.connect(requests())[Symbol.asyncIterator]();
    const first = await Promise.race([responses.next(), timeout(1_000)]);
    expect(first.done).toBe(false);
    expect(first.value?.payload.case).toBe("registerResponse");
    if (first.value?.payload.case === "registerResponse") {
      expect(first.value.payload.value.accepted).toBe(true);
    }
    closeRequestStream?.();
    await responses.return?.();
  });
});

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("response was buffered until request completion")), ms);
  });
}

async function listenOnAvailablePort(server: Http2Server): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 30_000 + Math.floor(Math.random() * 20_000);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("test server could not find an available TCP port");
}
