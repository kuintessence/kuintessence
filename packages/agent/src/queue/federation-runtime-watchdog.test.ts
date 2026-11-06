import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createSqliteDb } from "@kuintessence/db";
import { DispatchJobSchema } from "@kuintessence/proto";
import pino from "pino";
import type { JobSpec, SchedulerAdapter } from "../adapters/base";
import { ActiveRemoteJobs } from "./active-remote-jobs";
import { federationDispatchReceipt, federationSchedulerName } from "./federation-dispatch";
import { FederationRuntimeWatchdog } from "./federation-runtime-watchdog";
import { InboundAcks } from "./inbound-acks";
import { JobRevocationTombstones } from "./job-cleanup-intents";

async function fixture(kubernetes = false) {
  const db = createSqliteDb(":memory:");
  let now = Date.now();
  let monotonic = 0;
  const inbox = new InboundAcks(db, { now: () => new Date(now) });
  const active = new ActiveRemoteJobs(db);
  const tombstones = new JobRevocationTombstones(db);
  const dispatch = create(DispatchJobSchema, {
    jobId: crypto.randomUUID(),
    dispatchEpoch: 5n,
    federationExecution: true,
  });
  const dispatchId = `${dispatch.jobId}:5`;
  const spec: JobSpec = {
    jobId: dispatch.jobId,
    name: "original",
    command: "sleep 60",
    cpus: 1,
    memoryMb: 128,
    gpus: 0,
    wallTimeSec: 60,
    workingDir: "/tmp",
    envVars: {},
    schedulerName: federationSchedulerName(5n),
    ...(kubernetes ? { federationDispatchEpoch: 5, queueName: "tenant-ns" } : {}),
  };
  await inbox.persistInbound({
    dispatchId,
    jobId: dispatch.jobId,
    payload: { federationExecution: true, federationReceipt: federationDispatchReceipt(dispatch) },
  });
  await inbox.markSubmissionStarted(
    dispatchId,
    { spec, expectedOutputs: [] },
    { owner: "agent", expiresAt: now + 1000, state: "active" },
  );
  await inbox.markAcked(dispatchId);
  await active.recordSubmitted({
    dispatchId,
    spec,
    expectedOutputs: [],
    schedulerJobId: "scheduler-original",
  });
  const cancelled: string[] = [];
  let stopped = true;
  let available = true;
  const adapter: SchedulerAdapter = {
    type: kubernetes ? "kubernetes" : "slurm",
    version: "test",
    submit: async () => {
      throw new Error("watchdog cannot submit");
    },
    cancel: async (id) => {
      cancelled.push(id);
    },
    confirmStopped: async () => stopped,
    status: async () => ({ status: "running" }),
    findByKuintessenceJobId: async (lookup) => {
      expect(lookup.jobId).toBe(dispatch.jobId);
      expect(lookup.schedulerName).toBe(spec.schedulerName);
      return available
        ? { status: "found", schedulerJobId: "scheduler-original" }
        : { status: "indeterminate", reason: "offline" };
    },
  };
  const watchdog = () =>
    new FederationRuntimeWatchdog(db, adapter, pino({ level: "silent" }), {
      now: () => now,
      monotonic: () => monotonic,
    });
  return {
    db,
    inbox,
    active,
    tombstones,
    dispatch,
    dispatchId,
    spec,
    adapter,
    cancelled,
    watchdog,
    advance: (ms: number) => {
      now += ms;
      monotonic += ms;
    },
    rollback: (ms: number) => {
      now -= ms;
    },
    now: () => now,
    stopped: (value: boolean) => {
      stopped = value;
    },
    available: (value: boolean) => {
      available = value;
    },
  };
}

describe("independent federation watchdog", () => {
  test("stops expired acknowledged work, fences renewals and keeps inputs for Agent recovery", async () => {
    const f = await fixture();
    const watchdog = f.watchdog();
    await watchdog.tick();
    expect(f.cancelled).toEqual([]);
    f.advance(1001);
    await watchdog.tick();
    expect(f.cancelled).toEqual(["scheduler-original"]);
    expect(await f.tombstones.revokedEpoch(f.dispatch.jobId)).toBe(5);
    await expect(f.inbox.renewRuntime(f.dispatchId, "agent", f.now() + 1000)).rejects.toThrow(
      "expired",
    );
    expect(await f.active.listActive()).toHaveLength(1);
    expect((await f.inbox.get(f.dispatchId))?.payload.federationRuntimeStop).toMatchObject({
      schedulerJobId: "scheduler-original",
    });
    await f.watchdog().tick();
    expect(f.cancelled).toHaveLength(1);
  });

  test("atomic stop cannot overwrite a renewal that won the race", async () => {
    const f = await fixture();
    const observed = await f.inbox.get(f.dispatchId);
    if (!observed) throw new Error("missing receipt");
    await f.inbox.renewRuntime(f.dispatchId, "agent", f.now() + 2000);
    expect(await f.inbox.fenceRuntimeStop(observed)).toBe(false);
    f.advance(1001);
    await f.watchdog().tick();
    expect(f.cancelled).toEqual([]);
  });

  test("observes persisted timely renewals even when a prior scheduler query delayed a scan", async () => {
    const f = await fixture();
    const watchdog = f.watchdog();
    await watchdog.tick();
    f.advance(700);
    await f.inbox.renewRuntime(f.dispatchId, "agent", f.now() + 1000);
    f.advance(500);
    await watchdog.tick();
    expect(f.cancelled).toEqual([]);
  });

  test("wall-clock rollback cannot extend an unchanged observed permit", async () => {
    const f = await fixture();
    const watchdog = f.watchdog();
    await watchdog.tick();
    f.advance(1001);
    f.rollback(1500);
    await watchdog.tick();
    expect(f.cancelled).toHaveLength(1);
  });

  test("scheduler outage and incomplete stop proof survive watchdog recreation", async () => {
    const f = await fixture();
    f.advance(1001);
    f.available(false);
    await f.watchdog().tick();
    expect(f.cancelled).toEqual([]);
    expect((await f.inbox.get(f.dispatchId))?.payload.federationRuntime).toMatchObject({
      state: "stopping",
    });
    f.available(true);
    f.stopped(false);
    await f.watchdog().tick();
    expect((await f.inbox.get(f.dispatchId))?.payload.federationRuntimeStop).toBeUndefined();
    f.stopped(true);
    await f.watchdog().tick();
    expect(f.cancelled).toHaveLength(2);
    expect((await f.inbox.get(f.dispatchId))?.payload.federationRuntimeStop).toBeDefined();
  });

  test("tombstone cancels before permit expiry", async () => {
    const f = await fixture();
    await f.tombstones.record(f.dispatch.jobId, 5);
    await f.watchdog().tick();
    expect(f.cancelled).toHaveLength(1);
  });

  test("a different dispatch or scheduler identity is never cancelled", async () => {
    const f = await fixture();
    f.advance(1001);
    await f.active.recordSubmitted({
      dispatchId: `${f.dispatch.jobId}:6`,
      spec: f.spec,
      expectedOutputs: [],
      schedulerJobId: "new-scheduler",
    });
    await f.watchdog().tick();
    expect(f.cancelled).toEqual([]);
    expect((await f.inbox.get(f.dispatchId))?.payload.federationRuntimeStop).toBeUndefined();
  });

  test("a lost submit response is found by original UUID and epoch without resubmission", async () => {
    const f = await fixture();
    await f.active.markFinished(f.dispatch.jobId);
    f.advance(1001);
    await f.watchdog().tick();
    expect(f.cancelled).toEqual(["scheduler-original"]);
  });

  test("Agent requires a fresh watchdog heartbeat for its scheduler", async () => {
    const f = await fixture();
    await expect(f.inbox.assertWatchdogReady("slurm")).rejects.toThrow("unavailable");
    await f.inbox.recordWatchdogHeartbeat("slurm");
    await f.inbox.assertWatchdogReady("slurm");
    await expect(f.inbox.assertWatchdogReady("pbs-pro")).rejects.toThrow("unavailable");
    f.advance(2001);
    await expect(f.inbox.assertWatchdogReady("slurm")).rejects.toThrow("unavailable");
  });
});

test("Kubernetes watchdog reopens the immutable UID even after the Job disappears", async () => {
  const f = await fixture(true);
  const schedulerUid = crypto.randomUUID();
  await f.inbox.bindRuntimeSchedulerIdentity(f.dispatchId, {
    schedulerUid,
    schedulerJobId: "scheduler-original",
    namespace: "tenant-ns",
  });
  await f.active.markFinished(f.spec.jobId);
  f.adapter.findByKuintessenceJobId = async () => {
    throw new Error("must not rediscover a deleted Job");
  };
  f.adapter.cancel = async (id, lookup) => {
    expect(id).toBe("scheduler-original");
    expect(lookup).toMatchObject({
      schedulerUid,
      namespace: "tenant-ns",
      federationDispatchEpoch: 5,
    });
    f.cancelled.push(id);
  };
  f.advance(1001);
  f.stopped(false);
  await f.watchdog().tick();
  expect(
    await f.inbox.hasConfirmedRuntimeStop(f.dispatchId, "scheduler-original", schedulerUid),
  ).toBe(false);
  f.stopped(true);
  await f.watchdog().tick();
  expect(f.cancelled).toHaveLength(2);
  expect(
    await f.inbox.hasConfirmedRuntimeStop(f.dispatchId, "scheduler-original", schedulerUid),
  ).toBe(true);
});

test("Kubernetes recovery binds a lost response UID and persists it with the active record", async () => {
  const f = await fixture(true);
  const schedulerUid = crypto.randomUUID();
  f.adapter.findByKuintessenceJobId = async () => ({
    status: "found",
    schedulerJobId: "scheduler-original",
    schedulerUid,
  });
  f.advance(1001);
  await f.watchdog().tick();
  expect(await f.inbox.runtimeSchedulerIdentity(f.dispatchId)).toMatchObject({
    schedulerUid,
    namespace: "tenant-ns",
  });
  await f.active.recordSubmitted({
    spec: f.spec,
    expectedOutputs: [],
    dispatchId: f.dispatchId,
    schedulerJobId: "scheduler-original",
    schedulerUid,
  });
  expect((await new ActiveRemoteJobs(f.db).listActive())[0]).toMatchObject({
    schedulerUid,
    spec: { federationDispatchEpoch: 5 },
  });
});

test("conflicting persisted Kubernetes UIDs cannot cancel or record a stop", async () => {
  const f = await fixture(true);
  await f.inbox.bindRuntimeSchedulerIdentity(f.dispatchId, {
    schedulerUid: crypto.randomUUID(),
    schedulerJobId: "scheduler-original",
    namespace: "tenant-ns",
  });
  await f.active.recordSubmitted({
    spec: f.spec,
    expectedOutputs: [],
    dispatchId: f.dispatchId,
    schedulerJobId: "scheduler-original",
    schedulerUid: crypto.randomUUID(),
  });
  f.advance(1001);
  await f.watchdog().tick();
  expect(f.cancelled).toEqual([]);
  expect((await f.inbox.get(f.dispatchId))?.payload.federationRuntimeStop).toBeUndefined();
});
