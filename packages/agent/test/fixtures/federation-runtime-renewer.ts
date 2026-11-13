import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import * as schema from "@kuintessence/db";
import {
  type AgentMessage,
  FederationExecutionDecision,
  FederationExecutionResponseSchema,
  RegisterResponseSchema,
  type ServerMessage,
  ServerMessageSchema,
} from "@kuintessence/proto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import pino from "pino";
import { ActiveRemoteJobs } from "../../src/queue/active-remote-jobs";
import { InboundAcks } from "../../src/queue/inbound-acks";
import { JobCleanupIntents, JobRevocationTombstones } from "../../src/queue/job-cleanup-intents";
import type { ServerClient } from "../../src/server-client";
import { AgentStream } from "../../src/stream";

const [path, statePath] = Bun.argv.slice(2);
if (!path || !statePath) throw new Error("Missing Agent fixture arguments");
const sqlite = new Database(path, { readwrite: true });
sqlite.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
const db = drizzle(sqlite, { schema });
const state: { type: string; schedulerJobId: string } = JSON.parse(readFileSync(statePath, "utf8"));
let renewals = 0;
const client = {
  connect(requests: AsyncIterable<AgentMessage>) {
    void (async () => {
      for await (const message of requests) {
        if (message.payload.case !== "federationExecutionRequest") continue;
        const request = message.payload.value;
        if (!request.runtimeRenewal)
          throw new Error("Recovered runtime must not request a dispatch");
        await (
          stream as unknown as { handleServerMessage(message: ServerMessage): Promise<void> }
        ).handleServerMessage(
          create(ServerMessageSchema, {
            payload: {
              case: "federationExecutionResponse",
              value: create(FederationExecutionResponseSchema, {
                requestId: request.requestId,
                jobId: request.jobId,
                dispatchEpoch: request.dispatchEpoch,
                runtimeRenewal: true,
                decision: FederationExecutionDecision.GRANTED,
                expiresAtUnixMs: BigInt(Date.now() + 800),
              }),
            },
          }),
        );
        writeFileSync(`${statePath}.renewals`, String(++renewals));
      }
    })().catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
    return (async function* () {
      yield create(ServerMessageSchema, {
        payload: {
          case: "registerResponse",
          value: create(RegisterResponseSchema, {
            accepted: true,
            federationExecutionV1Supported: true,
          }),
        },
      });
      await new Promise<void>(() => {});
    })();
  },
} as unknown as ServerClient;
const stream = new AgentStream({
  client,
  agentId: "fixture-agent",
  siteName: "fixture-site",
  logger: pino({ level: "silent" }),
  heartbeatIntervalMs: 500,
  jobPollIntervalMs: 100,
  inboundAcks: new InboundAcks(db),
  activeRemoteJobs: new ActiveRemoteJobs(db),
  cleanupIntents: new JobCleanupIntents(db),
  revocationTombstones: new JobRevocationTombstones(db),
  adapter: {
    type: state.type,
    version: "test",
    submit: async () => {
      throw new Error("Recovered runtime must not submit again");
    },
    cancel: async () => {
      throw new Error("Healthy Agent should not cancel the task");
    },
    status: async () => ({ status: "running" }),
  },
});
await stream.start();
