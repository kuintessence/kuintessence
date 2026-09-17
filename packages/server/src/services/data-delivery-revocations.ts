import {
  authzOutbox,
  dataDeliveryRevocations,
  dataGrants,
  jobDataBindings,
  jobs,
  type PgDb,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { dataAssetGrantDeltaTuples, normalizeDataGrantCapabilities } from "../authz/projection";
import type { AuthzTuple } from "../authz/service";
import type { AgentDispatcher } from "../grpc/dispatcher";
import { canonicalAuthorizationSubject } from "./authorization-subjects";

export class DataDeliveryRevocationOutbox {
  constructor(
    private readonly db: PgDb,
    private readonly dispatcher: Pick<AgentDispatcher, "pushDataDeliveryRevoke">,
  ) {}

  async enqueue(input: {
    jobId: string;
    agentId: string;
    reasonCode: string;
    destroyRestrictedWorkRoot: boolean;
    revokedEpoch: number;
  }): Promise<void> {
    await this.db.insert(dataDeliveryRevocations).values(input).onConflictDoNothing();
  }

  async redeliver(agentId: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(dataDeliveryRevocations)
      .where(
        and(
          eq(dataDeliveryRevocations.agentId, agentId),
          isNull(dataDeliveryRevocations.acknowledgedAt),
        ),
      );
    for (const row of rows) {
      this.dispatcher.pushDataDeliveryRevoke(
        row.agentId,
        row.jobId,
        row.reasonCode,
        row.destroyRestrictedWorkRoot,
        row.revokedEpoch,
      );
    }
    return rows.length;
  }

  async acknowledge(agentId: string, jobId: string, reasonCode: string): Promise<void> {
    await this.db
      .update(dataDeliveryRevocations)
      .set({ acknowledgedAt: new Date() })
      .where(
        and(
          eq(dataDeliveryRevocations.agentId, agentId),
          eq(dataDeliveryRevocations.jobId, jobId),
          eq(dataDeliveryRevocations.reasonCode, reasonCode),
          isNull(dataDeliveryRevocations.acknowledgedAt),
        ),
      );
  }
}

export class DataGrantRevocationCoordinator {
  constructor(
    private readonly db: PgDb,
    private readonly outbox: Pick<DataDeliveryRevocationOutbox, "redeliver">,
  ) {}

  async revoke(input: { grantId: string; reason: string }): Promise<{
    grant: {
      id: string;
      assetId: string;
      versionId: string | null;
      subjectKind: "user" | "org";
      subjectId: string;
      capabilities: string[];
      status: "active" | "revoked" | "expired";
      expiresAt: Date | null;
      revokedAt: Date | null;
      reason: string | null;
    };
    capabilityChange: {
      previousCapabilities: string[];
      nextCapabilities: string[];
      outboxEnqueued: boolean;
    };
    idempotent: boolean;
  }> {
    const result = await this.db.transaction(async (tx) => {
      const [grant] = await tx
        .select()
        .from(dataGrants)
        .where(eq(dataGrants.id, input.grantId))
        .for("update")
        .limit(1);
      if (!grant) throw new AppError(ErrorCode.NOT_FOUND, "Data access grant not found", 404);
      if (grant.status === "revoked")
        return {
          grant: mapGrant(grant),
          capabilityChange: {
            previousCapabilities: normalizeDataGrantCapabilities(grant.capabilities),
            nextCapabilities: [],
            outboxEnqueued: true,
          },
          idempotent: true,
          agentIds: [],
        };
      if (grant.status !== "active") {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Data access grant is not active", 409);
      }
      const revokedAt = new Date();
      const [updated] = await tx
        .update(dataGrants)
        .set({ status: "revoked", revokedAt, reason: input.reason })
        .where(eq(dataGrants.id, input.grantId))
        .returning();
      if (!updated)
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Data access grant revocation failed", 500);
      const capabilityChange = {
        previousCapabilities: normalizeDataGrantCapabilities(grant.capabilities),
        nextCapabilities: [],
        outboxEnqueued: true,
      };
      if (updated.dataAssetVersionId === null) {
        await insertAuthzOutbox(
          tx,
          dataAssetGrantDeltaTuples({
            assetId: updated.dataAssetId,
            subjectKind: updated.subjectKind,
            subjectId: updated.subjectId,
            ...capabilityChange,
          }),
        );
      }
      const affected = await tx
        .select({
          jobId: jobs.id,
          agentId: jobs.agentId,
          restrictedNoEgress: jobs.restrictedNoEgress,
          dispatchEpoch: jobs.dispatchEpoch,
          revokedEpoch: jobs.revokedEpoch,
        })
        .from(jobDataBindings)
        .innerJoin(jobs, eq(jobDataBindings.jobId, jobs.id))
        .where(
          and(
            eq(jobDataBindings.source, "data-market"),
            eq(jobDataBindings.assetId, updated.dataAssetId),
            updated.dataAssetVersionId
              ? eq(jobDataBindings.versionId, updated.dataAssetVersionId)
              : undefined,
            sql`${jobDataBindings.authorizationSubjectIds} @> ${JSON.stringify([
              canonicalAuthorizationSubject(updated.subjectKind, updated.subjectId),
            ])}::jsonb`,
            inArray(jobs.status, ["pending", "queued", "running"]),
          ),
        )
        .for("update");
      const jobIds = affected.map((job) => job.jobId);
      const cancelled =
        jobIds.length === 0
          ? []
          : await tx
              .update(jobs)
              .set({
                status: "cancelled",
                completedAt: revokedAt,
                errorMessage: "DATA_DELIVERY_REVOKED:DATA_GRANT_REVOKED",
                revokedEpoch: sql`greatest(${jobs.revokedEpoch}, ${jobs.dispatchEpoch} + 1)`,
              })
              .where(
                and(
                  inArray(jobs.id, jobIds),
                  inArray(jobs.status, ["pending", "queued", "running"]),
                ),
              )
              .returning({
                jobId: jobs.id,
                agentId: jobs.agentId,
                restrictedNoEgress: jobs.restrictedNoEgress,
                revokedEpoch: jobs.revokedEpoch,
              });
      const remote = cancelled.filter((job) => job.agentId !== null);
      if (remote.length > 0) {
        await tx
          .insert(dataDeliveryRevocations)
          .values(
            remote.map((job) => ({
              jobId: job.jobId,
              agentId: job.agentId ?? "",
              reasonCode: "DATA_GRANT_REVOKED",
              destroyRestrictedWorkRoot: job.restrictedNoEgress,
              revokedEpoch: job.revokedEpoch,
            })),
          )
          .onConflictDoNothing();
      }
      return {
        grant: mapGrant(updated),
        capabilityChange,
        idempotent: false,
        agentIds: [...new Set(remote.flatMap((job) => (job.agentId ? [job.agentId] : [])))],
      };
    });
    await Promise.all(result.agentIds.map((agentId) => this.outbox.redeliver(agentId)));
    return {
      grant: result.grant,
      capabilityChange: result.capabilityChange,
      idempotent: result.idempotent,
    };
  }
}

type DbTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

async function insertAuthzOutbox(tx: DbTransaction, tuples: AuthzTuple[]): Promise<void> {
  if (tuples.length === 0) return;
  await tx.insert(authzOutbox).values(
    tuples.map((tuple) => ({
      operation: tuple.operation,
      resourceType: tuple.resource.type,
      resourceId: tuple.resource.id,
      relation: tuple.relation,
      subjectType: tuple.subject.type,
      subjectId: tuple.subject.id,
      subjectRelation: tuple.subject.relation ?? null,
      payload: tuple.payload ?? {},
    })),
  );
}

function mapGrant(row: typeof dataGrants.$inferSelect): {
  id: string;
  assetId: string;
  versionId: string | null;
  subjectKind: "user" | "org";
  subjectId: string;
  capabilities: string[];
  status: "active" | "revoked" | "expired";
  expiresAt: Date | null;
  revokedAt: Date | null;
  reason: string | null;
} {
  const subjectKind = row.subjectKind;
  if (subjectKind !== "user" && subjectKind !== "org") {
    throw new Error("Data grant subject kind is unsupported for entitlement revocation");
  }
  return {
    id: row.id,
    assetId: row.dataAssetId,
    versionId: row.dataAssetVersionId,
    subjectKind: subjectKind as "user" | "org",
    subjectId: row.subjectId,
    capabilities: row.capabilities,
    status: row.status as "active" | "revoked" | "expired",
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    reason: row.reason,
  };
}
