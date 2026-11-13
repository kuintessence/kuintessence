import {
  authzOutbox,
  dataAccessPolicies,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  dataLocations,
  dataReplicas,
  federationDatasetAssets,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import { and, eq, inArray, or } from "drizzle-orm";
import { dataAssetGrantTuples } from "../authz/projection";
import type { AuthzTuple } from "../authz/service";
import { datasetSourceAuthority, isFederationDataset } from "../federation/dataset-authority";
import { type DataAccessAuthorization, evaluateActiveDataAccess } from "./data-access-decision";
import type {
  DataCandidateLocation,
  DataPrerequisiteRepository,
  DataRequirement,
} from "./data-prerequisite";

export class PgDataPrerequisiteRepository implements DataPrerequisiteRepository {
  private readonly replicaMaxAgeMs: number;
  private readonly now: () => Date;
  private readonly evaluateAccess: typeof evaluateActiveDataAccess;

  constructor(
    private readonly db: PgDb | PgTransaction,
    options: DataPrerequisiteRepositoryOptions = {},
  ) {
    this.replicaMaxAgeMs = options.replicaMaxAgeMs ?? DEFAULT_REPLICA_MAX_AGE_MS;
    this.now = options.now ?? (() => new Date(Date.now()));
    this.evaluateAccess = options.evaluateAccess ?? evaluateActiveDataAccess;
  }

  async resolveVersion(input: DataRequirement) {
    const [version] = await this.db
      .select({
        id: dataAssetVersions.id,
        manifestDigest: dataAssetVersions.manifestDigest,
        status: dataAssetVersions.status,
      })
      .from(dataAssetVersions)
      .where(
        and(
          eq(dataAssetVersions.id, input.versionId),
          eq(dataAssetVersions.dataAssetId, input.assetId),
        ),
      )
      .limit(1);
    if (!version) return null;
    return {
      id: version.id,
      manifestDigest: version.manifestDigest,
      available: version.status === "ready",
    };
  }

  async listLocations(versionId: string): Promise<DataCandidateLocation[]> {
    const rows = await this.db
      .select({
        locationId: dataLocations.id,
        assetId: dataAssetVersions.dataAssetId,
        agentId: dataLocations.agentId,
        siteId: dataLocations.siteId,
        managedRootId: dataLocations.managedRootId,
        relativePath: dataLocations.relativePath,
        kind: dataLocations.kind,
        versionManifestDigest: dataAssetVersions.manifestDigest,
        replicaId: dataReplicas.id,
        replicaStatus: dataReplicas.status,
        replicaManifestDigest: dataReplicas.manifestDigest,
        replicaVerifiedAt: dataReplicas.verifiedAt,
      })
      .from(dataLocations)
      .innerJoin(dataAssetVersions, eq(dataLocations.dataAssetVersionId, dataAssetVersions.id))
      .leftJoin(dataReplicas, eq(dataReplicas.targetLocationId, dataLocations.id))
      .where(
        and(eq(dataLocations.dataAssetVersionId, versionId), eq(dataLocations.status, "available")),
      );
    const first = rows[0];
    const source = first
      ? await datasetSourceAuthority(this.db, { assetId: first.assetId, versionId }, this.now())
      : null;
    return rows.flatMap((row) => {
      if (source && !source.locationIds.includes(row.locationId)) return [];
      if (
        row.replicaId !== null &&
        !isReplicaEligible(
          {
            status: row.replicaStatus,
            manifestDigest: row.replicaManifestDigest,
            verifiedAt: row.replicaVerifiedAt,
          },
          row.versionManifestDigest,
          this.now(),
          this.replicaMaxAgeMs,
        )
      ) {
        return [];
      }
      if (row.kind === "cp-local" && (!row.agentId || !row.siteId)) return [];
      return [
        {
          locationId: row.locationId,
          agentId: row.agentId ?? "",
          siteId: row.siteId ?? "global-object-store",
          clusterId: row.siteId ?? "global-object-store",
          kind: row.kind === "cp-local" ? "cp-local" : "object",
          ...(row.managedRootId ? { managedRootId: row.managedRootId } : {}),
          ...(row.relativePath ? { relativePath: row.relativePath } : {}),
        },
      ];
    });
  }

  async listAvailableVersionIds(versionIds: readonly string[]): Promise<Set<string>> {
    if (versionIds.length === 0) return new Set();
    const rows = await this.db
      .select({
        versionId: dataLocations.dataAssetVersionId,
        assetId: dataAssetVersions.dataAssetId,
        locationId: dataLocations.id,
        agentId: dataLocations.agentId,
        siteId: dataLocations.siteId,
        kind: dataLocations.kind,
        versionManifestDigest: dataAssetVersions.manifestDigest,
        replicaId: dataReplicas.id,
        replicaStatus: dataReplicas.status,
        replicaManifestDigest: dataReplicas.manifestDigest,
        replicaVerifiedAt: dataReplicas.verifiedAt,
      })
      .from(dataLocations)
      .innerJoin(dataAssetVersions, eq(dataLocations.dataAssetVersionId, dataAssetVersions.id))
      .leftJoin(dataReplicas, eq(dataReplicas.targetLocationId, dataLocations.id))
      .where(
        and(
          inArray(dataLocations.dataAssetVersionId, [...versionIds]),
          eq(dataLocations.status, "available"),
        ),
      );
    const now = this.now();
    const sources = new Map<string, Awaited<ReturnType<typeof datasetSourceAuthority>>>();
    for (const row of rows)
      if (!sources.has(row.versionId))
        sources.set(
          row.versionId,
          await datasetSourceAuthority(
            this.db,
            { assetId: row.assetId, versionId: row.versionId },
            now,
          ),
        );
    return new Set(
      rows.flatMap((row) => {
        const source = sources.get(row.versionId);
        if (source && !source.locationIds.includes(row.locationId)) return [];
        if (
          row.replicaId !== null &&
          !isReplicaEligible(
            {
              status: row.replicaStatus,
              manifestDigest: row.replicaManifestDigest,
              verifiedAt: row.replicaVerifiedAt,
            },
            row.versionManifestDigest,
            now,
            this.replicaMaxAgeMs,
          )
        ) {
          return [];
        }
        if (row.kind === "cp-local" && (!row.agentId || !row.siteId)) return [];
        return [row.versionId];
      }),
    );
  }

  async verifyAccessBatch(input: {
    actorUserId: string;
    orgId: string | null;
    candidates: readonly DataAccessCandidate[];
  }): Promise<Set<string>> {
    if (input.candidates.length === 0) return new Set();
    const assetIds = [...new Set(input.candidates.map((candidate) => candidate.assetId))];
    const foreign = new Set(
      (
        await this.db
          .select({ id: federationDatasetAssets.assetId })
          .from(federationDatasetAssets)
          .where(inArray(federationDatasetAssets.assetId, assetIds))
      ).map((r) => r.id),
    );
    const foreignAllowed = new Set<string>();
    for (const candidate of input.candidates)
      if (
        foreign.has(candidate.assetId) &&
        (await this.verifyAccess({
          assetId: candidate.assetId,
          versionId: candidate.versionId,
          actorUserId: input.actorUserId,
          orgId: input.orgId,
        }))
      )
        foreignAllowed.add(candidate.versionId);
    const subject = or(
      and(eq(dataGrants.subjectKind, "user"), eq(dataGrants.subjectId, input.actorUserId)),
      ...(input.orgId
        ? [and(eq(dataGrants.subjectKind, "org"), eq(dataGrants.subjectId, input.orgId))]
        : []),
    );
    const policySubject = or(
      and(
        eq(dataAccessPolicies.subjectKind, "user"),
        eq(dataAccessPolicies.subjectId, input.actorUserId),
      ),
      ...(input.orgId
        ? [
            and(
              eq(dataAccessPolicies.subjectKind, "org"),
              eq(dataAccessPolicies.subjectId, input.orgId),
            ),
          ]
        : []),
    );
    const [grants, policies] = await Promise.all([
      this.db
        .select({
          assetId: dataGrants.dataAssetId,
          id: dataGrants.id,
          versionId: dataGrants.dataAssetVersionId,
          subjectKind: dataGrants.subjectKind,
          subjectId: dataGrants.subjectId,
          capabilities: dataGrants.capabilities,
          startsAt: dataGrants.startsAt,
          expiresAt: dataGrants.expiresAt,
        })
        .from(dataGrants)
        .where(
          and(inArray(dataGrants.dataAssetId, assetIds), eq(dataGrants.status, "active"), subject),
        ),
      this.db
        .select({
          assetId: dataAccessPolicies.dataAssetId,
          id: dataAccessPolicies.id,
          versionId: dataAccessPolicies.dataAssetVersionId,
          subjectKind: dataAccessPolicies.subjectKind,
          subjectId: dataAccessPolicies.subjectId,
          effect: dataAccessPolicies.effect,
          capabilities: dataAccessPolicies.capabilities,
          expiresAt: dataAccessPolicies.expiresAt,
        })
        .from(dataAccessPolicies)
        .where(
          and(
            inArray(dataAccessPolicies.dataAssetId, assetIds),
            eq(dataAccessPolicies.status, "active"),
            policySubject,
          ),
        ),
    ]);
    const now = this.now();
    await expireAccessRows(this.db, grants, policies, now);
    const grantsByAssetId = groupByAssetId(grants);
    const policiesByAssetId = groupByAssetId(policies);
    return new Set(
      input.candidates.flatMap((candidate) => {
        if (foreign.has(candidate.assetId))
          return foreignAllowed.has(candidate.versionId) ? [candidate.versionId] : [];
        if (!requiresActiveEntitlementUse(candidate.kind, candidate.accessMode)) {
          if (candidate.ownerUserId === input.actorUserId) return [candidate.versionId];
          if (
            input.orgId !== null &&
            (candidate.ownerOrgId === input.orgId || candidate.providerOrgId === input.orgId)
          ) {
            return [candidate.versionId];
          }
          if (candidate.visibility === "private") return [];
          if (
            candidate.visibility === "public" &&
            candidate.lifecycle === "published" &&
            candidate.accessMode === "open"
          ) {
            return [candidate.versionId];
          }
        }
        const applicablePolicies = (policiesByAssetId.get(candidate.assetId) ?? []).filter(
          (policy) =>
            policy.assetId === candidate.assetId &&
            (policy.versionId === null || policy.versionId === candidate.versionId) &&
            (policy.expiresAt === null || policy.expiresAt > now) &&
            allowsUse(policy.capabilities),
        );
        if (applicablePolicies.some((policy) => policy.effect === "deny")) return [];
        const granted = (grantsByAssetId.get(candidate.assetId) ?? []).some(
          (grant) =>
            grant.assetId === candidate.assetId &&
            (grant.versionId === null || grant.versionId === candidate.versionId) &&
            grant.startsAt <= now &&
            (grant.expiresAt === null || grant.expiresAt > now) &&
            allowsUse(grant.capabilities),
        );
        return granted || applicablePolicies.some((policy) => policy.effect === "allow")
          ? [candidate.versionId]
          : [];
      }),
    );
  }

  async verifyAccess(input: {
    actorUserId: string;
    orgId: string | null;
    assetId: string;
    versionId: string;
  }): Promise<boolean> {
    return (await this.authorizeAccess(input)).allowed;
  }

  async authorizeAccess(
    input: Parameters<PgDataPrerequisiteRepository["verifyAccess"]>[0],
  ): Promise<DataAccessAuthorization> {
    const [asset] = await this.db
      .select()
      .from(dataAssets)
      .where(eq(dataAssets.id, input.assetId))
      .limit(1);
    if (!asset) return { allowed: false, expiresAtUnixMs: 0 };
    if (
      requiresActiveEntitlementUse(asset.kind, asset.accessMode) ||
      (await isFederationDataset(this.db, asset.id))
    ) {
      return this.evaluateAccess(this.db, {
        assetId: input.assetId,
        versionId: input.versionId,
        actorUserId: input.actorUserId,
        orgIds: input.orgId ? [input.orgId] : [],
        capability: "use",
        now: this.now(),
      });
    }
    if (asset.ownerUserId === input.actorUserId)
      return { allowed: true, expiresAtUnixMs: Number.POSITIVE_INFINITY };
    if (
      input.orgId !== null &&
      (asset.ownerOrgId === input.orgId || asset.providerOrgId === input.orgId)
    ) {
      return { allowed: true, expiresAtUnixMs: Number.POSITIVE_INFINITY };
    }
    if (asset.visibility === "private") return { allowed: false, expiresAtUnixMs: 0 };
    if (
      asset.visibility === "public" &&
      asset.lifecycle === "published" &&
      asset.accessMode === "open"
    ) {
      return { allowed: true, expiresAtUnixMs: Number.POSITIVE_INFINITY };
    }
    return this.evaluateAccess(this.db, {
      assetId: input.assetId,
      versionId: input.versionId,
      actorUserId: input.actorUserId,
      orgIds: input.orgId ? [input.orgId] : [],
      capability: "use",
      now: this.now(),
    });
  }
}

async function expireAccessRows(
  db: PgDb | PgTransaction,
  grants: readonly BatchGrant[],
  policies: readonly BatchPolicy[],
  now: Date,
): Promise<void> {
  const expiredGrants = grants.filter(
    (grant) => grant.expiresAt !== null && grant.expiresAt <= now,
  );
  const expiredPolicies = policies.filter(
    (policy) => policy.expiresAt !== null && policy.expiresAt <= now,
  );
  if (expiredGrants.length === 0 && expiredPolicies.length === 0) return;
  await db.transaction(async (tx) => {
    if (expiredGrants.length > 0) {
      await tx
        .update(dataGrants)
        .set({ status: "expired" })
        .where(
          inArray(
            dataGrants.id,
            expiredGrants.map((grant) => grant.id),
          ),
        );
    }
    if (expiredPolicies.length > 0) {
      await tx
        .update(dataAccessPolicies)
        .set({ status: "disabled", updatedAt: now })
        .where(
          inArray(
            dataAccessPolicies.id,
            expiredPolicies.map((policy) => policy.id),
          ),
        );
    }
    const tuples = [
      ...expiredGrants.flatMap((grant) => accessDeleteTuples(grant)),
      ...expiredPolicies.flatMap((policy) =>
        policy.effect === "allow" ? accessDeleteTuples(policy) : [],
      ),
    ];
    if (tuples.length > 0) {
      await tx.insert(authzOutbox).values(tuples.map(outboxRow));
    }
  });
}

interface BatchGrant {
  id: string;
  assetId: string;
  versionId: string | null;
  subjectKind: string;
  subjectId: string;
  capabilities: string[];
  startsAt: Date;
  expiresAt: Date | null;
}

interface BatchPolicy {
  id: string;
  assetId: string;
  versionId: string | null;
  subjectKind: string;
  subjectId: string;
  effect: string;
  capabilities: string[];
  expiresAt: Date | null;
}

function accessDeleteTuples(row: {
  assetId: string;
  subjectKind: string;
  subjectId: string;
  capabilities: string[];
}): AuthzTuple[] {
  return dataAssetGrantTuples({
    assetId: row.assetId,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    capabilities: row.capabilities,
    operation: "delete",
  });
}

function outboxRow(tuple: AuthzTuple) {
  return {
    operation: tuple.operation,
    resourceType: tuple.resource.type,
    resourceId: tuple.resource.id,
    relation: tuple.relation,
    subjectType: tuple.subject.type,
    subjectId: tuple.subject.id,
    subjectRelation: tuple.subject.relation ?? null,
    payload: tuple.payload ?? {},
  };
}

function groupByAssetId<T extends { assetId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    grouped.set(row.assetId, [...(grouped.get(row.assetId) ?? []), row]);
  }
  return grouped;
}

export interface DataAccessCandidate {
  assetId: string;
  versionId: string;
  kind: string;
  accessMode: string;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  providerOrgId: string | null;
  visibility: string;
  lifecycle: string;
}

const DEFAULT_REPLICA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface DataPrerequisiteRepositoryOptions {
  replicaMaxAgeMs?: number;
  now?: () => Date;
  evaluateAccess?: typeof evaluateActiveDataAccess;
}

export function requiresActiveEntitlementUse(kind: string, accessMode: string): boolean {
  return kind === "licensed-material" && accessMode === "entitlement";
}

function allowsUse(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) =>
    ["use", "download", "derive", "manage"].includes(capability),
  );
}

export interface ReplicaVerification {
  status: string | null;
  manifestDigest: string | null;
  verifiedAt: Date | null;
}

export function isReplicaEligible(
  replica: ReplicaVerification,
  immutableManifestDigest: string | null,
  now: Date,
  maxAgeMs: number,
): boolean {
  if (
    replica.status !== "available" ||
    !immutableManifestDigest ||
    replica.manifestDigest !== immutableManifestDigest ||
    !replica.verifiedAt
  ) {
    return false;
  }
  const verifiedAtMs = replica.verifiedAt.getTime();
  const ageMs = now.getTime() - verifiedAtMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}
