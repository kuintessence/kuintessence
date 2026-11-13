import { writeFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { createSqliteDb } from "@kuintessence/db";
import {
  type AgentMessage,
  DispatchJobSchema,
  FederationExecutionDecision,
  FederationExecutionResponseSchema,
  RegisterResponseSchema,
  type ServerMessage,
  ServerMessageSchema,
} from "@kuintessence/proto";
import pino from "pino";
import { ActiveRemoteJobs } from "../../src/queue/active-remote-jobs";
import { InboundAcks } from "../../src/queue/inbound-acks";
import { JobCleanupIntents, JobRevocationTombstones } from "../../src/queue/job-cleanup-intents";
import type { ServerClient } from "../../src/server-client";
import { AgentStream } from "../../src/stream";

const [databasePath, jobId, schedulerRecord] = Bun.argv.slice(2);
if (!databasePath || !jobId || !schedulerRecord) throw new Error("Missing crash fixture arguments");
const db = createSqliteDb(databasePath);
const dispatch = create(DispatchJobSchema, {
  jobId,
  dispatchEpoch: 1n,
  federationExecution: true,
  name: "crash-test",
  command: "echo original",
  cpus: 1,
  memoryMb: 128n,
  wallTimeSec: 60n,
});
const client = {
  connect(request: AsyncIterable<AgentMessage>) {
    void (async () => {
      for await (const message of request) {
        if (message.payload.case !== "federationExecutionRequest") continue;
        const grant = message.payload.value;
        await (
          stream as unknown as { handleServerMessage(message: ServerMessage): Promise<void> }
        ).handleServerMessage(
          create(ServerMessageSchema, {
            payload: {
              case: "federationExecutionResponse",
              value: create(FederationExecutionResponseSchema, {
                requestId: grant.requestId,
                jobId: grant.jobId,
                dispatchEpoch: grant.dispatchEpoch,
                decision: FederationExecutionDecision.GRANTED,
                expiresAtUnixMs: BigInt(Date.now() + 10_000),
                dispatch,
              }),
            },
          }),
        );
      }
    })().catch((error: unknown) => {
      throw error;
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
      yield create(ServerMessageSchema, { payload: { case: "dispatchJob", value: dispatch } });
      await new Promise<void>(() => {});
    })();
  },
} as unknown as ServerClient;
const stream = new AgentStream({
  client,
  agentId: "agent",
  siteName: "test-site",
  heartbeatIntervalMs: 60_000,
  logger: pino({ level: "silent" }),
  inboundAcks: new InboundAcks(db),
  assertFederationRuntimeWatchdog: async () => {},
  activeRemoteJobs: new ActiveRemoteJobs(db),
  cleanupIntents: new JobCleanupIntents(db),
  revocationTombstones: new JobRevocationTombstones(db),
  adapter: {
    type: "test",
    version: "1",
    submit: async (spec) => {
      writeFileSync(
        schedulerRecord,
        JSON.stringify({ jobId: spec.jobId, schedulerJobId: "accepted-before-crash" }),
      );
      process.exit(73);
    },
    cancel: async () => {
      throw new Error("Unexpected cancellation");
    },
    status: async () => ({ status: "completed", exitCode: 0 }),
  },
});
await stream.start();
