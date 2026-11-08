import {
  auditLog,
  dataAccessPolicies,
  dataAssetVersions,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { DataMarketActor } from "./data-market";
import { readDataVersionCustody } from "./data-version-custody";

export const DataDisclosurePolicyInputSchema = z.strictObject({
  expectedUpdatedAt: z.iso.datetime().nullable(),
  enabled: z.boolean(),
  expiresAt: z.iso.datetime(),
  reason: z.string().trim().min(1).max(500),
});

type Policy = typeof dataAccessPolicies.$inferSelect;

/** Version-scoped disclosure consent; it grants no local download or execution permission. */
export class DataDisclosurePolicyService {
  constructor(
    private readonly db: PgDb,
    private readonly authorizeManage: (actor: DataMarketActor, assetId: string) => Promise<void>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async read(actor: DataMarketActor, versionId: string) {
    await this.authorize(actor, versionId);
    return this.db.transaction(async (tx) => {
      const data = await this.scope(tx, actor, versionId, false);
      const policies = await this.policies(tx, actor, data.asset.id, versionId);
      const policy = (await this.localPolicy(tx, actor, versionId)) ?? null;
      return {
        policy,
        editable: !policy || editable(policy),
        canApprove:
          data.asset.lifecycle === "published" &&
          data.version.status === "ready" &&
          !!data.version.immutableAt,
        otherPolicies: policies.filter((p) => p.id !== policy?.id).slice(0, 100),
        hasMorePolicies: policies.length > 100,
      };
    });
  }

  async write(actor: DataMarketActor, versionId: string, raw: unknown) {
    const input = DataDisclosurePolicyInputSchema.parse(raw);
    await this.authorize(actor, versionId);
    return this.db.transaction(async (tx) => {
      const data = await this.scope(tx, actor, versionId, true);
      const now = this.clock();
      if (
        input.enabled &&
        (data.asset.lifecycle !== "published" ||
          data.version.status !== "ready" ||
          !data.version.immutableAt)
      )
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_VERSION_NOT_READY", 409);
      if (input.enabled && new Date(input.expiresAt) <= now)
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Disclosure expiry must be in the future",
          400,
        );
      const previous = await this.localPolicy(tx, actor, versionId);
      if (previous && !editable(previous))
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_POLICY_SCOPE_CONFLICT", 409);
      const desired = {
        status: input.enabled ? "active" : "revoked",
        expiresAt: new Date(input.expiresAt),
        reason: input.reason,
      };
      if (
        previous &&
        previous.status === desired.status &&
        previous.expiresAt?.getTime() === desired.expiresAt.getTime() &&
        previous.reason === desired.reason
      )
        return previous;
      if ((previous?.updatedAt.toISOString() ?? null) !== input.expectedUpdatedAt)
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_POLICY_CHANGED", 409);
      if (!previous && !input.enabled)
        throw new AppError(ErrorCode.VALIDATION_ERROR, "DATA_POLICY_NOT_CONFIGURED", 409);
      const updatedAt = new Date(Math.max(now.getTime(), (previous?.updatedAt.getTime() ?? 0) + 1));
      const [saved] = previous
        ? await tx
            .update(dataAccessPolicies)
            .set({ ...desired, updatedAt })
            .where(eq(dataAccessPolicies.id, previous.id))
            .returning()
        : await tx
            .insert(dataAccessPolicies)
            .values({
              dataAssetId: data.asset.id,
              dataAssetVersionId: versionId,
              subjectKind: "org",
              subjectId: actor.orgId ?? "",
              capabilities: ["export"],
              effect: "allow",
              accessMode: data.asset.accessMode,
              sensitivity: data.asset.sensitivity,
              downloadPolicy: "allow",
              redistributionPolicy: "allow",
              crossCenterReplicationPolicy: "allow",
              createdBy: actor.userId,
              createdAt: now,
              updatedAt,
              ...desired,
            })
            .returning();
      if (!saved) throw new Error("Disclosure policy was not saved");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "data.disclosure_policy.update",
        target: saved.id,
        diff: { before: previous ?? null, after: saved },
      });
      return saved;
    });
  }

  private async authorize(actor: DataMarketActor, versionId: string) {
    z.uuid().parse(versionId);
    if (!actor.orgId || !actor.orgIds.includes(actor.orgId)) denied();
    const [version] = await this.db
      .select({ assetId: dataAssetVersions.dataAssetId })
      .from(dataAssetVersions)
      .where(eq(dataAssetVersions.id, versionId));
    if (!version) denied();
    await this.authorizeManage(actor, version.assetId);
  }

  private scope(tx: PgTransaction, actor: DataMarketActor, versionId: string, write: boolean) {
    return readDataVersionCustody(tx, actor, versionId, write);
  }

  private async localPolicy(tx: PgTransaction, actor: DataMarketActor, versionId: string) {
    const [policy] = await tx
      .select()
      .from(dataAccessPolicies)
      .where(
        and(
          eq(dataAccessPolicies.dataAssetVersionId, versionId),
          eq(dataAccessPolicies.subjectKind, "org"),
          eq(dataAccessPolicies.subjectId, actor.orgId ?? ""),
        ),
      )
      .for("share");
    return policy;
  }

  private policies(tx: PgTransaction, actor: DataMarketActor, assetId: string, versionId: string) {
    return tx
      .select()
      .from(dataAccessPolicies)
      .where(
        and(
          eq(dataAccessPolicies.dataAssetId, assetId),
          or(
            isNull(dataAccessPolicies.dataAssetVersionId),
            eq(dataAccessPolicies.dataAssetVersionId, versionId),
          ),
          or(
            and(
              eq(dataAccessPolicies.subjectKind, "user"),
              eq(dataAccessPolicies.subjectId, actor.userId),
            ),
            and(
              or(
                eq(dataAccessPolicies.subjectKind, "org"),
                eq(dataAccessPolicies.subjectKind, "provider-org"),
              ),
              eq(dataAccessPolicies.subjectId, actor.orgId ?? ""),
            ),
            eq(dataAccessPolicies.subjectKind, "platform"),
          ),
        ),
      )
      .orderBy(asc(dataAccessPolicies.id))
      .limit(101)
      .for("share");
  }
}

function editable(policy: Policy) {
  return (
    policy.effect === "allow" &&
    policy.capabilities.length === 1 &&
    policy.capabilities[0] === "export" &&
    policy.downloadPolicy === "allow" &&
    policy.redistributionPolicy === "allow" &&
    policy.crossCenterReplicationPolicy === "allow" &&
    policy.derivePolicy === "deny" &&
    policy.retentionPolicy === "source-controlled"
  );
}
function denied(): never {
  throw new AppError(
    ErrorCode.FORBIDDEN,
    "Data disclosure requires current asset management authority",
    403,
  );
}
