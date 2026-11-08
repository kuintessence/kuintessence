import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  agents,
  clusterFileRoots,
  createPgDb,
  dataAccessPolicies,
  dataAssetManifestEntries,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  dataLocations,
  federationDatasetReplicas,
  jobs,
} from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "../../packages/server/src/federation/assets";
import { datasetSourceAuthority } from "../../packages/server/src/federation/dataset-authority";
import { FederationPermissionService } from "../../packages/server/src/federation/permissions";

assert.equal(process.env.LAB_SCENARIO, "media");
const root = z.string().min(1).parse(process.env.LAB_ROOT);
const url = z.string().min(1).parse(process.env.DATABASE_URL);
assert(new URL(url).pathname.startsWith("/kuintessence_unit_"));
const db = createPgDb(url);
const rootId = z.uuid().parse(process.env.LAB_MEDIA_ROOT_ID);
const agentId = z.string().min(1).parse(process.env.LAB_AGENT);
const command = process.argv[2];
assert(
  command === "source" || command === "target" || command === "inspect" || command === "authorize",
);
try {
  if (command === "authorize") {
    assert.equal(process.env.LAB_MEDIA_EXECUTION, "slurm");
    const actor = z
      .object({ orgId: z.uuid(), userId: z.uuid() })
      .parse(await Bun.file(`${root}/registration.json`).json());
    const probe = z
      .object({ identity: z.object({ userId: z.uuid() }) })
      .parse(await Bun.file(`${root}/federation-probe.json`).json());
    const [replica] = await db.select().from(federationDatasetReplicas);
    assert(replica);
    assert((await datasetSourceAuthority(db, replica, new Date()))?.allowed);
    // Explicit local grant fixtures for the operator mapping and restricted service identity.
    // No job/execution state or source approval is fabricated by this setup command.
    await db.insert(dataGrants).values(
      [actor.userId, probe.identity.userId].map((userId) => ({
        dataAssetId: replica.assetId,
        dataAssetVersionId: replica.versionId,
        subjectKind: "user",
        subjectId: userId,
        capabilities: ["use"],
        grantedBy: actor.userId,
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      })),
    );
  } else if (command === "inspect") {
    const replicas = await db.select().from(federationDatasetReplicas);
    assert.equal(replicas.length, 1);
    const replica = replicas[0];
    assert(replica);
    const authority = await datasetSourceAuthority(db, replica, new Date()).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          error.cause &&
          typeof error.cause === "object" &&
          "code" in error.cause &&
          error.cause.code === "55P03"
        ) {
          return { allowed: null };
        }
        throw error;
      },
    );
    const entries = await db
      .select({
        sha256: dataAssetManifestEntries.digest,
        sizeBytes: dataAssetManifestEntries.sizeBytes,
        metadata: dataAssetManifestEntries.metadata,
      })
      .from(dataAssetManifestEntries)
      .where(eq(dataAssetManifestEntries.dataAssetVersionId, replica.versionId));
    await Bun.write(
      `${root}/media-authority.json`,
      JSON.stringify({
        allowed: authority ? authority.allowed : false,
        lastError: replica.lastError,
        jobs: (await db.select({ id: jobs.id }).from(jobs)).length,
        entries,
      }),
    );
  } else {
    const actorFile = command === "source" ? "source-actor.json" : "registration.json";
    const actor = z
      .object({ orgId: z.uuid(), userId: z.uuid() })
      .parse(await Bun.file(`${root}/${actorFile}`).json());
    const [agent] = await db.select().from(agents).where(eq(agents.agentId, agentId));
    assert.equal(agent?.providerOrgId, actor.orgId);
    assert(agent?.siteId);
    await db.insert(clusterFileRoots).values({
      id: rootId,
      agentId,
      providerOrgId: actor.orgId,
      label: "Isolated media dataset root",
      path: "/var/lib/kuintessence/datasets",
    });
    const permissions = new FederationPermissionService(db);
    for (const capability of [
      "asset.read",
      "media.export",
      "media.import",
      "dataset.use.approve",
    ] as const)
      await permissions.set({ ...actor, capability, enabled: true }, actor.userId);
    if (command === "source") {
      const configuration = await Bun.file(`${root}/source-init.json`).json();
      const assetId = configuration.media?.assetId ?? crypto.randomUUID();
      const versionId = configuration.media?.versionId ?? crypto.randomUUID();
      const locationId = configuration.media?.locationId ?? crypto.randomUUID();
      const sha256 = createHash("sha256").update("data").digest("hex");
      const metadata = {
        license: "CC0-1.0",
        provenance: { source: "synthetic acceptance input", generator: "KQ media lab" },
      };
      const files = [{ path: "input.dat", sizeBytes: 4, sha256, ...metadata }];
      await db.insert(dataAssets).values({
        id: assetId,
        ownerUserId: actor.userId,
        name: "Media acceptance observations",
        lifecycle: "published",
        visibility: "public",
        accessMode: "open",
        metadata: { license: metadata.license },
      });
      await db.insert(dataAssetVersions).values({
        id: versionId,
        dataAssetId: assetId,
        version: "v1",
        status: "ready",
        sizeBytes: 4,
        manifestDigest: federationMaterialDigest({ files }),
        immutableAt: new Date(),
        provenance: metadata.provenance,
      });
      await db.insert(dataAssetManifestEntries).values({
        dataAssetVersionId: versionId,
        entryPath: "input.dat",
        digest: sha256,
        sizeBytes: 4,
        metadata,
      });
      await db.insert(dataLocations).values({
        id: locationId,
        dataAssetVersionId: versionId,
        kind: "cp-local",
        managedRootId: rootId,
        relativePath: "v1",
        agentId,
        siteId: agent.siteId,
        providerOrgId: actor.orgId,
        status: "available",
      });
      // Initial dataset inventory and disclosure consent; package/use approvals use real HTTP.
      await db.insert(dataAccessPolicies).values({
        dataAssetId: assetId,
        dataAssetVersionId: versionId,
        subjectKind: "user",
        subjectId: actor.userId,
        capabilities: ["download"],
        downloadPolicy: "allow",
        redistributionPolicy: "allow",
        crossCenterReplicationPolicy: "allow",
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await Bun.write(
        `${root}/media-source.json`,
        JSON.stringify({ assetId, versionId, locationId, sha256, metadata }),
      );
    }
  }
} finally {
  await db.$client.end();
}
