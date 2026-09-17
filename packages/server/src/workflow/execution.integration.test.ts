import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createPgDb,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
  usecasePackages,
} from "@kuintessence/db";
import type { JobSubmission } from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { createDbPackageStore } from "./db-package-store";
import { createPackageResolver } from "./package-resolver";
import { createWorkflowRunner } from "./runner";

const DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const PKG_ID = "11111111-2222-3333-4444-555555555555";
const SOFTWARE_ASSET_ID = "11111111-2222-4333-8444-555555555556";
const SOFTWARE_REVISION_ID = "11111111-2222-4333-8444-555555555557";

const spec = {
  description: "OpenFOAM integration fixture",
  domain: "CFD",
  tags: ["CFD"],
  citations: [],
  softwareRef: { source: "official-upstream", name: "openfoam", version: "2312" },
  inputs: [],
  outputs: [],
  resources: {},
  materialMappings: [],
  licenseRequirements: [],
  usecase: {
    commandFile: "simpleFoam",
    inputSlots: [
      {
        kind: "Text",
        descriptor: "endTime",
        refMaterials: [{ kind: "ArgRef", descriptor: "endTime", sort: 0 }],
      },
    ],
  },
  software: { kind: "Spack", name: "openfoam", argumentList: [] },
  arguments: [{ descriptor: "endTime", valueFormat: "-endTime {}" }],
  environments: [],
  filesomeInputs: [],
  valueOutputs: [
    {
      descriptor: "residual",
      type: "double",
      from: { collectedOutDescriptor: "log" },
      extract: { kind: "Regex", pattern: "r=([0-9.]+)", group: 1 },
    },
  ],
};

describe("workflow execution — real DB package resolution → materialize → extract", () => {
  let db: PgDb;

  beforeAll(async () => {
    db = createPgDb(DB_URL);
    await db.delete(usecasePackages).where(eq(usecasePackages.id, PKG_ID));
    await db
      .delete(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.id, SOFTWARE_REVISION_ID));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, SOFTWARE_ASSET_ID));
    await db.insert(softwareAssets).values({
      id: SOFTWARE_ASSET_ID,
      kind: "spack-package",
      source: "official-upstream",
      name: "openfoam",
      version: "2312",
    });
    await db.insert(softwareAssetRevisions).values({
      id: SOFTWARE_REVISION_ID,
      assetId: SOFTWARE_ASSET_ID,
      revision: 1,
      payload: {
        kind: "spack-package",
        spack: { packageName: "openfoam", defaultSpec: "openfoam@2312" },
      },
      recipeSha256: "a".repeat(64),
    });
    await db
      .insert(usecasePackages)
      .values({ id: PKG_ID, name: "openfoam-solve", version: "1", spec });
  });

  afterAll(async () => {
    await db.delete(usecasePackages).where(eq(usecasePackages.id, PKG_ID));
    await db
      .delete(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.id, SOFTWARE_REVISION_ID));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, SOFTWARE_ASSET_ID));
  });

  test("resolves a stored package and runs the workflow end-to-end", async () => {
    let captured: JobSubmission | undefined;
    const runner = createWorkflowRunner({
      resolvePackage: createPackageResolver(createDbPackageStore(db)),
      submitJob: async (spec_) => {
        captured = spec_;
        return { jobId: "job-int-1", status: "completed", collected: { log: "final r=0.003" } };
      },
    });

    const result = await runner(`
name: real-db
parameters:
  - { name: endTime, type: string, default: "500" }
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: solve
      name: solve
      usecaseVersionId: ${PKG_ID}
      softwareVersionId: ${SOFTWARE_REVISION_ID}
      inputSlots:
        - { type: Text, descriptor: endTime, from: { expr: "params.endTime" } }
`);

    // materialize built the command from the stored package + bound slot value
    expect(captured?.command).toBe(
      'eval "$(spack load --sh openfoam@2312)" && simpleFoam -endTime 500',
    );
    expect(captured?.usecasePackageId).toBe(PKG_ID);
    // extractValues pulled the typed value from the (faked) collected output
    expect(result.status.solve).toBe("Succeeded");
    expect(result.values.solve?.values.residual).toBe(0.003);
  });
});
