import { expect, test } from "bun:test";
import { createSqliteDb } from "@kuintessence/db";
import type { AgentMessage } from "@kuintessence/proto";
import pino from "pino";
import type { JobSpec, SchedulerAdapter } from "./adapters/base";
import { ActiveRemoteJobs } from "./queue/active-remote-jobs";
import { InboundAcks } from "./queue/inbound-acks";
import { OutboundQueue } from "./queue/outbound-queue";
import { AgentStream, type AgentStreamDeps } from "./stream";

test.each([
  false,
  true,
])("known scheduler job retains unacked receipt when resume fails (durable outbound=%s)", async (durableOutbound) => {
  const db = createSqliteDb(":memory:");
  const records = new ActiveRemoteJobs(db);
  const inbound = new InboundAcks(db);
  const spec: JobSpec = {
    jobId: "known-but-unadopted",
    name: "fixture",
    command: "true",
    cpus: 1,
    memoryMb: 64,
    gpus: 0,
    wallTimeSec: 60,
    workingDir: "/shared/fixture",
    envVars: {},
  };
  await records.recordSubmitted({ spec, schedulerJobId: "123", expectedOutputs: [] });
  await inbound.persistInbound({
    dispatchId: "known-but-unadopted:1",
    jobId: spec.jobId,
    payload: {},
  });
  const adapter: SchedulerAdapter = {
    type: "slurm",
    version: "fixture",
    submit: async () => {
      throw new Error("must never resubmit");
    },
    cancel: async () => {
      throw new Error("must never cancel");
    },
    status: async () => ({ status: "queued" }),
    prepareResume: async () => {
      throw new Error("temporary scheduler transport failure");
    },
  };
  const stream = new AgentStream({
    // This test drives the outbound generator without opening a transport.
    client: {} as AgentStreamDeps["client"],
    adapter,
    agentId: "agent",
    siteName: "fixture",
    heartbeatIntervalMs: 60_000,
    logger: pino({ level: "silent" }),
    activeRemoteJobs: records,
    inboundAcks: inbound,
    ...(durableOutbound ? { outboundQueue: new OutboundQueue(db) } : {}),
  });
  const internals = stream as unknown as {
    recoverActiveRemoteJobs(): Promise<void>;
    pool: { await(jobId: string): Promise<void>; get(jobId: string): unknown };
    generateOutbound(
      registration: Promise<boolean>,
      attempt: AbortController,
    ): AsyncGenerator<AgentMessage>;
  };
  try {
    await internals.recoverActiveRemoteJobs();
    await internals.pool.await(spec.jobId);
    expect(internals.pool.get(spec.jobId)).toBeUndefined();
    const iterator = internals.generateOutbound(Promise.resolve(true), new AbortController());
    expect((await iterator.next()).value?.payload.case).toBe("register");
    const pending = iterator.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await stream.stop();
    expect((await pending).done).toBe(true);
    expect(await inbound.pendingInbound()).toHaveLength(1);
    expect((await records.listActive())[0]?.schedulerJobId).toBe("123");
  } finally {
    await stream.stop();
  }
});

test.each([
  { dispatchEpoch: undefined, epochs: [1], expectedPending: [] },
  { dispatchEpoch: 1, epochs: [1, 2], expectedPending: [2] },
  { dispatchEpoch: undefined, epochs: [1, 2], expectedPending: [1, 2] },
])("a resumed PBS job durably reports completion and acknowledges only its epoch: %j", async ({
  dispatchEpoch,
  epochs,
  expectedPending,
}) => {
  const db = createSqliteDb(":memory:");
  const records = new ActiveRemoteJobs(db);
  const inbound = new InboundAcks(db);
  const outbound = new OutboundQueue(db);
  const spec: JobSpec = {
    jobId: "resumed-queued",
    name: "fixture",
    command: "true",
    cpus: 1,
    memoryMb: 64,
    gpus: 0,
    wallTimeSec: 60,
    workingDir: "/shared/fixture",
    envVars: {},
  };
  await records.recordSubmitted({
    spec,
    schedulerJobId: "123",
    expectedOutputs: [],
    dispatchId: dispatchEpoch === undefined ? undefined : `${spec.jobId}:${dispatchEpoch}`,
  });
  for (const epoch of epochs)
    await inbound.persistInbound({
      dispatchId: `${spec.jobId}:${epoch}`,
      jobId: spec.jobId,
      payload: {},
    });
  let polls = 0;
  const accounting = {
    version: 1 as const,
    source: "pbs-qstat" as const,
    schedulerJobId: "123",
    observedAt: "2026-11-13T00:00:00.000Z",
    cpuTimeMilliseconds: "1000",
  };
  const adapter: SchedulerAdapter = {
    type: "pbs-pro",
    version: "fixture",
    submit: async () => {
      throw new Error("must not resubmit");
    },
    cancel: async () => {},
    status: async () =>
      ++polls === 1 ? { status: "queued" } : { status: "completed", exitCode: 0, accounting },
  };
  const stream = new AgentStream({
    client: {} as AgentStreamDeps["client"],
    adapter,
    agentId: "agent",
    siteName: "fixture",
    heartbeatIntervalMs: 60000,
    jobPollIntervalMs: 1,
    logger: pino({ level: "silent" }),
    activeRemoteJobs: records,
    inboundAcks: inbound,
    outboundQueue: outbound,
  });
  const internals = stream as unknown as {
    recoverActiveRemoteJobs(): Promise<void>;
    pool: { await(jobId: string): Promise<void> };
  };
  try {
    await internals.recoverActiveRemoteJobs();
    await internals.pool.await(spec.jobId);
    const reports = (await outbound.loadForReplay()).flatMap(({ item }) =>
      item.kind === "jobStatus" ? [item.report] : [],
    );
    expect(reports.map((report) => report.status)).toEqual(["queued", "completed"]);
    expect(reports[0]?.schedulerJobId).toBe("123");
    expect(reports.at(-1)?.accounting).toEqual(accounting);
    expect(reports.every((report) => report.workingDir === spec.workingDir)).toBe(true);
    expect((await inbound.pendingInbound()).map((receipt) => receipt.dispatchId)).toEqual(
      expectedPending.map((epoch) => `${spec.jobId}:${epoch}`),
    );
    expect(await records.listActive()).toEqual([]);
  } finally {
    await stream.stop();
  }
});
