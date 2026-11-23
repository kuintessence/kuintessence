import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agents,
  auditLog,
  auditRelease,
  createPgDb,
  licensedMaterialMappings,
  licenseEntitlementClaims,
  ociRepository,
  orgs,
  softwareAssets,
  users,
} from "@kuintessence/db";
import { OfflineDeliverySchema } from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createOfflineDeliveryRoutes } from "../routes/offline-deliveries";
import { FilesystemBlobStore } from "./blob-store";
import { parseNamespace } from "./namespace";
import { OfflineDeliveryService } from "./offline-delivery";
import { OfflineDeliveryBinaries } from "./offline-delivery-binaries";
import { PgDeliveryReceipts } from "./offline-delivery-receipts";
import { seedOfflineDelivery } from "./offline-delivery-seed";
import { RecipeGitStore } from "./recipe-git-store";
import { DrizzleAuditPort, RegistryService } from "./registry-service";
import { materialDigest } from "./spack-material-storage";
import { SpackMaterialStore } from "./spack-material-store";

test("offline binaries publish verified pairs and OCI layers; local vendor claims stay live on replay", async () => {
  const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");
  const locks = createPgDb(
    process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence",
    { max: 1 },
  );
  const root = await mkdtemp(join(tmpdir(), "kq-delivery-binaries-"));
  const org = randomUUID(),
    actorId = randomUUID(),
    asset = randomUUID(),
    mapping = randomUUID(),
    claim = randomUUID();
  const repository = `org/${org}/binaries`;
  const ns = parseNamespace(repository);
  const agent = `delivery-${org}`;
  const actor = { sub: actorId, role: "org_admin" as const, orgIds: [org], suspended: false };
  const restricted = {
    id: "local",
    kind: "vendor-local",
    dependsOn: ["cache"],
    mappingId: mapping,
    licenseSubject: "vendor-example",
    fingerprint: materialDigest(Buffer.from("kept at the provider")),
  };
  const license = {
    classification: "proprietary",
    identifiers: [{ kind: "custom", value: "Example Agreement" }],
    provenance: { source: "official-upstream", reference: "example terms" },
    redistribution: "permitted",
    providerEntitlements: [],
    consumerEntitlements: [],
    acceptanceRequired: false,
  };
  const installer = Buffer.from(`synthetic installer ${org}`);
  const archive = Buffer.from(`synthetic buildcache ${org}`);
  const hash = org.replaceAll("-", "");
  const metadata = Buffer.from(
    JSON.stringify({
      spec: {
        nodes: [
          {
            name: "hello",
            version: "1.2",
            hash,
            arch: { platform: "linux", platform_os: "demo", target: { name: "x86_64" } },
          },
        ],
      },
      binary_cache_checksum: { hash_algorithm: "sha256", hash: materialDigest(archive).slice(7) },
    }),
  );
  const parts = new Map([
    ["installer.bin", installer],
    ["hello.spack", archive],
    ["hello.spec.json", metadata],
  ]);
  const files = [...parts].map(([path, bytes]) => ({
    path,
    blob: { digest: materialDigest(bytes), size: bytes.length },
  }));
  const vendor = {
    id: "vendor",
    kind: "vendor-binary",
    file: "installer.bin",
    licensePolicy: license,
  };
  const cache = {
    id: "cache",
    kind: "buildcache",
    metadata: "hello.spec.json",
    archive: "hello.spack",
    licensePolicy: license,
  };
  const plan = OfflineDeliverySchema.parse({
    version: 1,
    name: "binary-shipment",
    release: "1",
    repository,
    files,
    items: [vendor, cache, restricted],
  });
  const recipes = new RecipeGitStore(join(root, "recipes"));
  const materials = new SpackMaterialStore(join(root, "materials"), recipes);
  const binaryStore = new FilesystemBlobStore(join(root, "oci"));
  const audit = new DrizzleAuditPort(db);
  const registry = new RegistryService(db, binaryStore, audit);
  const unused = async (): Promise<never> => {
    throw new Error("unexpected operation");
  };
  const service = new OfflineDeliveryService({
    recipes,
    materials,
    binaries: new OfflineDeliveryBinaries(db, registry, materials),
    ecosystem: { stage: unused, activate: unused },
    bindings: { inspect: unused, change: unused },
    trustedKeys: {},
    receipts: new PgDeliveryReceipts(db, locks),
    resolvePrincipal: async (id) => (id === actorId ? actor : null),
  });
  const app = new Hono().route(
    "/api",
    createOfflineDeliveryRoutes(service, { allowTestHeader: true }),
  );
  const verify = (body: unknown) =>
    app.request("/api/offline-deliveries/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Principal": JSON.stringify(actor) },
      body: JSON.stringify(body),
    });
  let published: string | undefined;
  try {
    await db.insert(orgs).values({ id: org, name: "binary delivery" });
    await db
      .insert(users)
      .values({ id: actorId, email: `${actorId}@example.invalid`, role: "org_admin" });
    await db.insert(agents).values({
      agentId: agent,
      siteName: "test",
      providerOrgId: org,
      schedulerType: "slurm",
      schedulerVersion: "test",
    });
    await db.insert(softwareAssets).values({
      id: asset,
      name: "example",
      version: "1",
      kind: "site-runtime",
      source: "official-upstream",
      lifecycle: "published",
    });
    await db.insert(licensedMaterialMappings).values({
      id: mapping,
      agentId: agent,
      assetId: asset,
      providerOrgId: org,
      selector: "example-installer",
      licenseSubject: restricted.licenseSubject,
      materialName: "example",
      materialVersion: "1",
      elementSet: [],
      fingerprint: restricted.fingerprint,
      status: "active",
      createdBy: actorId,
    });
    expect((await verify(plan)).status).toBe(403);
    await db.insert(licenseEntitlementClaims).values({
      id: claim,
      licenseSubject: restricted.licenseSubject,
      assetId: asset,
      entitlement: "provider-source-install",
      claimantKind: "org",
      claimantId: org,
      evidenceReference: "example",
      evidenceSummary: "fixture",
      submittedBy: actorId,
      status: "approved",
    });
    expect(
      (
        await verify({
          ...plan,
          items: [vendor],
          files: [{ ...files[0], blob: { digest: restricted.fingerprint, size: 64 } }],
        })
      ).status,
    ).toBe(403);
    expect((await verify(plan)).status).toBe(200);
    expect(
      (
        await verify({
          ...plan,
          items: [{ ...restricted, dependsOn: [], fingerprint: files[0]?.blob.digest }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await verify({
          ...plan,
          items: [{ ...cache, licensePolicy: { ...license, redistribution: "restricted" } }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await verify({
          ...plan,
          items: [{ ...vendor, licensePolicy: { ...license, consumerEntitlements: ["use"] } }],
        })
      ).status,
    ).toBe(422);
    expect((await verify({ ...plan, repository: `org/${randomUUID()}/other` })).status).toBe(403);
    const inputDirectory = join(root, "input");
    await mkdir(inputDirectory);
    const input = join(inputDirectory, "delivery.json");
    for (const [name, bytes] of parts) await writeFile(join(inputDirectory, name), bytes);
    await writeFile(input, JSON.stringify(plan));
    const original = audit.recordPush.bind(audit);
    const injected = spyOn(audit, "recordPush").mockImplementation(async (request, tx) => {
      if (request.resourceKind === "spack-package") throw new Error("interrupted before commit");
      return original(request, tx);
    });
    try {
      const partial = await seedOfflineDelivery(service, input, actorId);
      expect(partial.status).toBe("partial");
      expect(partial.items.map((i) => i.code ?? i.status)).toEqual([
        "completed",
        "DELIVERY_ITEM_FAILED",
        "DELIVERY_DEPENDENCY_FAILED",
      ]);
      expect(await registry.listSpackIndex(ns)).toHaveLength(0);
      expect(await binaryStore.exists(materialDigest(archive))).toBe(false);
      expect(await binaryStore.exists(materialDigest(metadata))).toBe(false);
    } finally {
      injected.mockRestore();
    }
    const response = await app.request("/api/offline-deliveries/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Principal": JSON.stringify(actor) },
      body: JSON.stringify(plan),
    });
    expect(response.status).toBe(200);
    const first = (await response.json()) as Awaited<ReturnType<typeof service.run>>;
    expect(first.items.map((item) => item.code ?? item.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    const receipt = first.items[0]?.receipt as { manifestDigest: string };
    published = receipt.manifestDigest;
    const repo = await registry.findRepository(ns);
    if (!repo) throw new Error("missing vendor repository");
    const manifest = JSON.parse(
      Buffer.from((await registry.getManifestByRef(repo.id, published)).body).toString(),
    );
    expect(manifest.layers[0].digest).toBe(materialDigest(installer));
    expect(
      await new Response(
        (await registry.getBlob(repo.id, manifest.layers[0].digest)).stream,
      ).text(),
    ).toBe(installer.toString());
    expect(
      await new Response((await registry.getBlob(repo.id, manifest.config.digest)).stream).json(),
    ).toMatchObject(license);
    const binary = (kind: "spec" | "tarball") =>
      registry.getSpackArtifact({ ns, package: "hello", hash, kind });
    expect(await new Response((await binary("tarball")).stream).text()).toBe(archive.toString());
    expect(await new Response((await binary("spec")).stream).text()).toBe(metadata.toString());
    expect(await registry.listSpackIndex(ns)).toHaveLength(1);
    expect((await service.preflight(plan, actorId)).items.map((i) => i.status)).toEqual([
      "existing",
      "existing",
      "existing",
    ]);
    const replay = await service.run(plan, actorId);
    expect(replay.items.map((i) => i.receipt)).toEqual(first.items.map((i) => i.receipt));
    for (const [bytes, index] of [
      [archive, 1],
      [installer, 0],
    ] as const) {
      const hex = materialDigest(bytes).slice(7);
      const stored = join(root, "oci", "sha256", hex.slice(0, 2), hex);
      await writeFile(stored, Buffer.alloc(bytes.byteLength, 0));
      expect((await service.preflight(plan, actorId)).items[index]?.status).toBe("conflict");
      await writeFile(stored, bytes);
    }
    const bad = Buffer.from(
      metadata.toString().replace(materialDigest(archive).slice(7), "0".repeat(64)),
    );
    await materials.upload(repository, materialDigest(bad), new Blob([bad]).stream());
    const badPlan = {
      ...plan,
      release: "2",
      files: files.map((f) =>
        f.path === cache.metadata
          ? { ...f, blob: { digest: materialDigest(bad), size: bad.length } }
          : f,
      ),
    };
    expect((await service.run(badPlan, actorId)).items[1]?.code).toBe(
      "DELIVERY_BUILDCACHE_SPEC_INVALID",
    );
    const different = Buffer.from(`${metadata.toString()} `);
    await materials.upload(repository, materialDigest(different), new Blob([different]).stream());
    const conflicting = {
      ...plan,
      release: "3",
      files: files.map((f) =>
        f.path === cache.metadata
          ? { ...f, blob: { digest: materialDigest(different), size: different.length } }
          : f,
      ),
    };
    expect((await service.run(conflicting, actorId)).items[1]?.status).toBe("conflict");
    expect(await new Response((await binary("spec")).stream).text()).toBe(metadata.toString());
    await db
      .update(licenseEntitlementClaims)
      .set({ expiresAt: new Date(0) })
      .where(eq(licenseEntitlementClaims.id, claim));
    expect((await verify(plan)).status).toBe(403);
    await db
      .update(licenseEntitlementClaims)
      .set({ expiresAt: null, revokedAt: new Date(), status: "revoked" })
      .where(eq(licenseEntitlementClaims.id, claim));
    expect((await service.run(plan, actorId)).items[2]?.code).toBe("DELIVERY_VENDOR_SCOPE_DENIED");
  } finally {
    if ((await registry.listSpackIndex(ns)).length)
      await registry.deleteSpackArtifact({ ns, package: "hello", hash, principal: actor });
    const repo = await registry.findRepository(ns);
    if (repo && published)
      await registry.deleteManifest({ repo, ref: published, principal: actor });
    if (repo) await db.delete(ociRepository).where(eq(ociRepository.id, repo.id));
    await db.delete(auditRelease).where(eq(auditRelease.actor, actorId));
    await db.delete(auditLog).where(eq(auditLog.actor, actorId));
    await db.delete(licenseEntitlementClaims).where(eq(licenseEntitlementClaims.id, claim));
    await db.delete(agents).where(eq(agents.agentId, agent));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, asset));
    await db.delete(users).where(eq(users.id, actorId));
    await db.delete(orgs).where(eq(orgs.id, org));
    await Promise.all([
      db.$client.end(),
      locks.$client.end(),
      rm(root, { recursive: true, force: true }),
    ]);
  }
}, 30000);
