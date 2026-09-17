// Metering composition root.
//
// Centralises Server-side construction of the metering subsystem so the
// `index.ts` bootstrap, the tests, and any future CLI/cron entry point
// can build a fully wired `MeteringService` (and aggregator) from a
// single call. The subsystem currently has three moving parts:
//
//   1. The {@link MeteringRepository} — Drizzle-backed in production,
//      in-memory under tests.
//   2. The {@link MeteringService} that the route layer talks to for
//      `recordJobCompletion` and `query`.
//   3. The {@link MeteringAggregator} that runs the rollup pipeline
//      raw → hourly → daily → monthly. The aggregator shares the same
//      repository instance so reads from a route see writes from the
//      cron immediately.
//
// The bootstrap wires this in once and re-uses the returned bundle.
// Splitting the wiring out of `index.ts` keeps the entry-point file
// short and gives tests a single seam to construct identical services
// without repeating constructors.

import type { PgDb } from "@kuintessence/db";
import { type MeteringRepository, MeteringService } from "./metering";
import { MeteringAggregator } from "./metering-aggregator";
import { makeMeteringRepository } from "./metering-repository-drizzle.factory";

export interface MeteringBindingOptions {
  /** Pass the live PG handle to use the Drizzle adapter. Omit for in-memory. */
  db?: PgDb;
  /**
   * Override the clock — used by deterministic unit tests; the rest of
   * the codebase should leave it as the default `() => new Date()`.
   */
  now?: () => Date;
  /** Aggregator retention overrides (days). See {@link MeteringAggregator}. */
  retentionRawDays?: number;
  retentionHourlyDays?: number;
  retentionDailyDays?: number;
}

export interface MeteringBundle {
  repository: MeteringRepository;
  service: MeteringService;
  aggregator: MeteringAggregator;
}

export function createMeteringBundle(opts: MeteringBindingOptions = {}): MeteringBundle {
  const repository = makeMeteringRepository({ db: opts.db });
  const serviceOpts: ConstructorParameters<typeof MeteringService>[0] = { repo: repository };
  if (opts.now) serviceOpts.now = opts.now;
  const service = new MeteringService(serviceOpts);
  const aggregatorOpts: ConstructorParameters<typeof MeteringAggregator>[0] = { repo: repository };
  if (opts.now) aggregatorOpts.now = opts.now;
  if (opts.retentionRawDays !== undefined) aggregatorOpts.retentionRawDays = opts.retentionRawDays;
  if (opts.retentionHourlyDays !== undefined) {
    aggregatorOpts.retentionHourlyDays = opts.retentionHourlyDays;
  }
  if (opts.retentionDailyDays !== undefined) {
    aggregatorOpts.retentionDailyDays = opts.retentionDailyDays;
  }
  const aggregator = new MeteringAggregator(aggregatorOpts);
  return { repository, service, aggregator };
}
