import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createPgDb,
  orgs,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
  usecasePackages,
} from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { SoftwareAssetService } from "../services/software-asset-service";
import { UsecasePackageService } from "../services/usecase-package-service";
import { createUsecasePackageRoutes } from "./usecase-packages";

process.env.REGISTRY_ALLOW_TEST_PRINCIPAL = "1";
const PRINCIPAL = JSON.stringify({ sub: "admin@test", role: "platform_admin", orgIds: [] });
const W = { "Content-Type": "application/json", "X-Test-Principal": PRINCIPAL };
const ORG_ADMIN = {
  "Content-Type": "application/json",
  "X-Test-Principal": JSON.stringify({
    sub: "other-org-admin@test",
    role: "org_admin",
    orgIds: [],
  }),
};
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ORG_MEMBER = {
  "Content-Type": "application/json",
  "X-Test-Principal": JSON.stringify({
    sub: "org-admin@test",
    role: "org_admin",
    orgIds: [ORG_ID],
  }),
};

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

const spec = {
  usecase: {
    commandFile: "simpleFoam",
    inputSlots: [],
  },
  software: {
    kind: "Spack",
    name: "openfoam@2312%gcc@13.2.0",
    version: "2312",
    compiler: "gcc@13.2.0",
    moduleName: "openfoam/2312",
    variantRef: "variant-1",
    argumentList: ["+mpi"],
  },
  arguments: [],
  environments: [],
  filesomeInputs: [],
  filesomeOutputs: [],
  valueOutputs: [],
};

const PUBLISHED_SPACK = {
  source: "platform-fork" as const,
  name: "usecaseroute-test-published-spack",
  version: "1.0.0",
};

const publishedSpec = {
  ...spec,
  description: "Published Spack revision contract test.",
  domain: "test",
  tags: [],
  citations: [],
  softwareRef: PUBLISHED_SPACK,
  inputs: [],
  outputs: [],
  resources: {},
  materialMappings: [],
  dataRequirements: [],
  licensedMaterials: [],
  licenseRequirements: [],
};

describe("Usecase package routes", () => {
  let db: PgDb;
  let app: Hono;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    await db
      .insert(orgs)
      .values({ id: ORG_ID, name: "usecaseroute-test-org" })
      .onConflictDoNothing();
    const service = new UsecasePackageService(db, new SoftwareAssetService(db));
    app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.route("/api", createUsecasePackageRoutes(service));
  });

  afterAll(async () => {
    await db.delete(softwareAssets).where(like(softwareAssets.name, "usecaseroute-test-%"));
    await db.delete(usecasePackages).where(like(usecasePackages.name, "usecaseroute-test-%"));
    await db.delete(orgs).where(eq(orgs.id, ORG_ID));
  });

  test("PUT /api/usecase-packages/:id updates a package", async () => {
    const create = await app.request("/api/usecase-packages", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "usecaseroute-test-update",
        version: "0.1.0",
        spec,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/usecase-packages/${created.id}`, {
      method: "PUT",
      headers: W,
      body: JSON.stringify({
        name: "usecaseroute-test-update-renamed",
        version: "0.2.0",
        description: "updated",
        spec: {
          ...spec,
          usecase: { commandFile: "blockMesh", inputSlots: [] },
          software: {
            ...spec.software,
            moduleName: "openfoam/2406",
            variantRef: "variant-2",
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      version: string;
      description: string | null;
      spec: {
        usecase: { commandFile: string };
        software: { moduleName?: string; variantRef?: string };
      };
    };
    expect(body.name).toBe("usecaseroute-test-update-renamed");
    expect(body.id).not.toBe(created.id);
    expect(body.version).toBe("0.2.0");
    expect(body.description).toBe("updated");
    expect(body.spec.usecase.commandFile).toBe("blockMesh");
    expect(body.spec.software.moduleName).toBe("openfoam/2406");
    expect(body.spec.software.variantRef).toBe("variant-2");

    const assets = await db
      .select()
      .from(softwareAssets)
      .where(like(softwareAssets.name, "usecaseroute-test-update%"));
    expect(assets[0]?.kind).toBe("usecase");
    expect(assets.some((asset) => asset.payload?.usecasePackageId === body.id)).toBe(true);
    const old = await app.request(`/api/usecase-packages/${created.id}`);
    expect(old.status).toBe(200);
  });

  test("GET /api/usecase-packages exposes the matching published immutable software revision", async () => {
    await new SoftwareAssetService(db).upsertAsset({
      kind: "spack-package",
      ...PUBLISHED_SPACK,
      lifecycle: "published",
      visibility: "platform-public",
      trustedForGlobalUse: true,
      payload: {
        kind: "spack-package",
        spack: {
          packageName: PUBLISHED_SPACK.name,
          defaultSpec: `${PUBLISHED_SPACK.name}@${PUBLISHED_SPACK.version}`,
          metadata: {},
          dependencies: [],
          providers: [],
          variants: [],
        },
      },
      provenance: { source: "route-test" },
    });
    const create = await app.request("/api/usecase-packages", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "usecaseroute-test-published-revision",
        version: "1.0.0",
        spec: publishedSpec,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };

    const list = await app.request("/api/usecase-packages?q=usecaseroute-test-published-revision");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      usecasePackages: Array<{ id: string; publishedSoftwareRevisionId?: string }>;
    };
    const pkg = body.usecasePackages.find((item) => item.id === created.id);
    expect(pkg?.publishedSoftwareRevisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(pkg?.publishedSoftwareRevisionId).not.toBe(created.id);
    const revisions = await db
      .select({ id: softwareAssetRevisions.id })
      .from(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.id, pkg?.publishedSoftwareRevisionId ?? ""));
    expect(revisions).toHaveLength(1);
  });

  test("org_admin cannot mutate an arbitrary platform package id", async () => {
    const create = await app.request("/api/usecase-packages", {
      method: "POST",
      headers: W,
      body: JSON.stringify({
        name: "usecaseroute-test-platform-scope",
        version: "0.1.0",
        spec,
      }),
    });
    const created = (await create.json()) as { id: string };
    const update = await app.request(`/api/usecase-packages/${created.id}`, {
      method: "PUT",
      headers: ORG_ADMIN,
      body: JSON.stringify({
        name: "usecaseroute-test-platform-scope",
        version: "0.2.0",
        spec,
      }),
    });
    expect(update.status).toBe(403);
  });

  test("reads only the selected organization scope and preserves a hidden detail as 404", async () => {
    const create = await app.request(`/api/usecase-packages?orgId=${ORG_ID}`, {
      method: "POST",
      headers: ORG_MEMBER,
      body: JSON.stringify({
        name: "usecaseroute-test-private-org",
        version: "1.0.0",
        spec,
      }),
    });
    expect(create.status).toBe(201);
    const pkg = (await create.json()) as { id: string };

    const anonymousList = await app.request("/api/usecase-packages?q=private-org");
    expect(anonymousList.status).toBe(200);
    const anonymousBody = (await anonymousList.json()) as { packages: Array<{ id: string }> };
    expect(anonymousBody.packages.some((item) => item.id === pkg.id)).toBe(false);

    const hidden = await app.request(`/api/usecase-packages/${pkg.id}`);
    expect(hidden.status).toBe(404);

    const visible = await app.request(`/api/usecase-packages/${pkg.id}?orgId=${ORG_ID}`, {
      headers: ORG_MEMBER,
    });
    expect(visible.status).toBe(200);

    const wrongScope = await app.request(`/api/usecase-packages/${pkg.id}?orgId=${ORG_ID}`, {
      headers: ORG_ADMIN,
    });
    expect(wrongScope.status).toBe(403);
  });

  test("rejects malformed usecase pagination", async () => {
    for (const query of ["page=2junk", "pageSize=1e3"]) {
      const res = await app.request(`/api/usecase-packages?${query}`);
      expect(res.status).toBe(400);
    }
  });
});
