import { jobCleanupIntents, jobRevocationTombstones, type SqliteDb } from "@kuintessence/db";
import { asc, eq, sql } from "drizzle-orm";

export interface DataDeliveryCleanupIntent {
  bindingId: string;
  targetPath: string;
  method: "object-download" | "stage-copy" | "readonly-mount";
}

export interface LicensedMaterialCleanupIntent {
  selectorId: string;
  targetPath: string;
}

export interface JobCleanupIntent {
  jobId: string;
  dataDeliveries: DataDeliveryCleanupIntent[];
  licensedMounts: LicensedMaterialCleanupIntent[];
  schedulerJobId?: string;
  schedulerSubmissionTag?: string;
  schedulerAccount?: string;
  schedulerNamespace?: string;
  restrictedWorkRoot: boolean;
  revoked: boolean;
  revokeReason?: string;
}

export class JobCleanupIntents {
  constructor(private readonly db: SqliteDb) {}

  async recordDataDelivery(jobId: string, delivery: DataDeliveryCleanupIntent): Promise<void> {
    await this.mutate(jobId, (current) => ({
      ...current,
      dataDeliveries: appendUnique(
        current.dataDeliveries,
        delivery,
        (item) => `${item.bindingId}:${item.targetPath}:${item.method}`,
      ),
    }));
  }

  async recordLicensedMount(jobId: string, mount: LicensedMaterialCleanupIntent): Promise<void> {
    await this.mutate(jobId, (current) => ({
      ...current,
      licensedMounts: appendUnique(
        current.licensedMounts,
        mount,
        (item) => `${item.selectorId}:${item.targetPath}`,
      ),
    }));
  }

  async list(): Promise<JobCleanupIntent[]> {
    const rows = await this.db
      .select()
      .from(jobCleanupIntents)
      .orderBy(asc(jobCleanupIntents.createdAt), asc(jobCleanupIntents.jobId));
    return rows.map((row) => ({
      jobId: row.jobId,
      dataDeliveries: jsonToDataDeliveries(row.dataDeliveries),
      licensedMounts: jsonToLicensedMounts(row.licensedMounts),
      schedulerJobId: row.schedulerJobId ?? undefined,
      schedulerSubmissionTag: row.schedulerSubmissionTag ?? undefined,
      schedulerAccount: row.schedulerAccount ?? undefined,
      schedulerNamespace: row.schedulerNamespace ?? undefined,
      restrictedWorkRoot: row.restrictedWorkRoot,
      revoked: row.revoked,
      revokeReason: row.revokeReason ?? undefined,
    }));
  }

  async clear(jobId: string): Promise<void> {
    await this.db.delete(jobCleanupIntents).where(eq(jobCleanupIntents.jobId, jobId));
  }

  async recordSchedulerSubmitted(jobId: string, schedulerJobId: string): Promise<void> {
    await this.mutate(jobId, (current) => ({
      ...current,
      schedulerJobId: current.schedulerJobId ?? schedulerJobId,
    }));
  }

  async recordSchedulerSubmitting(
    jobId: string,
    lookup: { schedulerName: string; schedulerAccount?: string; schedulerNamespace?: string },
  ): Promise<void> {
    await this.mutate(jobId, (current) => ({
      ...current,
      schedulerSubmissionTag: current.schedulerSubmissionTag ?? lookup.schedulerName,
      schedulerAccount: current.schedulerAccount ?? lookup.schedulerAccount,
      schedulerNamespace: current.schedulerNamespace ?? lookup.schedulerNamespace,
    }));
  }

  async recordRestrictedWorkRoot(jobId: string): Promise<void> {
    await this.mutate(jobId, (current) => ({ ...current, restrictedWorkRoot: true }));
  }

  async recordRevoked(
    jobId: string,
    input: { reason: string; destroyRestrictedWorkRoot: boolean },
  ): Promise<void> {
    await this.mutate(jobId, (current) => ({
      ...current,
      restrictedWorkRoot: current.restrictedWorkRoot || input.destroyRestrictedWorkRoot,
      revoked: true,
      revokeReason: current.revokeReason ?? input.reason,
    }));
  }

  private async get(
    jobId: string,
    db: Pick<SqliteDb, "select"> = this.db,
  ): Promise<JobCleanupIntent | undefined> {
    const row = await db
      .select()
      .from(jobCleanupIntents)
      .where(eq(jobCleanupIntents.jobId, jobId))
      .get();
    if (!row) return undefined;
    return {
      jobId: row.jobId,
      dataDeliveries: jsonToDataDeliveries(row.dataDeliveries),
      licensedMounts: jsonToLicensedMounts(row.licensedMounts),
      schedulerJobId: row.schedulerJobId ?? undefined,
      schedulerSubmissionTag: row.schedulerSubmissionTag ?? undefined,
      schedulerAccount: row.schedulerAccount ?? undefined,
      schedulerNamespace: row.schedulerNamespace ?? undefined,
      restrictedWorkRoot: row.restrictedWorkRoot,
      revoked: row.revoked,
      revokeReason: row.revokeReason ?? undefined,
    };
  }

  private async mutate(
    jobId: string,
    update: (current: JobCleanupIntent) => JobCleanupIntent,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = (await this.get(jobId, tx)) ?? {
        jobId,
        dataDeliveries: [],
        licensedMounts: [],
        restrictedWorkRoot: false,
        revoked: false,
      };
      const next = update(current);
      await this.save(tx, next);
    });
  }

  private async save(db: Pick<SqliteDb, "insert">, intent: JobCleanupIntent): Promise<void> {
    const now = new Date();
    await db
      .insert(jobCleanupIntents)
      .values({
        jobId: intent.jobId,
        dataDeliveries: intent.dataDeliveries.map((delivery) => ({
          bindingId: delivery.bindingId,
          targetPath: delivery.targetPath,
          method: delivery.method,
        })),
        schedulerJobId: intent.schedulerJobId,
        schedulerSubmissionTag: intent.schedulerSubmissionTag,
        schedulerAccount: intent.schedulerAccount,
        schedulerNamespace: intent.schedulerNamespace,
        restrictedWorkRoot: intent.restrictedWorkRoot,
        revoked: intent.revoked,
        revokeReason: intent.revokeReason,
        licensedMounts: intent.licensedMounts.map((mount) => ({
          selectorId: mount.selectorId,
          targetPath: mount.targetPath,
        })),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: jobCleanupIntents.jobId,
        set: {
          dataDeliveries: intent.dataDeliveries.map((delivery) => ({
            bindingId: delivery.bindingId,
            targetPath: delivery.targetPath,
            method: delivery.method,
          })),
          licensedMounts: intent.licensedMounts.map((mount) => ({
            selectorId: mount.selectorId,
            targetPath: mount.targetPath,
          })),
          schedulerJobId: intent.schedulerJobId,
          schedulerSubmissionTag: intent.schedulerSubmissionTag,
          schedulerAccount: intent.schedulerAccount,
          schedulerNamespace: intent.schedulerNamespace,
          restrictedWorkRoot: intent.restrictedWorkRoot,
          revoked: intent.revoked,
          revokeReason: intent.revokeReason,
          updatedAt: now,
        },
      });
  }
}

export class JobRevocationTombstones {
  constructor(private readonly db: SqliteDb) {}

  async record(jobId: string, revokedEpoch: number): Promise<void> {
    const now = new Date();
    await this.db
      .insert(jobRevocationTombstones)
      .values({ jobId, revokedEpoch, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: jobRevocationTombstones.jobId,
        set: {
          revokedEpoch: sql`max(${jobRevocationTombstones.revokedEpoch}, ${revokedEpoch})`,
          updatedAt: now,
        },
      });
  }

  async revokedEpoch(jobId: string): Promise<number | undefined> {
    const row = await this.db
      .select({ revokedEpoch: jobRevocationTombstones.revokedEpoch })
      .from(jobRevocationTombstones)
      .where(eq(jobRevocationTombstones.jobId, jobId))
      .get();
    return row?.revokedEpoch;
  }
}

function appendUnique<T>(items: readonly T[], item: T, key: (value: T) => string): T[] {
  return items.some((existing) => key(existing) === key(item)) ? [...items] : [...items, item];
}

function jsonToDataDeliveries(value: Record<string, unknown>[]): DataDeliveryCleanupIntent[] {
  return value.map((entry) => {
    const method = requireString(entry.method, "data delivery method");
    if (method !== "object-download" && method !== "stage-copy" && method !== "readonly-mount") {
      throw new Error("job cleanup intent has invalid data delivery method");
    }
    return {
      bindingId: requireString(entry.bindingId, "data delivery bindingId"),
      targetPath: requireString(entry.targetPath, "data delivery targetPath"),
      method,
    };
  });
}

function jsonToLicensedMounts(value: Record<string, unknown>[]): LicensedMaterialCleanupIntent[] {
  return value.map((entry) => ({
    selectorId: requireString(entry.selectorId, "licensed mount selectorId"),
    targetPath: requireString(entry.targetPath, "licensed mount targetPath"),
  }));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`job cleanup intent ${field} must be a string`);
  return value;
}
