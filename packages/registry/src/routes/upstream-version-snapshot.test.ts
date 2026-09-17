import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  auditLog,
  authzOutbox,
  createPgDb,
  ecosystemReleaseAssets,
  ecosystemReleases,
  type PgDb,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import { and, eq, inArray, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { SoftwareAssetService } from "../services/software-asset-service";
import { SpackCatalogService } from "../services/spack-catalog-service";
import { createSpackCatalogRoutes } from "./spack-catalog";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const NAME_PREFIX = "snapshotroute-test-";
const PLATFORM_HEADERS = principalHeaders("platform_admin");
const SUPER_HEADERS = principalHeaders("super_admin");
const ORG_ADMIN_HEADERS = principalHeaders("org_admin");
const USER_HEADERS = principalHeaders("user");
const OPEN_LICENSE = {
  classification: "open-source",
  identifiers: [{ kind: "spdx", value: "MIT" }],
  termsUrl: "https://spdx.org/licenses/MIT.html",
  provenance: { source: "official-upstream", reference: "reviewed upstream license" },
  acceptanceRequired: false,
  providerEntitlements: [],
  consumerEntitlements: [],
  redistribution: "permitted",
  autoInstall: "allowed",
};

function randomDigest(): string {
  return `sha256:${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
}

describe("versioned upstream Spack snapshots", () => {
  let db: PgDb;
  let app: Hono;
  let assets: SoftwareAssetService;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    assets = new SoftwareAssetService(db);
    await cleanup(db);
    app = new Hono();
    app.onError(createErrorHandler(pino({ level: "silent" })));
    app.route(
      "/api",
      createSpackCatalogRoutes(new SpackCatalogService(db, assets), {
        allowTestHeader: true,
      }),
    );
  });

  afterAll(async () => {
    await cleanup(db);
  });

  test("creates one immutable public revision with grants, projection, and audit", async () => {
    const name = `${NAME_PREFIX}success`;
    await seedUpstream(db, assets, name, ["1.3.1", "1.3"]);

    const first = await snapshot(app, name, "1.3.1", PLATFORM_HEADERS);
    expect(first.status).toBe(201);
    const created = await readSnapshotResponse(first);
    expect(created.created).toBe(true);
    expect(created.asset).toMatchObject({
      name,
      version: "1.3.1",
      source: "official-upstream",
      lifecycle: "published",
      visibility: "platform-public",
      trustedForGlobalUse: true,
    });
    expect(created.revision).toMatchObject({
      revision: 1,
      payload: {
        kind: "spack-package",
        spack: { packageName: name, defaultSpec: `${name}@1.3.1` },
      },
      provenance: {
        source: "official-upstream",
        snapshot: "versioned-upstream",
        upstreamName: name,
        upstreamVersion: "1.3.1",
      },
    });

    const [revisions, grants, outbox, audits] = await Promise.all([
      db
        .select()
        .from(softwareAssetRevisions)
        .where(eq(softwareAssetRevisions.assetId, created.asset.id)),
      db
        .select()
        .from(softwareAssetGrants)
        .where(eq(softwareAssetGrants.assetId, created.asset.id)),
      db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, created.asset.id)),
      db.select().from(auditLog).where(eq(auditLog.target, created.asset.id)),
    ]);
    expect(revisions).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      subjectKind: "platform",
      subjectId: "platform",
      capabilities: ["install", "use", "view"],
    });
    expect(outbox).toHaveLength(4);
    expect(outbox.map((row) => row.relation).sort()).toEqual([
      "installer",
      "platform",
      "user",
      "viewer",
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("software.asset.snapshot_upstream_version");

    const repeated = await snapshot(app, name, "1.3.1", SUPER_HEADERS);
    expect(repeated.status).toBe(200);
    const existing = await readSnapshotResponse(repeated);
    expect(existing).toMatchObject({
      created: false,
      asset: { id: created.asset.id },
      revision: { id: created.revision.id },
    });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.target, created.asset.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, created.asset.id)),
    ).toHaveLength(4);
  });

  test("serializes concurrent requests onto the same asset and revision", async () => {
    const name = `${NAME_PREFIX}concurrent`;
    await seedUpstream(db, assets, name, ["2.0.0"]);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => snapshot(app, name, "2.0.0", PLATFORM_HEADERS)),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
    const bodies = await Promise.all(responses.map(readSnapshotResponse));
    expect(new Set(bodies.map((body) => body.asset.id))).toHaveProperty("size", 1);
    expect(new Set(bodies.map((body) => body.revision.id))).toHaveProperty("size", 1);
  });

  test("rejects org administrators and ordinary publishers", async () => {
    const name = `${NAME_PREFIX}role`;
    await seedUpstream(db, assets, name, ["1.0.0"]);

    for (const headers of [ORG_ADMIN_HEADERS, USER_HEADERS]) {
      const response = await snapshot(app, name, "1.0.0", headers);
      expect(response.status).toBe(403);
    }
    expect(await findTargetAssets(db, name, "1.0.0")).toHaveLength(0);
  });

  test("rejects missing packages, unknown versions, and aliases", async () => {
    const name = `${NAME_PREFIX}versions`;
    await seedUpstream(db, assets, name, ["1.3.1"]);

    expect((await snapshot(app, `${NAME_PREFIX}missing`, "1.3.1", PLATFORM_HEADERS)).status).toBe(
      404,
    );
    expect((await snapshot(app, name, "1.3", PLATFORM_HEADERS)).status).toBe(422);
    expect((await snapshot(app, name, "v1.3.1", PLATFORM_HEADERS)).status).toBe(422);
  });

  test("rejects a malformed source revision", async () => {
    const name = `${NAME_PREFIX}malformed`;
    const [source] = await db
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name,
        version: "upstream",
        source: "official-upstream",
        lifecycle: "published",
        visibility: "platform-public",
        trustedForGlobalUse: true,
        payload: { kind: "spack-package", spack: { packageName: "wrong" } },
        provenance: { source: "official-upstream" },
      })
      .returning();
    if (!source) throw new Error("source insert failed");
    await db.insert(softwareAssetRevisions).values({
      assetId: source.id,
      revision: 1,
      payload: { kind: "spack-package", spack: { packageName: "wrong" } },
      provenance: { source: "official-upstream" },
    });

    expect((await snapshot(app, name, "1.0.0", PLATFORM_HEADERS)).status).toBe(422);
    expect(await findTargetAssets(db, name, "1.0.0")).toHaveLength(0);
  });

  test("does not snapshot a revoked or hidden upstream source", async () => {
    const name = `${NAME_PREFIX}inactive`;
    const source = await seedUpstream(db, assets, name, ["1.0.0"]);
    await db
      .update(softwareAssets)
      .set({ lifecycle: "revoked", visibility: "hidden" })
      .where(eq(softwareAssets.id, source.id));

    expect((await snapshot(app, name, "1.0.0", PLATFORM_HEADERS)).status).toBe(422);
    expect(await findTargetAssets(db, name, "1.0.0")).toHaveLength(0);
  });

  test("rejects an idempotent replay after the upstream source becomes inactive", async () => {
    const name = `${NAME_PREFIX}inactive-replay`;
    const source = await seedUpstream(db, assets, name, ["1.0.0"]);
    const created = await readSnapshotResponse(
      await snapshot(app, name, "1.0.0", PLATFORM_HEADERS),
    );
    await db
      .update(softwareAssets)
      .set({ lifecycle: "revoked", visibility: "hidden" })
      .where(eq(softwareAssets.id, source.id));

    expect((await snapshot(app, name, "1.0.0", PLATFORM_HEADERS)).status).toBe(422);

    const [target, revisions, grants, outbox, audits] = await Promise.all([
      findTargetAssets(db, name, "1.0.0"),
      db
        .select()
        .from(softwareAssetRevisions)
        .where(eq(softwareAssetRevisions.assetId, created.asset.id)),
      db
        .select()
        .from(softwareAssetGrants)
        .where(eq(softwareAssetGrants.assetId, created.asset.id)),
      db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, created.asset.id)),
      db.select().from(auditLog).where(eq(auditLog.target, created.asset.id)),
    ]);
    expect(target).toMatchObject([
      {
        id: created.asset.id,
        lifecycle: "published",
        visibility: "platform-public",
      },
    ]);
    expect(revisions).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(outbox).toHaveLength(4);
    expect(audits).toHaveLength(1);
  });

  test("does not rewrite an existing conflicting identity", async () => {
    const name = `${NAME_PREFIX}conflict`;
    await seedUpstream(db, assets, name, ["1.0.0"]);
    const [target] = await db
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name,
        version: "1.0.0",
        source: "official-upstream",
        lifecycle: "published",
        visibility: "platform-public",
        trustedForGlobalUse: true,
        payload: {
          kind: "spack-package",
          spack: { packageName: name, defaultSpec: name },
        },
        provenance: { source: "official-upstream" },
      })
      .returning();
    if (!target) throw new Error("target insert failed");
    await db.insert(softwareAssetRevisions).values({
      assetId: target.id,
      revision: 1,
      payload: target.payload,
      provenance: target.provenance,
    });

    expect((await snapshot(app, name, "1.0.0", PLATFORM_HEADERS)).status).toBe(409);
    const [unchanged] = await db
      .select()
      .from(softwareAssets)
      .where(eq(softwareAssets.id, target.id));
    expect(unchanged?.payload).toEqual(target.payload);
  });

  test("atomically archives an expected legacy fixture and creates the governed snapshot", async () => {
    const name = `${NAME_PREFIX}supersede`;
    await seedUpstream(db, assets, name, ["1.3.1"]);
    const legacy = await seedLegacyTarget(db, name, "1.3.1");
    const reason = "Replace the direct-SQL smoke fixture with a governed snapshot";

    const response = await supersede(app, name, "1.3.1", legacy, reason, PLATFORM_HEADERS);
    expect(response.status).toBe(201);
    const created = await readSupersessionResponse(response);
    expect(created).toMatchObject({
      created: true,
      legacy: {
        asset: { id: legacy.asset.id, lifecycle: "archived", visibility: "hidden" },
        revisionId: legacy.revision.id,
      },
      snapshot: {
        created: true,
        asset: {
          name,
          version: "1.3.1",
          source: "official-upstream",
          lifecycle: "published",
        },
        revision: {
          revision: 1,
          payload: {
            kind: "spack-package",
            spack: { packageName: name, defaultSpec: `${name}@1.3.1` },
          },
        },
      },
    });

    const [archived] = await db
      .select()
      .from(softwareAssets)
      .where(eq(softwareAssets.id, legacy.asset.id));
    expect(archived?.payload).toEqual(legacy.asset.payload);
    expect(archived?.provenance).toEqual(legacy.asset.provenance);
    expect(archived?.reviewState).toMatchObject({
      fixture: "direct-sql-smoke",
      upstreamVersionSupersession: {
        kind: "versioned-upstream",
        canonicalIdentity: `official-upstream/${name}/1.3.1`,
        legacyRevisionId: legacy.revision.id,
        replacementAssetId: created.snapshot.asset.id,
        replacementRevisionId: created.snapshot.revision.id,
        reason,
      },
    });
    const legacyRevisions = await db
      .select()
      .from(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.assetId, legacy.asset.id));
    expect(legacyRevisions).toEqual([legacy.revision]);
    expect(
      await db
        .select()
        .from(softwareAssetGrants)
        .where(eq(softwareAssetGrants.assetId, legacy.asset.id)),
    ).toHaveLength(0);

    const legacyOutbox = await db
      .select()
      .from(authzOutbox)
      .where(eq(authzOutbox.resourceId, legacy.asset.id));
    expect(legacyOutbox.map((row) => [row.relation, row.operation]).sort()).toEqual([
      ["installer", "delete"],
      ["platform", "create"],
      ["user", "delete"],
      ["viewer", "delete"],
    ]);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.target, legacy.asset.id)),
    ).toMatchObject([{ action: "software.asset.supersede_legacy_upstream_version" }]);

    const snapshotReplay = await snapshot(app, name, "1.3.1", SUPER_HEADERS);
    expect(snapshotReplay.status).toBe(200);
    expect(await readSnapshotResponse(snapshotReplay)).toMatchObject({
      created: false,
      asset: { id: created.snapshot.asset.id },
    });
    const supersessionReplay = await supersede(app, name, "1.3.1", legacy, reason, SUPER_HEADERS);
    expect(supersessionReplay.status).toBe(200);
    expect(await readSupersessionResponse(supersessionReplay)).toMatchObject({
      created: false,
      legacy: { asset: { id: legacy.asset.id } },
      snapshot: { asset: { id: created.snapshot.asset.id } },
    });
    expect(
      await db
        .select()
        .from(auditLog)
        .where(inArray(auditLog.target, [legacy.asset.id, created.snapshot.asset.id])),
    ).toHaveLength(2);
  });

  test("serializes concurrent legacy supersession requests", async () => {
    const name = `${NAME_PREFIX}supersede-concurrent`;
    await seedUpstream(db, assets, name, ["2.0.0"]);
    const legacy = await seedLegacyTarget(db, name, "2.0.0");
    const reason = "Concurrent migration";

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        supersede(app, name, "2.0.0", legacy, reason, PLATFORM_HEADERS),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
    const bodies = await Promise.all(responses.map(readSupersessionResponse));
    expect(new Set(bodies.map((body) => body.snapshot.asset.id))).toHaveProperty("size", 1);
    expect(await findTargetAssets(db, name, "2.0.0")).toHaveLength(2);
  });

  test("rejects snapshot and supersession replay after archived legacy provenance changes", async () => {
    const name = `${NAME_PREFIX}supersede-mutated-replay`;
    await seedUpstream(db, assets, name, ["1.0.0"]);
    const legacy = await seedLegacyTarget(db, name, "1.0.0");
    const reason = "Preserve immutable legacy history";
    const created = await readSupersessionResponse(
      await supersede(app, name, "1.0.0", legacy, reason, PLATFORM_HEADERS),
    );
    const relatedIds = [legacy.asset.id, created.snapshot.asset.id];
    const before = await migrationSideEffectCounts(db, relatedIds);
    await db
      .update(softwareAssets)
      .set({ provenance: { ...legacy.asset.provenance, upstreamRef: "v9.9.9" } })
      .where(eq(softwareAssets.id, legacy.asset.id));

    expect((await snapshot(app, name, "1.0.0", PLATFORM_HEADERS)).status).toBe(409);
    expect(await migrationSideEffectCounts(db, relatedIds)).toEqual(before);
    expect((await supersede(app, name, "1.0.0", legacy, reason, PLATFORM_HEADERS)).status).toBe(
      409,
    );
    expect(await migrationSideEffectCounts(db, relatedIds)).toEqual(before);
  });

  test("rejects snapshot replay after the archived legacy revision payload changes", async () => {
    const name = `${NAME_PREFIX}supersede-revision-mutated-replay`;
    await seedUpstream(db, assets, name, ["1.0.0"]);
    const legacy = await seedLegacyTarget(db, name, "1.0.0");
    const reason = "Preserve the immutable legacy revision";
    const created = await readSupersessionResponse(
      await supersede(app, name, "1.0.0", legacy, reason, PLATFORM_HEADERS),
    );
    const relatedIds = [legacy.asset.id, created.snapshot.asset.id];
    const before = await migrationSideEffectCounts(db, relatedIds);
    await db
      .update(softwareAssetRevisions)
      .set({
        payload: {
          kind: "spack-package",
          spack: {
            packageName: name,
            metadata: { fixture: "scheduler-governed-workflow-smoke" },
            defaultSpec: `${name}@9.9.9`,
            dependencies: [],
            providers: [],
            variants: [],
          },
        },
      })
      .where(eq(softwareAssetRevisions.id, legacy.revision.id));

    expect((await snapshot(app, name, "1.0.0", PLATFORM_HEADERS)).status).toBe(409);
    expect(await migrationSideEffectCounts(db, relatedIds)).toEqual(before);
  });

  test("rejects snapshot and supersession replay after the archived legacy asset acquires a grant", async () => {
    const name = `${NAME_PREFIX}supersede-granted-replay`;
    await seedUpstream(db, assets, name, ["1.0.0"]);
    const legacy = await seedLegacyTarget(db, name, "1.0.0");
    const reason = "Preserve the grant-free legacy fixture";
    const created = await readSupersessionResponse(
      await supersede(app, name, "1.0.0", legacy, reason, PLATFORM_HEADERS),
    );
    await db.insert(softwareAssetGrants).values({
      assetId: legacy.asset.id,
      subjectKind: "platform",
      subjectId: "platform",
      capabilities: ["view"],
    });
    const relatedIds = [legacy.asset.id, created.snapshot.asset.id];
    const before = await migrationSideEffectCounts(db, relatedIds);

    expect((await snapshot(app, name, "1.0.0", PLATFORM_HEADERS)).status).toBe(409);
    expect(await migrationSideEffectCounts(db, relatedIds)).toEqual(before);
    expect((await supersede(app, name, "1.0.0", legacy, reason, PLATFORM_HEADERS)).status).toBe(
      409,
    );
    expect(await migrationSideEffectCounts(db, relatedIds)).toEqual(before);
  });

  test("rejects unauthorized, mismatched, and granted legacy assets without mutation", async () => {
    const name = `${NAME_PREFIX}supersede-guard`;
    await seedUpstream(db, assets, name, ["1.0.0"]);
    const legacy = await seedLegacyTarget(db, name, "1.0.0");

    expect((await supersede(app, name, "1.0.0", legacy, "Denied", USER_HEADERS)).status).toBe(403);
    expect(
      (
        await supersede(
          app,
          name,
          "1.0.0",
          { ...legacy, revision: { ...legacy.revision, id: crypto.randomUUID() } },
          "Wrong revision",
          PLATFORM_HEADERS,
        )
      ).status,
    ).toBe(409);
    await db.insert(softwareAssetGrants).values({
      assetId: legacy.asset.id,
      subjectKind: "platform",
      subjectId: "platform",
      capabilities: ["view"],
    });
    expect(
      (await supersede(app, name, "1.0.0", legacy, "Grant exists", PLATFORM_HEADERS)).status,
    ).toBe(409);

    const [unchanged] = await db
      .select()
      .from(softwareAssets)
      .where(eq(softwareAssets.id, legacy.asset.id));
    expect(unchanged).toMatchObject({ lifecycle: "published", visibility: "platform-public" });
    expect(await findTargetAssets(db, name, "1.0.0")).toHaveLength(1);
  });

  test("fails closed if a snapshot has acquired a second revision", async () => {
    const name = `${NAME_PREFIX}appended`;
    await seedUpstream(db, assets, name, ["1.0.0"]);
    const created = await readSnapshotResponse(
      await snapshot(app, name, "1.0.0", PLATFORM_HEADERS),
    );
    await db.insert(softwareAssetRevisions).values({
      assetId: created.asset.id,
      revision: 2,
      payload: created.revision.payload,
      provenance: created.revision.provenance,
    });

    expect((await snapshot(app, name, "1.0.0", PLATFORM_HEADERS)).status).toBe(409);
  });
});

async function seedUpstream(
  db: PgDb,
  assets: SoftwareAssetService,
  name: string,
  versions: string[],
) {
  const upstream = await assets.upsertAsset({
    kind: "spack-package",
    name,
    version: "upstream",
    source: "official-upstream",
    lifecycle: "published",
    visibility: "platform-public",
    trustedForGlobalUse: true,
    payload: {
      kind: "spack-package",
      spack: {
        packageName: name,
        metadata: { versions },
        defaultSpec: name,
        dependencies: [],
        providers: [],
        variants: [],
      },
    },
    provenance: { source: "official-upstream", upstreamName: name },
  });
  for (const version of versions) {
    const payload = {
      kind: "spack-package" as const,
      spack: {
        packageName: name,
        metadata: {},
        defaultSpec: `${name}@${version}`,
        dependencies: [],
        providers: [],
        variants: [],
      },
    };
    const [policyAsset] = await db
      .insert(softwareAssets)
      .values({
        kind: "spack-package",
        name,
        version,
        source: "platform-fork",
        lifecycle: "published",
        visibility: "platform-public",
        trustedForGlobalUse: true,
        payload,
        provenance: { source: "official-upstream", testPolicySource: true },
      })
      .returning();
    if (!policyAsset) throw new Error("policy asset insert failed");
    const [policyRevision] = await db
      .insert(softwareAssetRevisions)
      .values({
        assetId: policyAsset.id,
        revision: 1,
        payload,
        provenance: policyAsset.provenance,
      })
      .returning();
    if (!policyRevision) throw new Error("policy revision insert failed");
    const [release] = await db
      .insert(ecosystemReleases)
      .values({
        releaseKey: `${name}-${version}`,
        version: "1",
        artifactDigest: randomDigest(),
        manifest: {},
        provenance: { source: "test" },
        signature: "test-signature",
        signingKeyId: "test-key",
        status: "active",
        importedBy: "snapshot-test",
      })
      .returning();
    if (!release) throw new Error("policy release insert failed");
    await db.insert(ecosystemReleaseAssets).values({
      releaseId: release.id,
      ecosystemKey: `software/${name}/${version}`,
      kind: "spack-package",
      name,
      version,
      payload,
      provenance: { source: "official-upstream" },
      licensePolicy: OPEN_LICENSE,
      manifestEntryDigest: randomDigest(),
      assetId: policyAsset.id,
      assetRevisionId: policyRevision.id,
      materializedAt: new Date(),
    });
  }
  return upstream;
}

async function seedLegacyTarget(db: PgDb, name: string, version: string) {
  const payload = {
    kind: "spack-package" as const,
    spack: {
      packageName: name,
      metadata: { fixture: "scheduler-governed-workflow-smoke" },
      defaultSpec: `${name}@${version}`,
      dependencies: [],
      providers: [],
      variants: [],
    },
  };
  const provenance = {
    source: "official-upstream",
    upstreamName: name,
    upstreamRef: `v${version}`,
  };
  const [asset] = await db
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
      reviewState: { fixture: "direct-sql-smoke" },
    })
    .returning();
  if (!asset) throw new Error("legacy target insert failed");
  const [revision] = await db
    .insert(softwareAssetRevisions)
    .values({
      assetId: asset.id,
      revision: 1,
      payload,
      provenance,
    })
    .returning();
  if (!revision) throw new Error("legacy revision insert failed");
  return { asset, revision };
}

async function snapshot(app: Hono, name: string, version: string, headers: Record<string, string>) {
  return app.request(
    `/api/spack/catalog/upstream/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/snapshot`,
    { method: "POST", headers },
  );
}

async function supersede(
  app: Hono,
  name: string,
  version: string,
  legacy: Awaited<ReturnType<typeof seedLegacyTarget>>,
  reason: string,
  headers: Record<string, string>,
) {
  return app.request(
    `/api/spack/catalog/upstream/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}/supersede-legacy`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        legacyAssetId: legacy.asset.id,
        legacyRevisionId: legacy.revision.id,
        reason,
      }),
    },
  );
}

async function readSnapshotResponse(response: Response) {
  return (await response.json()) as {
    created: boolean;
    asset: {
      id: string;
      name: string;
      version: string;
      source: string;
      lifecycle: string;
      visibility: string;
      trustedForGlobalUse: boolean;
    };
    revision: {
      id: string;
      revision: number;
      payload: Record<string, unknown>;
      provenance: Record<string, unknown>;
    };
  };
}

async function readSupersessionResponse(response: Response) {
  return (await response.json()) as {
    created: boolean;
    legacy: {
      asset: {
        id: string;
        lifecycle: string;
        visibility: string;
      };
      revisionId: string;
    };
    snapshot: Awaited<ReturnType<typeof readSnapshotResponse>>;
  };
}

function principalHeaders(role: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Test-Principal": JSON.stringify({ sub: `${role}@snapshot.test`, role, orgIds: [] }),
  };
}

function findTargetAssets(db: PgDb, name: string, version: string) {
  return db
    .select()
    .from(softwareAssets)
    .where(
      and(
        eq(softwareAssets.kind, "spack-package"),
        eq(softwareAssets.name, name),
        eq(softwareAssets.version, version),
        eq(softwareAssets.source, "official-upstream"),
      ),
    );
}

async function migrationSideEffectCounts(
  db: PgDb,
  assetIds: string[],
): Promise<{ audits: number; outbox: number }> {
  const [audits, outbox] = await Promise.all([
    db.select().from(auditLog).where(inArray(auditLog.target, assetIds)),
    db.select().from(authzOutbox).where(inArray(authzOutbox.resourceId, assetIds)),
  ]);
  return { audits: audits.length, outbox: outbox.length };
}

async function cleanup(db: PgDb): Promise<void> {
  const rows = await db
    .select({ id: softwareAssets.id })
    .from(softwareAssets)
    .where(like(softwareAssets.name, `${NAME_PREFIX}%`));
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.delete(auditLog).where(inArray(auditLog.target, ids));
    await tx.delete(authzOutbox).where(inArray(authzOutbox.resourceId, ids));
    await tx.delete(ecosystemReleaseAssets).where(inArray(ecosystemReleaseAssets.assetId, ids));
    await tx.delete(ecosystemReleases).where(like(ecosystemReleases.releaseKey, `${NAME_PREFIX}%`));
    await tx.delete(softwareAssets).where(inArray(softwareAssets.id, ids));
  });
}
