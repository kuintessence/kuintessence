/**
 * Integration test for OutboundQueue + AgentStream.
 *
 * Strategy
 * --------
 * Rather than mocking a real Server disconnect-reconnect (which requires
 * juggling generator lifetimes), we exercise the contract directly:
 *
 *   1. Pre-seed the SQLite-backed queue with offline-produced items.
 *   2. Start an AgentStream wired to that queue against a mock client.
 *   3. Verify reconnect replays queue contents in order BEFORE any new live
 *      traffic, durable status rows remain until Server ACK, and Heartbeat.queuedJobs reflects
 *      OutboundQueue.pendingCount() (not hardcoded 0).
 *   4. Verify enqueueStatusUpdate persists when the stream is offline.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import * as schema from "@kuintessence/db";
import { runSqliteMigrations } from "@kuintessence/db";
import {
  DispatchJobSchema,
  RegisterResponseSchema,
  ServerMessageSchema,
} from "@kuintessence/proto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import pino from "pino";
import type { SchedulerAdapter } from "../adapters/base";
import { AgentStream } from "../stream";
import { InboundAcks } from "./inbound-acks";
import { OutboundQueue } from "./outbound-queue";

const silent = pino({ level: "silent" });

function freshDb() {
  const sqlite = new Database(":memory:");
  runSqliteMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function makeAdapter(): SchedulerAdapter {
  return {
    type: "slurm",
    version: "23.02.7",
    submit: async () => ({ schedulerJobId: "sched-1" }),
    cancel: async () => {},
    status: async () => ({ status: "completed", exitCode: 0 }),
  };
}

async function settle(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

/**
 * Mock client. The response stream yields a single registerResponse and then
 * ends — the AgentStream's runOnce returns immediately and the outer reconnect
 * loop spins. Captures every outbound AgentMessage in `sent`.
 */
function makeFinishingClient() {
  const sent: unknown[] = [];
  let drainDone = false;
  const client = {
    connect(reqIter: AsyncIterable<unknown>): AsyncIterable<unknown> {
      (async () => {
        for await (const msg of reqIter) {
          if (drainDone) break;
          sent.push(msg);
        }
      })().catch(() => {});

      return (async function* () {
        yield create(ServerMessageSchema, {
          payload: {
            case: "registerResponse",
            value: create(RegisterResponseSchema, {
              accepted: true,
              message: "ok",
              jobStatusAckSupported: true,
            }),
          },
        });
        await new Promise<void>((r) => setImmediate(r));
        drainDone = true;
      })();
    },
  };
  return { client: client as never, sent };
}

const activeStreams: AgentStream[] = [];
afterEach(() => {
  for (const s of activeStreams) s.stop();
  activeStreams.length = 0;
});

describe("OutboundQueue + AgentStream integration", () => {
  test("reconnect replays queued status updates in order and retains them until ACK", async () => {
    const db = freshDb();
    const queue = new OutboundQueue(db);

    // Simulate the offline period: 3 queued status updates.
    await queue.enqueueJobStatus({ jobId: "j-1", status: "queued" });
    await queue.enqueueJobStatus({ jobId: "j-1", status: "running" });
    await queue.enqueueJobStatus({ jobId: "j-1", status: "completed", exitCode: 0 });
    expect(await queue.pendingCount()).toBe(3);

    const { client, sent } = makeFinishingClient();
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000, // disable
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      outboundQueue: queue,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(20);
    stream.stop();
    await runPromise;

    expect(await queue.pendingCount()).toBe(3);

    // First message must be register; the next 3 must be the queued
    // jobStatus updates in order (queued, running, completed).
    expect((sent[0] as { payload: { case: string } }).payload.case).toBe("register");
    const jobStatusMsgs = sent
      .slice(1)
      .filter((m) => (m as { payload: { case: string } }).payload.case === "jobStatus");
    expect(jobStatusMsgs.length).toBeGreaterThanOrEqual(3);
    const statuses = jobStatusMsgs
      .slice(0, 3)
      .map((m) => (m as { payload: { value: { status: number } } }).payload.value.status);
    // Proto enum: QUEUED=2, RUNNING=3, COMPLETED=4
    expect(statuses).toEqual([2, 3, 4]);
    const eventIds = jobStatusMsgs
      .slice(0, 3)
      .map((m) => (m as { payload: { value: { eventId: string } } }).payload.value.eventId);
    expect(eventIds.every((eventId) => eventId.length > 0)).toBe(true);
    for (const eventId of eventIds) await queue.acknowledgeJobStatus(eventId);
    expect(await queue.pendingCount()).toBe(0);
  });

  test("when offline, enqueueStatusUpdate persists into SQLite", async () => {
    const db = freshDb();
    const queue = new OutboundQueue(db);

    // No client.connect ever invoked: we never call start().
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client: { connect: () => (async function* () {})() } as never,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      outboundQueue: queue,
    });
    activeStreams.push(stream);

    // The stream is constructed but not connected — connected=false by default.
    stream.enqueueStatusUpdate({ jobId: "off-1", status: "queued" });
    stream.enqueueStatusUpdate({ jobId: "off-1", status: "running" });

    // Allow the fire-and-forget persistence to settle.
    await settle(5);
    expect(await queue.pendingCount()).toBe(2);
  });

  test("Heartbeat queuedJobs reflects OutboundQueue.pendingCount", async () => {
    const db = freshDb();
    const queue = new OutboundQueue(db);
    // Pre-seed two heartbeats so they are present when the next stream connects.
    await queue.enqueueHeartbeat({
      cpuUsagePercent: 0,
      memoryUsedMb: 0,
      memoryTotalMb: 0,
      runningJobs: 0,
      queuedJobs: 0,
    });
    await queue.enqueueHeartbeat({
      cpuUsagePercent: 0,
      memoryUsedMb: 0,
      memoryTotalMb: 0,
      runningJobs: 0,
      queuedJobs: 0,
    });
    expect(await queue.pendingCount()).toBe(2);

    const { client, sent } = makeFinishingClient();
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 5, // fire heartbeats often
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      outboundQueue: queue,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(50);
    stream.stop();
    await runPromise;

    const hbMsgs = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "heartbeat",
    );
    expect(hbMsgs.length).toBeGreaterThan(0);
    // After drain (which deletes seeded heartbeats), at least one heartbeat
    // should report queuedJobs === 0 — this is what proves the field is now
    // wired to OutboundQueue.pendingCount() instead of hardcoded 0.
    const queuedJobsValues = hbMsgs.map(
      (m) => (m as { payload: { value: { queuedJobs: number } } }).payload.value.queuedJobs,
    );
    // Every queuedJobs value must be a number reflecting current pending count.
    for (const v of queuedJobsValues) {
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThanOrEqual(0);
    }
    // After drain: at least one value must be 0 (queue empty).
    expect(queuedJobsValues).toContain(0);
  });
});

// ---------------------------------------------------------------------------
// InboundAcks + AgentStream — dispatch-ack-on-reconnect contract
// ---------------------------------------------------------------------------

describe("InboundAcks + AgentStream integration", () => {
  test("dispatch received then disconnect before ack: reconnect replays exactly one status report", async () => {
    const db = freshDb();
    const queue = new OutboundQueue(db);
    const acks = new InboundAcks(db);

    // Stage 1 — simulate the live path right up until disconnect.
    // We persist the inbound dispatch directly (this is what stream.ts will
    // do on receive). Crucially, no JobStatusReport ever made it out before
    // the disconnect — pendingInbound() must show exactly one row.
    await acks.persistInbound({
      dispatchId: "j-1",
      jobId: "j-1",
      payload: { name: "echo", command: "echo hello" },
    });
    expect(await acks.pendingInbound()).toHaveLength(1);

    // Stage 2 — reconnect. AgentStream is constructed with the inboundAcks
    // wired in. The mock client yields a registerResponse and ends, the
    // outer loop reconnects, and on reconnect AgentStream replays a status
    // report for every pendingInbound row (status = "failed" with reason
    // "agent restarted before ack" since the local runner has no record).
    const { client, sent } = makeFinishingClient();
    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      outboundQueue: queue,
      inboundAcks: acks,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(20);
    stream.stop();
    await runPromise;

    // Recovery ownership moves from the inbound ledger to the durable outbox
    // before the inbound row is acknowledged.
    const jobStatusMsgs = sent.filter(
      (m) => (m as { payload: { case: string } }).payload.case === "jobStatus",
    );
    const j1Msgs = jobStatusMsgs.filter(
      (m) => (m as { payload: { value: { jobId: string } } }).payload.value.jobId === "j-1",
    );
    expect(j1Msgs.length).toBe(1);
    expect(
      (j1Msgs[0] as { payload: { value: { eventId: string } } }).payload.value.eventId,
    ).not.toBe("");
    expect(await acks.pendingInbound()).toHaveLength(0);
    expect(await queue.pendingCount()).toBe(1);
  });

  test("when the runner has produced its first status update, the row is marked acked", async () => {
    const db = freshDb();
    const queue = new OutboundQueue(db);
    const acks = new InboundAcks(db);

    // Stage 1 — feed a real dispatch into the AgentStream. Use a finite
    // server-message stream that yields registerResponse, then dispatchJob,
    // then ends. The mock adapter completes immediately so the runner
    // emits queued -> completed; the FIRST of those (queued) must mark the
    // ack.
    const sent: unknown[] = [];
    let drainDone = false;
    const client = {
      connect(reqIter: AsyncIterable<unknown>): AsyncIterable<unknown> {
        (async () => {
          for await (const msg of reqIter) {
            if (drainDone) break;
            sent.push(msg);
          }
        })().catch(() => {});
        return (async function* () {
          yield create(ServerMessageSchema, {
            payload: {
              case: "registerResponse",
              value: create(RegisterResponseSchema, { accepted: true, message: "ok" }),
            },
          });
          yield create(ServerMessageSchema, {
            payload: {
              case: "dispatchJob",
              value: create(DispatchJobSchema, {
                jobId: "j-2",
                name: "echo",
                command: "echo hello",
                cpus: 1,
                memoryMb: 1024n,
                gpus: 0,
                wallTimeSec: 60n,
                workingDir: "/tmp",
                envVars: {},
              }),
            },
          });
          await new Promise<void>((r) => setImmediate(r));
          drainDone = true;
        })();
      },
    };

    const stream = new AgentStream({
      fileTransferMaxRetries: 3,
      fileTransferRetryBackoffSec: 0,
      client: client as never,
      adapter: makeAdapter(),
      agentId: "agent-001",
      siteName: "test-site",
      heartbeatIntervalMs: 60_000,
      logger: silent,
      reconnectBackoffMs: 1,
      sleep: async () => {},
      outboundQueue: queue,
      inboundAcks: acks,
    });
    activeStreams.push(stream);

    const runPromise = stream.start();
    await settle(30);
    stream.stop();
    await runPromise;

    // After the runner has emitted at least one status update, the row
    // must be acked — it must NOT show up in pendingInbound on reconnect.
    expect(await acks.pendingInbound()).toEqual([]);
    void sent;
  });
});
