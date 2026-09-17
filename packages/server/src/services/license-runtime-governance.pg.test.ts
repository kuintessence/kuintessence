import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  agentInstalledSoftware,
  agents,
  createPgDb,
  ecosystemReleaseAssets,
  ecosystemReleases,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import type { BoundPrincipal } from "../middleware/principal-binder";
import {
  LicenseRuntimeGovernanceService,
  PgGovernanceRepository,
} from "./license-runtime-governance";
import { SoftwareAvailabilityService } from "./software-availability";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const NAME_PREFIX = "license-supersession-test-";
const AGENT_PREFIX = "license-snapshot-agent-";
const OPEN_LICENSE = {
  classification: "open-source",
  identifiers: [{ kind: "spdx", value: "Zlib" }],
  termsUrl: "https://spdx.org/licenses/Zlib.html",
  provenance: { source: "official-upstream", reference: "zlib LICENSE" },
  acceptanceRequired: false,
  providerEntitlements: [],
  consumerEntitlements: [],
  redistribution: "permitted",
  autoInstall: "allowed",
};

describe("PgGovernanceRepository upstream supersession", () => {
  let db: PgDb;

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
  });

  afterAll(async () => {
    await db.delete(agents).where(like(agents.agentId, `${AGENT_PREFIX}%`));
    await db.delete(ecosystemReleases).where(like(ecosystemReleases.releaseKey, `${NAME_PREFIX}%`));
    await db.delete(softwareAssets).where(like(softwareAssets.name, `${NAME_PREFIX}%`));
  });

  test("makes a release-backed ordinary snapshot available without supersession", async () => {
    const name = `${NAME_PREFIX}${crypto.randomUUID()}`;
    const version = "1.0.0";
    const agentId = `${AGENT_PREFIX}${crypto.randomUUID()}`;
    const payload = {
      kind: "spack-package" as const,
      spack: { packageName: name, defaultSpec: `${name}@${version}` },
    };
    const [release] = await db
      .insert(ecosystemReleases)
      .values({
        releaseKey: name,
        version: "1",
        artifactDigest: randomDigest(),
        manifest: {},
        provenance: {},
        signature: "test-signature",
        signingKeyId: "test-key",
        status: "active",
        importedBy: "test-operator",
      })
      .returning();
    if (!release) throw new Error("test release insert failed");
    const [policySource] = await db
      .insert(ecosystemReleaseAssets)
      .values({
        releaseId: release.id,
        ecosystemKey: `software/${name}`,
        kind: "spack-package",
        name,
        version,
        payload,
        provenance: { source: "official-upstream" },
        licensePolicy: OPEN_LICENSE,
        manifestEntryDigest: randomDigest(),
      })
      .returning();
    if (!policySource) throw new Error("test policy source insert failed");
    const provenance = {
      source: "official-upstream",
      snapshot: "versioned-upstream",
      sourceAssetId: crypto.randomUUID(),
      sourceRevisionId: crypto.randomUUID(),
      sourceRevision: 1,
      upstreamName: name,
      upstreamVersion: version,
      licensePolicySource: {
        releaseId: release.id,
        releaseAssetId: policySource.id,
      },
    };
    const [snapshot] = await db
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name,
        version,
        source: "official-upstream",
        lifecycle: "published",
        visibility: "platform-public",
        trustedForGlobalUse: true,
        payload,
        provenance,
      })
      .returning();
    if (!snapshot) throw new Error("test snapshot insert failed");
    await db.insert(softwareAssetRevisions).values({
      assetId: snapshot.id,
      revision: 1,
      payload,
      provenance,
    });
    await db.insert(agents).values({
      agentId,
      siteName: agentId,
      schedulerType: "slurm",
      schedulerVersion: "23.11",
      status: "online",
    });
    await db.insert(agentInstalledSoftware).values({
      agentId,
      name,
      version,
      hash: crypto.randomUUID().replaceAll("-", ""),
      spec: `${name}@${version}`,
    });

    const governance = new LicenseRuntimeGovernanceService(new PgGovernanceRepository(db));
    const principal: BoundPrincipal = {
      sub: "license-snapshot-user",
      role: "user",
      email: "license-snapshot-user@example.com",
      userId: crypto.randomUUID(),
      orgId: null,
      orgIds: [],
      memberships: [],
      capabilities: [],
    };
    const availability = await new SoftwareAvailabilityService(db, { governance }).resolve(
      {
        assetRef: { kind: "spack-package", id: snapshot.id },
        rawSpec: `${name}@${version}`,
        targetAgentIds: [agentId],
        installable: false,
      },
      principal,
    );

    expect(await governance.getCanonicalLicensePolicy(snapshot.id)).toMatchObject({
      classification: "open-source",
      identifiers: ["Zlib"],
      autoInstallAllowed: true,
    });
    expect(availability.installedAvailable).toMatchObject([{ agentId }]);
    expect(availability.blocked).toHaveLength(0);
  });

  test("inherits a signed active policy only through an intact explicit supersession", async () => {
    const name = `${NAME_PREFIX}${crypto.randomUUID()}`;
    const identity = `official-upstream/${name}/1.3.1`;
    const payload = {
      kind: "spack-package",
      spack: { packageName: name, defaultSpec: `${name}@1.3.1` },
    };
    const [legacy] = await db
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name,
        version: "1.3.1",
        source: "official-upstream",
        lifecycle: "archived",
        visibility: "hidden",
        trustedForGlobalUse: true,
        payload,
        provenance: { source: "official-upstream", upstreamName: name, upstreamRef: "v1.3.1" },
      })
      .returning();
    const [replacement] = await db
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name,
        version: "1.3.1",
        source: "official-upstream",
        lifecycle: "published",
        visibility: "platform-public",
        trustedForGlobalUse: true,
        payload,
        provenance: { source: "official-upstream", snapshot: "versioned-upstream" },
      })
      .returning();
    if (!legacy || !replacement) throw new Error("test asset insert failed");
    const [legacyRevision] = await db
      .insert(softwareAssetRevisions)
      .values({ assetId: legacy.id, revision: 1, payload, provenance: legacy.provenance })
      .returning();
    const [replacementRevision] = await db
      .insert(softwareAssetRevisions)
      .values({ assetId: replacement.id, revision: 1, payload, provenance: replacement.provenance })
      .returning();
    if (!legacyRevision || !replacementRevision) throw new Error("test revision insert failed");
    await db
      .update(softwareAssets)
      .set({
        reviewState: {
          upstreamVersionSupersession: {
            kind: "versioned-upstream",
            canonicalIdentity: identity,
            legacyRevisionId: legacyRevision.id,
            replacementAssetId: replacement.id,
            replacementRevisionId: replacementRevision.id,
            reason: "test migration",
            supersededAt: new Date().toISOString(),
            supersededBy: "test-operator",
          },
        },
      })
      .where(eq(softwareAssets.id, legacy.id));

    const [release] = await db
      .insert(ecosystemReleases)
      .values({
        releaseKey: name,
        version: "1",
        artifactDigest: randomDigest(),
        manifest: {},
        provenance: {},
        signature: "test-signature",
        signingKeyId: "test-key",
        status: "active",
        importedBy: "test-operator",
      })
      .returning();
    if (!release) throw new Error("test release insert failed");
    await db.insert(ecosystemReleaseAssets).values({
      releaseId: release.id,
      ecosystemKey: `spack:${name}@1.3.1`,
      kind: "spack-package",
      name,
      version: "1.3.1",
      payload,
      provenance: legacy.provenance,
      licensePolicy: OPEN_LICENSE,
      manifestEntryDigest: randomDigest(),
      assetId: legacy.id,
      assetRevisionId: legacyRevision.id,
      materializedAt: new Date(),
    });

    const repository = new PgGovernanceRepository(db);
    expect(await repository.getCanonicalLicensePolicy(replacement.id)).toMatchObject({
      classification: "open-source",
      identifiers: ["Zlib"],
      autoInstallAllowed: true,
    });

    await db
      .update(softwareAssets)
      .set({
        reviewState: {
          upstreamVersionSupersession: {
            kind: "versioned-upstream",
            canonicalIdentity: identity,
            legacyRevisionId: legacyRevision.id,
            replacementAssetId: replacement.id,
            replacementRevisionId: crypto.randomUUID(),
            reason: "test migration",
            supersededAt: new Date().toISOString(),
            supersededBy: "test-operator",
          },
        },
      })
      .where(eq(softwareAssets.id, legacy.id));
    expect(await repository.getCanonicalLicensePolicy(replacement.id)).toBeNull();
  });
});

function randomDigest(): string {
  return `sha256:${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
}
