import {
  agents,
  clusterFileRoots,
  dataAccessPolicies,
  dataAssetManifestEntries,
  dataAssets,
  dataAssetVersions,
  dataLocations,
  type PgTransaction,
} from "@kuintessence/db";
import {
  FederationError,
  FederationMediaManifestSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { FederationActor } from "./permissions";

/** Use/download grants alone carry no permission to redistribute a dataset to another institution. */
export async function readMediaExportDataset(
  tx: PgTransaction,
  actor: FederationActor,
  input: { versionId: string; locationId: string },
  now: Date,
) {
  const [data] = await tx
    .select({ asset: dataAssets, version: dataAssetVersions })
    .from(dataAssetVersions)
    .innerJoin(dataAssets, eq(dataAssets.id, dataAssetVersions.dataAssetId))
    .where(eq(dataAssetVersions.id, input.versionId))
    .for("share", { of: [dataAssets, dataAssetVersions] });
  if (
    !data ||
    data.asset.lifecycle !== "published" ||
    data.version.status !== "ready" ||
    !data.version.immutableAt ||
    !data.version.manifestDigest
  )
    throw new FederationError("POLICY_DENIED");
  const policies = await tx
    .select()
    .from(dataAccessPolicies)
    .where(
      and(
        eq(dataAccessPolicies.dataAssetId, data.asset.id),
        eq(dataAccessPolicies.status, "active"),
        or(
          isNull(dataAccessPolicies.dataAssetVersionId),
          eq(dataAccessPolicies.dataAssetVersionId, input.versionId),
        ),
        or(
          and(
            eq(dataAccessPolicies.subjectKind, "user"),
            eq(dataAccessPolicies.subjectId, actor.userId),
          ),
          and(
            eq(dataAccessPolicies.subjectKind, "org"),
            eq(dataAccessPolicies.subjectId, actor.orgId),
          ),
          and(
            eq(dataAccessPolicies.subjectKind, "provider-org"),
            eq(dataAccessPolicies.subjectId, actor.orgId),
          ),
          eq(dataAccessPolicies.subjectKind, "platform"),
        ),
      ),
    )
    .orderBy(asc(dataAccessPolicies.id))
    .for("share");
  const active = policies.filter((policy) => !policy.expiresAt || policy.expiresAt > now);
  const relevant = active.filter((policy) =>
    policy.capabilities.some((capability) =>
      ["view", "use", "download", "manage"].includes(capability),
    ),
  );
  if (
    relevant.some(
      (policy) =>
        policy.effect === "deny" ||
        policy.downloadPolicy !== "allow" ||
        policy.redistributionPolicy !== "allow" ||
        policy.crossCenterReplicationPolicy !== "allow",
    )
  )
    throw new FederationError("POLICY_DENIED");
  const permits = relevant.filter(
    (policy) => policy.effect === "allow" && policy.capabilities.includes("download"),
  );
  if (!permits.length) throw new FederationError("POLICY_DENIED");
  const [storage] = await tx
    .select({ location: dataLocations, root: clusterFileRoots, agent: agents })
    .from(dataLocations)
    .innerJoin(clusterFileRoots, eq(clusterFileRoots.id, dataLocations.managedRootId))
    .innerJoin(agents, eq(agents.agentId, dataLocations.agentId))
    .where(
      and(
        eq(dataLocations.id, input.locationId),
        eq(dataLocations.dataAssetVersionId, input.versionId),
      ),
    )
    .for("share", { of: [dataLocations, clusterFileRoots, agents] });
  if (
    !storage ||
    storage.location.kind !== "cp-local" ||
    storage.location.status !== "available" ||
    !storage.location.relativePath ||
    !storage.root.enabled ||
    storage.root.providerOrgId !== actor.orgId ||
    storage.agent.providerOrgId !== actor.orgId ||
    storage.root.agentId !== storage.agent.agentId
  )
    throw new FederationError("POLICY_DENIED");
  const entries = await tx
    .select()
    .from(dataAssetManifestEntries)
    .where(eq(dataAssetManifestEntries.dataAssetVersionId, input.versionId))
    .orderBy(asc(dataAssetManifestEntries.entryPath))
    .limit(1001)
    .for("share");
  // Preserve arbitrary structured provenance, rather than silently dropping unknown source fields.
  const rawFiles = entries.map((entry) => ({
    path: entry.entryPath,
    sizeBytes: entry.sizeBytes,
    sha256: entry.digest.startsWith("sha256:") ? entry.digest.slice(7) : entry.digest,
    license: entry.metadata.license ?? null,
    provenance: entry.metadata.provenance ?? null,
  }));
  federationCanonicalJson(rawFiles);
  const files = FederationMediaManifestSchema.shape.files.parse(rawFiles);
  if (
    data.version.sizeBytes === null ||
    files.reduce((sum, file) => sum + file.sizeBytes, 0) !== data.version.sizeBytes
  )
    throw new FederationError("OPERATION_CONFLICT");
  return {
    asset: data.asset,
    version: data.version,
    files,
    source: {
      agentId: storage.agent.agentId,
      managedRootId: storage.root.id,
      relativePath: storage.location.relativePath,
    },
    authorizationExpiresAt: Math.max(
      ...permits.map((policy) => policy.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY),
    ),
  };
}
