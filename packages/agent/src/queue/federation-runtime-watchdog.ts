import type { SqliteDb } from "@kuintessence/db";
import type { Logger } from "pino";
import { z } from "zod";
import { cancelAndConfirmStopped, type SchedulerAdapter } from "../adapters/base";
import { ActiveRemoteJobs, jsonToPreparedRemoteJob } from "./active-remote-jobs";
import { FederationDispatchReceiptSchema, federationSchedulerName } from "./federation-dispatch";
import { InboundAcks } from "./inbound-acks";
import { JobRevocationTombstones } from "./job-cleanup-intents";

const RuntimeSchema = z.object({
  owner: z.string().min(1),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["active", "stopping", "finished"]),
});

/** A separately supervised process; it never grants authority, submits work or removes input. */
export class FederationRuntimeWatchdog {
  private readonly inbox: InboundAcks;
  private readonly active: ActiveRemoteJobs;
  private readonly tombstones: JobRevocationTombstones;
  private readonly deadlines = new Map<string, { expiresAt: number; monotonic: number }>();

  constructor(
    db: SqliteDb,
    private readonly adapter: SchedulerAdapter,
    private readonly logger: Logger,
    private readonly clock = { now: () => Date.now(), monotonic: () => performance.now() },
  ) {
    this.inbox = new InboundAcks(db);
    this.active = new ActiveRemoteJobs(db);
    this.tombstones = new JobRevocationTombstones(db);
  }

  async tick(): Promise<void> {
    const rows = await this.inbox.runtimeStopCandidates();
    const remaining = new Set(rows.map((row) => row.dispatchId));
    for (const id of this.deadlines.keys()) if (!remaining.has(id)) this.deadlines.delete(id);
    for (const row of rows) {
      try {
        const receipt = FederationDispatchReceiptSchema.parse(row.payload.federationReceipt);
        if (row.dispatchId !== `${row.jobId}:${receipt.epoch}`)
          throw new Error("Federation watchdog receipt identity is invalid");
        const prepared = jsonToPreparedRemoteJob(row.payload.federationSubmission);
        if (
          prepared.spec.jobId !== row.jobId ||
          prepared.spec.schedulerName !== federationSchedulerName(BigInt(receipt.epoch))
        )
          throw new Error("Federation watchdog prepared job identity is invalid");
        const runtime = RuntimeSchema.safeParse(row.payload.federationRuntime);
        const now = this.clock.now();
        const monotonic = this.clock.monotonic();
        if (runtime.success && runtime.data.state === "active") {
          const old = this.deadlines.get(row.dispatchId);
          // An unchanged lease cannot gain time from wall-clock rollback.
          if (!old || runtime.data.expiresAt !== old.expiresAt)
            this.deadlines.set(row.dispatchId, {
              expiresAt: runtime.data.expiresAt,
              monotonic: monotonic + Math.min(30_000, Math.max(0, runtime.data.expiresAt - now)),
            });
          const deadline = this.deadlines.get(row.dispatchId);
          const revoked = await this.tombstones.revokedEpoch(row.jobId);
          if (
            runtime.data.expiresAt > now &&
            runtime.data.expiresAt <= now + 30_000 &&
            deadline &&
            monotonic < deadline.monotonic &&
            (revoked === undefined || revoked < receipt.epoch)
          )
            continue;
        }
        if ((await this.inbox.latestForJob(row.jobId))?.dispatchId !== row.dispatchId)
          throw new Error("A later dispatch prevents watchdog recovery of this submission");
        if (!(await this.inbox.fenceRuntimeStop(row))) continue;
        await this.tombstones.record(row.jobId, receipt.epoch);
        const active = (await this.active.listActive()).find((job) => job.jobId === row.jobId);
        if (active && active.dispatchId !== row.dispatchId)
          throw new Error("Federation watchdog found a different active dispatch");
        const identity = prepared.spec.sandbox?.identity;
        const lookup = {
          jobId: row.jobId,
          schedulerName: prepared.spec.schedulerName,
          schedulerAccount: identity?.backend === "Unix" ? identity.schedulerAccount : undefined,
          namespace: identity?.backend === "Kubernetes" ? identity.namespace : undefined,
          submittedAfterUnixMs: row.receivedAt.getTime(),
        };
        const found = await this.adapter.findByKuintessenceJobId?.(lookup);
        if (found?.status !== "found")
          throw new Error("Federation watchdog cannot establish scheduler submission identity");
        if (active && active.schedulerJobId !== found.schedulerJobId)
          throw new Error("Federation watchdog scheduler identity changed");
        await this.adapter.prepareResume?.(prepared.spec, found.schedulerJobId);
        await cancelAndConfirmStopped(this.adapter, found.schedulerJobId, lookup);
        await this.inbox.recordRuntimeStop(row.dispatchId, found.schedulerJobId);
        this.logger.info(
          { jobId: row.jobId, dispatchEpoch: receipt.epoch },
          "Federation watchdog confirmed scheduler stop",
        );
      } catch (err) {
        this.logger.warn({ err, jobId: row.jobId }, "Federation watchdog stop remains pending");
      }
    }
    await this.inbox.recordWatchdogHeartbeat(this.adapter.type);
  }
}
