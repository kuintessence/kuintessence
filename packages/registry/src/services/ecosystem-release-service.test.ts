import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  authzOutbox,
  createPgDb,
  dataAssets,
  dataAssetVersions,
  ecosystemReleaseAssets,
  ecosystemReleases,
  type PgDb,
  softwareAssets,
  usecasePackages,
  workflowTemplates,
} from "@kuintessence/db";
import { SoftwareAssetPayloadSchema } from "@kuintessence/shared";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  canonicalJson,
  type EcosystemBundleAsset,
  type EcosystemManifest,
  EcosystemReleaseService,
  manifestDigest,
  stableDataProductCatalogReference,
  validateEcosystemManifest,
  verifyEcosystemBundle,
} from "./ecosystem-release-service";
import { UsecasePackageService } from "./usecase-package-service";
import { WorkflowTemplateService } from "./workflow-template-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

const OPEN_LICENSE = {
  classification: "open-source",
  identifiers: [{ kind: "spdx", value: "MIT" }],
  provenance: { source: "official-upstream", reference: "https://opensource.org/license/mit" },
  acceptanceRequired: false,
  providerEntitlements: [],
  consumerEntitlements: [],
  autoInstall: "allowed",
  redistribution: "permitted",
};

const VASP_LICENSE = {
  classification: "proprietary",
  identifiers: [{ kind: "custom", value: "VASP-license" }],
  provenance: { source: "official-upstream", reference: "https://www.vasp.at/info/eula/" },
  acceptanceRequired: true,
  providerEntitlements: ["source-access", "install"],
  consumerEntitlements: ["use"],
  autoInstall: "denied",
  redistribution: "prohibited",
};

function dataProductAsset(
  name: string,
  kind: "scientific-dataset" | "reference-data" | "pseudopotential" | "licensed-material",
  selector: string,
  version: string,
  accessMode?: "open" | "entitlement",
): EcosystemBundleAsset {
  const restricted = kind === "licensed-material";
  return {
    ecosystemKey: `data/${selector}`,
    kind: "data-product",
    name,
    version,
    payload: {
      kind: "data-product",
      dataAsset: {
        kind,
        selector,
        version,
        description: `${name} metadata only`,
        tags: ["scientific-ecosystem-v1"],
        accessMode: accessMode ?? (restricted ? "entitlement" : "open"),
        sensitivity: restricted ? "restricted" : "open",
        deliveryPolicy: {
          download: restricted ? "deny" : "allow",
          derive: restricted ? "deny" : "allow",
          redistribution: restricted ? "deny" : "allow",
          crossCenterReplication: restricted ? "deny" : "allow",
          retention: "source-controlled",
        },
        redistribution: restricted ? "prohibited" : "permitted",
        entitlementRequired: restricted,
      },
    },
    provenance: { source: "metadata-catalog" },
    licensePolicy: restricted ? VASP_LICENSE : OPEN_LICENSE,
  };
}

const DATA_PRODUCTS = [
  dataProductAsset(
    "GROMACS molecular system",
    "scientific-dataset",
    "gromacs-molecular-system",
    "2025.1",
  ),
  dataProductAsset("Germline reference", "reference-data", "germline-reference", "2025.1"),
  dataProductAsset("Germline cohort", "scientific-dataset", "germline-cohort", "2025.1"),
  dataProductAsset("QE PSLibrary", "pseudopotential", "qe-pslibrary", "1.0.0"),
  dataProductAsset("VASP POTCAR PBE", "licensed-material", "vasp-potcar-pbe", "2025.1"),
] as const;

const SOFTWARE = [
  ["GROMACS", "gromacs", "2025.2"],
  ["LAMMPS", "lammps", "20250612"],
  ["NAMD", "namd", "3.0.1"],
  ["AmberTools", "amber", "20"],
  ["CP2K", "cp2k", "2025.1"],
  ["Quantum ESPRESSO", "quantum_espresso", "7.4.1"],
  ["NWChem", "nwchem", "7.2.3"],
  ["ABINIT", "abinit", "10.2.7"],
  ["VASP", "vasp", "6.5.1"],
  ["OpenFOAM", "openfoam", "2412"],
  ["WRF", "wrf", "4.6.1"],
  ["Nek5000", "nek5000", "19.0"],
  ["ParaView", "paraview", "5.13.3"],
  ["BWA", "bwa", "0.7.17"],
  ["SAMtools", "samtools", "1.19.2"],
  ["BCFtools", "bcftools", "1.21"],
  ["GATK", "gatk", "4.5.0.0"],
  ["BLAST+", "blast_plus", "2.16.0"],
  ["Salmon", "salmon", "1.10.3"],
  ["R", "r", "4.5.1"],
  ["Julia", "julia", "1.11.5"],
] as const;

function spackAsset(
  name: string,
  packageName: string,
  version: string,
  ecosystemKey = `software/${packageName}`,
): EcosystemBundleAsset {
  return {
    ecosystemKey,
    kind: "spack-package",
    name,
    version,
    payload: {
      kind: "spack-package",
      spack: {
        packageName,
        metadata: {},
        defaultSpec: `${packageName}@${version}`,
        dependencies: [],
        providers: [],
        variants: [],
      },
    },
    provenance: { source: "official-upstream" },
    licensePolicy: name === "VASP" ? VASP_LICENSE : OPEN_LICENSE,
  };
}

function usecaseAsset(software: EcosystemBundleAsset, usecaseIndex: number): EcosystemBundleAsset {
  const spec = {
    description: "Typed scientific usecase",
    domain: "test",
    tags: ["test"],
    citations: [],
    softwareRef: {
      source: "platform-fork",
      name: software.name,
      version: software.version,
    },
    inputs: [],
    outputs: [],
    resources: {},
    materialMappings: [],
    licensedMaterials: [],
    licenseRequirements: [],
    usecase: { commandFile: "run", inputSlots: [] },
    software: {
      kind: "Spack",
      name: software.name,
      version: software.version,
      argumentList: [],
    },
    arguments: [],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
  };
  return {
    ecosystemKey: `usecase/${software.ecosystemKey}/${usecaseIndex}`,
    kind: "usecase",
    name: `${software.name} usecase ${usecaseIndex}`,
    version: "1.0.0",
    payload: {
      kind: "usecase",
      packageRefs: [],
      spec,
    },
    provenance: { source: "test" },
    licensePolicy: OPEN_LICENSE,
    specDigest: `sha256:${createHash("sha256").update(canonicalJson(spec)).digest("hex")}`,
  };
}

function scriptAsset(index: number): EcosystemBundleAsset {
  const content = `import json\nprint(json.dumps({"script": ${index}}))\n`;
  return {
    ecosystemKey: `script/${index}`,
    kind: "sandbox-script",
    name: `Scientific helper ${index}`,
    version: "1.0.0",
    payload: {
      kind: "sandbox-script",
      language: "python",
      runtimeContractRef: { name: "python-3.12-stdlib-v1", version: "1" },
      executionIdentity: { type: "MappedAuto" },
      entrypoint: "main.py",
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      inputs: {},
      outputs: {},
    },
    provenance: { source: "test" },
    licensePolicy: OPEN_LICENSE,
  };
}

function workflowAsset(index: number): EcosystemBundleAsset {
  return {
    ecosystemKey: `workflow/${index}`,
    kind: "workflow-template",
    name: `Scientific workflow ${index}`,
    version: "1.0.0",
    payload: {
      kind: "workflow-template",
      usecaseRefs: [],
      packageRefs: [],
      yamlContent: JSON.stringify({
        name: `workflow-${index}`,
        parameters: [],
        spec: {
          nodeDrafts: [{ id: "noop", name: "noop", type: "NoAction" }],
          nodeRelations: [],
        },
      }),
    },
    provenance: { source: "test" },
    licensePolicy: OPEN_LICENSE,
  };
}

function smallManifest(): EcosystemManifest {
  return {
    schemaVersion: 1,
    releaseKey: "test-ecosystem",
    version: "1.0.0",
    provenance: { source: "test" },
    assets: [spackAsset("Test", "test", "1.0.0")],
  };
}

function scientificManifest(): EcosystemManifest {
  const software = SOFTWARE.map(([name, packageName, version]) =>
    spackAsset(name, packageName, version),
  );
  const usecases = software.flatMap((item, index) =>
    Array.from({ length: index < 16 ? 4 : 3 }, (_, usecaseIndex) =>
      usecaseAsset(item, usecaseIndex + 1),
    ),
  );
  return {
    schemaVersion: 1,
    releaseKey: "scientific-ecosystem",
    version: "1.0.0",
    profile: "scientific-ecosystem-v1",
    provenance: { source: "test" },
    assets: [
      ...software,
      ...usecases,
      ...Array.from({ length: 12 }, (_, index) => scriptAsset(index + 1)),
      ...Array.from({ length: 4 }, (_, index) => workflowAsset(index + 1)),
      ...DATA_PRODUCTS,
    ],
  };
}

describe("Ecosystem release signature and validation", () => {
  test("verifies an Ed25519 signature over canonical manifest JSON", () => {
    const manifest = smallManifest();
    const keys = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
      "base64",
    );
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

    expect(() =>
      verifyEcosystemBundle(
        { manifest, signature, signingKeyId: "test-key" },
        { "test-key": publicKey },
      ),
    ).not.toThrow();
    expect(() =>
      verifyEcosystemBundle(
        { manifest: { ...manifest, version: "1.0.1" }, signature, signingKeyId: "test-key" },
        { "test-key": publicKey },
      ),
    ).toThrow("verification failed");
  });

  test("uses shared schemas for LicensePolicy and SoftwareAssetPayload", () => {
    const manifest = smallManifest();
    const original = manifest.assets[0];
    if (!original) throw new Error("test manifest must contain an asset");
    const withUnknownLicense = {
      ...original,
      licensePolicy: {
        classification: "unknown",
        identifiers: [{ kind: "custom", value: "terms-pending-review" }],
        provenance: { source: "official-upstream", reference: "upstream package metadata" },
        autoInstall: "denied",
      },
    };
    manifest.assets[0] = withUnknownLicense;
    expect(() => validateEcosystemManifest(manifest)).not.toThrow();

    manifest.assets[0] = { ...withUnknownLicense, payload: { kind: "spack-package" } };
    expect(() => validateEcosystemManifest(manifest)).toThrow("SoftwareAssetPayload");
  });

  test("requires VASP to be proprietary and fail closed", () => {
    const manifest = smallManifest();
    manifest.assets[0] = {
      ...spackAsset("VASP", "vasp", "6.5.1"),
      licensePolicy: OPEN_LICENSE,
    };
    expect(() => validateEcosystemManifest(manifest)).toThrow(
      "VASP license policy must be fail-closed",
    );
  });

  test("validates pinned inventory, governed usecases, official scripts, and workflows", () => {
    const manifest = scientificManifest();
    expect(manifest.assets.filter((asset) => asset.kind === "usecase")).toHaveLength(79);
    expect(() => validateEcosystemManifest(manifest)).not.toThrow();
  });

  test("rejects an official script with a concrete runtime profile", () => {
    const manifest = scientificManifest();
    const index = manifest.assets.findIndex((asset) => asset.kind === "sandbox-script");
    const current = manifest.assets[index];
    if (!current) throw new Error("scientific manifest must contain a script");
    manifest.assets[index] = {
      ...current,
      payload: {
        ...current.payload,
        runtimeProfileId: "11111111-1111-4111-8111-111111111111",
      },
    };
    expect(() => validateEcosystemManifest(manifest)).toThrow("no runtimeProfileId");
  });

  test("rejects an unpinned scientific software version", () => {
    const manifest = scientificManifest();
    const index = manifest.assets.findIndex((asset) => asset.name === "GROMACS");
    const current = manifest.assets[index];
    if (!current) throw new Error("scientific manifest must contain GROMACS");
    manifest.assets[index] = {
      ...current,
      payload: {
        kind: "spack-package",
        spack: {
          packageName: "gromacs",
          metadata: {},
          defaultSpec: "gromacs@latest",
          dependencies: [],
          providers: [],
          variants: [],
        },
      },
    };
    expect(() => validateEcosystemManifest(manifest)).toThrow("must pin gromacs@2025.2");
  });
});

describe("Ecosystem release executable catalog materialization", () => {
  let db: PgDb;
  const releaseKey = "ecosystem-materialization-test";
  const reuseReleaseKey = "ecosystem-materialization-reuse-test";
  const usecaseName = "Ecosystem materialized usecase";
  const legacyDigestUsecaseName = "Ecosystem derived digest usecase";
  const reuseUsecaseName = "Ecosystem reused usecase";
  const workflowName = "Ecosystem materialized workflow";
  const reuseWorkflowName = "Ecosystem reused workflow";
  const scriptName = "Ecosystem materialized script";
  const projectionReleaseKey = "ecosystem-authz-projection-aba-test";
  const isolatedReleaseKeys = ["ecosystem-isolation-a-test", "ecosystem-isolation-b-test"];
  const isolatedDataReleaseKeys = [
    "ecosystem-data-isolation-a-test",
    "ecosystem-data-isolation-b-test",
  ];
  const concurrentDataReleaseKeys = isolatedDataReleaseKeys.map((key) => `${key}-concurrent`);
  const legacyDataReleaseKeys = isolatedDataReleaseKeys.map((key) => `${key}-legacy`);
  const dataRemovalReleaseKey = "ecosystem-data-removal-test";
  const projectionReference = stableDataProductCatalogReference({
    kind: "reference-data",
    selector: "ecosystem-authz-projection-aba",
    version: "1.0.0",
  });
  const dataProduct = dataProductAsset(
    "Ecosystem materialized data",
    "reference-data",
    "ecosystem-materialized-reference",
    "1.0.0",
  );
  const dataProductReference = stableDataProductCatalogReference({
    kind: "reference-data",
    selector: "ecosystem-materialized-reference",
    version: "1.0.0",
  });
  const restrictedDataProduct = dataProductAsset(
    "Ecosystem restricted data",
    "licensed-material",
    "ecosystem-restricted-reference",
    "1.0.0",
  );
  const restrictedDataProductReference = stableDataProductCatalogReference({
    kind: "licensed-material",
    selector: "ecosystem-restricted-reference",
    version: "1.0.0",
  });
  const removableDataProduct = dataProductAsset(
    "Ecosystem removable data",
    "reference-data",
    "ecosystem-removable-reference",
    "1.0.0",
  );
  const removableDataProductReference = stableDataProductCatalogReference({
    kind: "reference-data",
    selector: "ecosystem-removable-reference",
    version: "1.0.0",
  });
  const isolatedDataProductReference = stableDataProductCatalogReference({
    kind: "reference-data",
    selector: "ecosystem-isolated-shared-reference",
    version: "1.0.0",
  });
  const isolatedSecondaryDataProductReference = stableDataProductCatalogReference({
    kind: "reference-data",
    selector: "ecosystem-isolated-secondary-reference",
    version: "1.0.0",
  });
  const legacyDataProductReference = stableDataProductCatalogReference({
    kind: "reference-data",
    selector: "ecosystem-legacy-staged-reference",
    version: "1.0.0",
  });

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
  });

  afterAll(async () => {
    await db
      .delete(ecosystemReleases)
      .where(
        inArray(ecosystemReleases.releaseKey, [releaseKey, reuseReleaseKey, projectionReleaseKey]),
      );
    await db
      .delete(ecosystemReleases)
      .where(
        inArray(ecosystemReleases.releaseKey, [
          ...isolatedReleaseKeys,
          ...isolatedDataReleaseKeys,
          ...concurrentDataReleaseKeys,
          ...legacyDataReleaseKeys,
          dataRemovalReleaseKey,
        ]),
      );
    const materializedAssets = await db
      .select({ id: softwareAssets.id })
      .from(softwareAssets)
      .where(like(softwareAssets.name, "Ecosystem materialized %"));
    if (materializedAssets.length > 0) {
      await db.delete(authzOutbox).where(
        inArray(
          authzOutbox.resourceId,
          materializedAssets.map((asset) => asset.id),
        ),
      );
    }
    await db.delete(softwareAssets).where(like(softwareAssets.name, "Ecosystem materialized %"));
    await db.delete(softwareAssets).where(like(softwareAssets.name, "Ecosystem isolated %"));
    await db.delete(usecasePackages).where(eq(usecasePackages.name, usecaseName));
    await db.delete(usecasePackages).where(eq(usecasePackages.name, legacyDigestUsecaseName));
    await db.delete(usecasePackages).where(eq(usecasePackages.name, reuseUsecaseName));
    await db.delete(workflowTemplates).where(eq(workflowTemplates.name, workflowName));
    await db.delete(workflowTemplates).where(eq(workflowTemplates.name, reuseWorkflowName));
    await db
      .delete(authzOutbox)
      .where(
        inArray(authzOutbox.resourceId, [
          dataProductReference.dataAssetId,
          restrictedDataProductReference.dataAssetId,
          projectionReference.dataAssetId,
          removableDataProductReference.dataAssetId,
          isolatedDataProductReference.dataAssetId,
          isolatedSecondaryDataProductReference.dataAssetId,
          legacyDataProductReference.dataAssetId,
        ]),
      );
    await db.delete(dataAssets).where(eq(dataAssets.id, dataProductReference.dataAssetId));
    await db
      .delete(dataAssets)
      .where(eq(dataAssets.id, restrictedDataProductReference.dataAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, projectionReference.dataAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, removableDataProductReference.dataAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, isolatedDataProductReference.dataAssetId));
    await db
      .delete(dataAssets)
      .where(eq(dataAssets.id, isolatedSecondaryDataProductReference.dataAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, legacyDataProductReference.dataAssetId));
  });

  test("activates bundle usecases and workflows as immutable executable catalog entries", async () => {
    const software = spackAsset("Test", "test", "1.0.0", "software/test-materialization");
    const usecase = usecaseAsset(software, 1);
    usecase.ecosystemKey = "usecase/test-materialization";
    usecase.name = usecaseName;
    const workflow = workflowAsset(1);
    workflow.ecosystemKey = "workflow/test-materialization";
    workflow.name = workflowName;
    const script = scriptAsset(1);
    script.ecosystemKey = "script/test-materialization";
    script.name = scriptName;
    const manifest: EcosystemManifest = {
      schemaVersion: 1,
      releaseKey,
      version: "1.0.0",
      provenance: { source: "test" },
      assets: [software, usecase, workflow, script, dataProduct, restrictedDataProduct],
    };
    const keys = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
      "base64",
    );
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });
    const expectedSpecDigest = `sha256:${createHash("sha256")
      .update(canonicalJson(usecase.payload.spec))
      .digest("hex")}`;

    const staged = await service.stage({ manifest, signature, signingKeyId: "test-key" }, "test");
    const [stagedUsecase] = await db
      .select()
      .from(ecosystemReleaseAssets)
      .where(
        and(
          eq(ecosystemReleaseAssets.releaseId, staged.id),
          eq(ecosystemReleaseAssets.ecosystemKey, usecase.ecosystemKey),
        ),
      )
      .limit(1);
    if (!stagedUsecase) throw new Error("derived digest usecase must be staged");
    expect(stagedUsecase?.usecaseSpecDigest).toBe(expectedSpecDigest);
    expect(stagedUsecase?.usecasePackageId).toBeString();
    await db
      .update(ecosystemReleaseAssets)
      .set({ usecaseSpecDigest: null })
      .where(eq(ecosystemReleaseAssets.id, stagedUsecase.id));
    await service.activate(staged.id, "test");
    const [backfilledUsecase] = await db
      .select()
      .from(ecosystemReleaseAssets)
      .where(eq(ecosystemReleaseAssets.id, stagedUsecase.id))
      .limit(1);
    expect(backfilledUsecase?.usecaseSpecDigest).toBe(expectedSpecDigest);
    await service.activate(staged.id, "test");

    const catalogUsecase = await db
      .select()
      .from(usecasePackages)
      .where(eq(usecasePackages.name, usecaseName));
    const catalogWorkflow = await db
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.name, workflowName));
    expect(catalogUsecase).toHaveLength(1);
    expect(catalogWorkflow).toHaveLength(1);

    const status = await service.status(releaseKey);
    const materializedUsecase = status?.assets.find(
      (entry) => entry.ecosystemKey === usecase.ecosystemKey,
    );
    const materializedWorkflow = status?.assets.find(
      (entry) => entry.ecosystemKey === workflow.ecosystemKey,
    );
    expect(materializedUsecase?.usecasePackageId).toBe(catalogUsecase[0]?.id);
    if (!catalogUsecase[0]) throw new Error("materialized usecase package must exist");
    await expect(new UsecasePackageService(db).deleteById(catalogUsecase[0].id)).rejects.toThrow(
      "pinned by a staged or active ecosystem release",
    );
    expect(materializedWorkflow?.workflowTemplateId).toBe(catalogWorkflow[0]?.id);

    const materializedScript = status?.assets.find(
      (entry) => entry.ecosystemKey === script.ecosystemKey,
    );
    if (!materializedScript?.assetId) throw new Error("script asset must be materialized");
    const [scriptAssetRow] = await db
      .select()
      .from(softwareAssets)
      .where(eq(softwareAssets.id, materializedScript.assetId));
    expect(SoftwareAssetPayloadSchema.safeParse(scriptAssetRow?.payload).success).toBe(true);
    const scriptProjectionRows = await db
      .select({
        operation: authzOutbox.operation,
        relation: authzOutbox.relation,
        subjectType: authzOutbox.subjectType,
        subjectId: authzOutbox.subjectId,
        subjectRelation: authzOutbox.subjectRelation,
      })
      .from(authzOutbox)
      .where(eq(authzOutbox.resourceId, materializedScript.assetId))
      .orderBy(authzOutbox.relation);
    expect(scriptProjectionRows).toEqual([
      {
        operation: "create",
        relation: "installer",
        subjectType: "platform",
        subjectId: "root",
        subjectRelation: "software_use",
      },
      {
        operation: "create",
        relation: "platform",
        subjectType: "platform",
        subjectId: "root",
        subjectRelation: null,
      },
      {
        operation: "create",
        relation: "user",
        subjectType: "platform",
        subjectId: "root",
        subjectRelation: "software_use",
      },
      {
        operation: "create",
        relation: "viewer",
        subjectType: "platform",
        subjectId: "root",
        subjectRelation: "software_view",
      },
    ]);

    const [materializedDataAsset] = await db
      .select()
      .from(dataAssets)
      .where(eq(dataAssets.id, dataProductReference.dataAssetId));
    const [materializedDataVersion] = await db
      .select()
      .from(dataAssetVersions)
      .where(eq(dataAssetVersions.id, dataProductReference.dataAssetVersionId));
    expect(materializedDataAsset?.metadata).toMatchObject({
      selector: "ecosystem-materialized-reference",
      selectorVersion: "1.0.0",
      metadataPlaceholder: true,
    });
    expect(materializedDataVersion).toMatchObject({
      dataAssetId: dataProductReference.dataAssetId,
      version: "1.0.0",
      status: "ready",
    });
    const projectionRows = await db
      .select({
        operation: authzOutbox.operation,
        resourceId: authzOutbox.resourceId,
        relation: authzOutbox.relation,
        subjectType: authzOutbox.subjectType,
        subjectId: authzOutbox.subjectId,
        subjectRelation: authzOutbox.subjectRelation,
      })
      .from(authzOutbox)
      .where(
        inArray(authzOutbox.resourceId, [
          dataProductReference.dataAssetId,
          restrictedDataProductReference.dataAssetId,
        ]),
      )
      .orderBy(authzOutbox.resourceId, authzOutbox.relation);
    expect(projectionRows).toHaveLength(6);
    expect(projectionRows).toEqual(
      expect.arrayContaining([
        {
          operation: "create",
          resourceId: dataProductReference.dataAssetId,
          relation: "platform",
          subjectType: "platform",
          subjectId: "root",
          subjectRelation: null,
        },
        {
          operation: "create",
          resourceId: dataProductReference.dataAssetId,
          relation: "user",
          subjectType: "platform",
          subjectId: "root",
          subjectRelation: "software_use",
        },
        {
          operation: "create",
          resourceId: dataProductReference.dataAssetId,
          relation: "viewer",
          subjectType: "platform",
          subjectId: "root",
          subjectRelation: "software_view",
        },
        {
          operation: "create",
          resourceId: restrictedDataProductReference.dataAssetId,
          relation: "platform",
          subjectType: "platform",
          subjectId: "root",
          subjectRelation: null,
        },
        {
          operation: "delete",
          resourceId: restrictedDataProductReference.dataAssetId,
          relation: "user",
          subjectType: "platform",
          subjectId: "root",
          subjectRelation: "software_use",
        },
        {
          operation: "delete",
          resourceId: restrictedDataProductReference.dataAssetId,
          relation: "viewer",
          subjectType: "platform",
          subjectId: "root",
          subjectRelation: "software_view",
        },
      ]),
    );
  });

  test("preserves the final data-product access intent across pending ABA projections", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });

    for (const [index, accessMode] of (["entitlement", "open", "entitlement"] as const).entries()) {
      const manifest: EcosystemManifest = {
        schemaVersion: 1,
        releaseKey: projectionReleaseKey,
        version: `1.0.${index}`,
        provenance: { source: "test" },
        assets: [
          dataProductAsset(
            "Ecosystem authz projection ABA data",
            "reference-data",
            "ecosystem-authz-projection-aba",
            "1.0.0",
            accessMode,
          ),
        ],
      };
      const signature = sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
        "base64",
      );
      const staged = await service.stage({ manifest, signature, signingKeyId: "test-key" }, "test");
      await service.activate(staged.id, "test");
    }

    const projectionRows = await db
      .select({ operation: authzOutbox.operation, relation: authzOutbox.relation })
      .from(authzOutbox)
      .where(eq(authzOutbox.resourceId, projectionReference.dataAssetId))
      .orderBy(authzOutbox.sequence);
    expect(
      projectionRows.filter((row) => row.relation === "viewer").map((row) => row.operation),
    ).toEqual(["delete", "create", "delete"]);
    expect(
      projectionRows.filter((row) => row.relation === "user").map((row) => row.operation),
    ).toEqual(["delete", "create", "delete"]);
  });

  test("isolates software identities by release key and rejects kind drift", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });
    const signManifest = (manifest: EcosystemManifest) => ({
      manifest,
      signature: sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
        "base64",
      ),
      signingKeyId: "test-key",
    });
    const shared = spackAsset(
      "Ecosystem isolated shared package",
      "isolated-shared",
      "1.0.0",
      "software/isolated-shared",
    );
    const firstManifest: EcosystemManifest = {
      schemaVersion: 1,
      releaseKey: isolatedReleaseKeys[0] ?? "",
      version: "1.0.0",
      provenance: { source: "test" },
      assets: [shared],
    };
    const secondManifest = {
      ...firstManifest,
      releaseKey: isolatedReleaseKeys[1] ?? "",
    };

    const first = await service.stage(signManifest(firstManifest), "test");
    await service.activate(first.id, "test");
    const second = await service.stage(signManifest(secondManifest), "test");
    await service.activate(second.id, "test");
    const firstAssetId = (await service.status(firstManifest.releaseKey))?.assets[0]?.assetId;
    const secondAssetId = (await service.status(secondManifest.releaseKey))?.assets[0]?.assetId;
    expect(firstAssetId).toBeString();
    expect(secondAssetId).toBeString();
    expect(firstAssetId).not.toBe(secondAssetId);

    const replacement = spackAsset(
      "Ecosystem isolated replacement package",
      "isolated-replacement",
      "1.0.0",
      "software/isolated-replacement",
    );
    const replacementManifest = {
      ...firstManifest,
      version: "2.0.0",
      assets: [replacement],
    };
    const replacementRelease = await service.stage(signManifest(replacementManifest), "test");
    await service.activate(replacementRelease.id, "test");
    const isolatedRows = await db
      .select({ id: softwareAssets.id, lifecycle: softwareAssets.lifecycle })
      .from(softwareAssets)
      .where(inArray(softwareAssets.id, [firstAssetId ?? "", secondAssetId ?? ""]));
    expect(isolatedRows.find((row) => row.id === firstAssetId)?.lifecycle).toBe("deprecated");
    expect(isolatedRows.find((row) => row.id === secondAssetId)?.lifecycle).toBe("published");

    const changedKind = scriptAsset(91);
    changedKind.ecosystemKey = replacement.ecosystemKey;
    const invalidManifest = {
      ...firstManifest,
      version: "3.0.0",
      assets: [changedKind],
    };
    await expect(service.stage(signManifest(invalidManifest), "test")).rejects.toThrow(
      "cannot change kind",
    );
  });

  test("rejects cross-release data-product ownership collisions without changing access", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });
    const signManifest = (manifest: EcosystemManifest) => ({
      manifest,
      signature: sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
        "base64",
      ),
      signingKeyId: "test-key",
    });
    const ownerProduct = dataProductAsset(
      "Ecosystem isolated shared data",
      "reference-data",
      "ecosystem-isolated-shared-reference",
      "1.0.0",
      "open",
    );
    const secondaryProduct = dataProductAsset(
      "Ecosystem isolated secondary data",
      "reference-data",
      "ecosystem-isolated-secondary-reference",
      "1.0.0",
      "open",
    );
    const ownerManifest: EcosystemManifest = {
      schemaVersion: 1,
      releaseKey: isolatedDataReleaseKeys[0] ?? "",
      version: "1.0.0",
      provenance: { source: "test" },
      assets: [ownerProduct],
    };
    const secondaryManifest: EcosystemManifest = {
      ...ownerManifest,
      releaseKey: isolatedDataReleaseKeys[1] ?? "",
      assets: [secondaryProduct],
    };
    const ownerRelease = await service.stage(signManifest(ownerManifest), "test");
    await service.activate(ownerRelease.id, "test");
    const secondaryRelease = await service.stage(signManifest(secondaryManifest), "test");
    await service.activate(secondaryRelease.id, "test");

    const conflictingProduct = dataProductAsset(
      "Ecosystem conflicting restricted data",
      "reference-data",
      "ecosystem-isolated-shared-reference",
      "1.0.0",
      "entitlement",
    );
    const conflictingManifest: EcosystemManifest = {
      ...secondaryManifest,
      version: "2.0.0",
      assets: [conflictingProduct],
    };
    await expect(service.stage(signManifest(conflictingManifest), "test")).rejects.toThrow(
      `already owned by release ${ownerManifest.releaseKey}`,
    );

    const [preservedAsset] = await db
      .select({ name: dataAssets.name, accessMode: dataAssets.accessMode })
      .from(dataAssets)
      .where(eq(dataAssets.id, isolatedDataProductReference.dataAssetId));
    expect(preservedAsset).toEqual({
      name: ownerProduct.name,
      accessMode: "open",
    });
    expect((await service.status(ownerManifest.releaseKey))?.release.status).toBe("active");
    expect((await service.status(secondaryManifest.releaseKey))?.release.status).toBe("active");
    const publicProjectionRows = await db
      .select({ operation: authzOutbox.operation, relation: authzOutbox.relation })
      .from(authzOutbox)
      .where(eq(authzOutbox.resourceId, isolatedDataProductReference.dataAssetId));
    expect(publicProjectionRows).toEqual(
      expect.arrayContaining([
        { operation: "create", relation: "viewer" },
        { operation: "create", relation: "user" },
      ]),
    );
    expect(publicProjectionRows.some((row) => row.operation === "delete")).toBe(false);
  });

  test("serializes concurrent data-product ownership claims across release keys", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });
    const selector = "ecosystem-concurrent-owner-reference";
    const claims = isolatedDataReleaseKeys.map((releaseKey, index) => {
      const manifest: EcosystemManifest = {
        schemaVersion: 1,
        releaseKey: concurrentDataReleaseKeys[index] ?? releaseKey,
        version: "1.0.0",
        provenance: { source: "test" },
        assets: [
          dataProductAsset(
            `Ecosystem concurrent owner ${index}`,
            "reference-data",
            selector,
            "1.0.0",
            index === 0 ? "open" : "entitlement",
          ),
        ],
      };
      return {
        manifest,
        signature: sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
          "base64",
        ),
        signingKeyId: "test-key",
      };
    });

    const results = await Promise.allSettled(claims.map((claim) => service.stage(claim, "test")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? String(rejected.reason) : "").toContain(
      "already owned by release",
    );
  });

  test("rejects a legacy staged data-product collision before activation", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });
    const ownerProduct = dataProductAsset(
      "Ecosystem legacy staged owner",
      "reference-data",
      "ecosystem-legacy-staged-reference",
      "1.0.0",
      "open",
    );
    const ownerManifest: EcosystemManifest = {
      schemaVersion: 1,
      releaseKey: legacyDataReleaseKeys[0] ?? "",
      version: "1.0.0",
      provenance: { source: "test" },
      assets: [ownerProduct],
    };
    const ownerBundle = {
      manifest: ownerManifest,
      signature: sign(null, Buffer.from(canonicalJson(ownerManifest)), keys.privateKey).toString(
        "base64",
      ),
      signingKeyId: "test-key",
    };
    const ownerRelease = await service.stage(ownerBundle, "test");
    await service.activate(ownerRelease.id, "test");

    const conflictingProduct = dataProductAsset(
      "Ecosystem legacy staged conflict",
      "reference-data",
      "ecosystem-legacy-staged-reference",
      "1.0.0",
      "entitlement",
    );
    const conflictingManifest: EcosystemManifest = {
      ...ownerManifest,
      releaseKey: legacyDataReleaseKeys[1] ?? "",
      assets: [conflictingProduct],
    };
    const [legacyStaged] = await db
      .insert(ecosystemReleases)
      .values({
        releaseKey: conflictingManifest.releaseKey,
        version: conflictingManifest.version,
        artifactDigest: manifestDigest(conflictingManifest),
        manifest: JSON.parse(JSON.stringify(conflictingManifest)) as Record<string, unknown>,
        provenance: conflictingManifest.provenance,
        signature: "legacy-staged-test",
        signingKeyId: "test-key",
        importedBy: "test",
      })
      .returning();
    if (!legacyStaged) throw new Error("legacy staged release must be created");
    await db.insert(ecosystemReleaseAssets).values({
      releaseId: legacyStaged.id,
      ecosystemKey: conflictingProduct.ecosystemKey,
      kind: conflictingProduct.kind,
      name: conflictingProduct.name,
      version: conflictingProduct.version,
      payload: conflictingProduct.payload,
      provenance: conflictingProduct.provenance,
      licensePolicy: conflictingProduct.licensePolicy,
      manifestEntryDigest: `sha256:${"9".repeat(64)}`,
    });

    await expect(service.activate(legacyStaged.id, "test")).rejects.toThrow(
      `already owned by release ${ownerManifest.releaseKey}`,
    );
  });

  test("deprecates removed data products and restores them on rollback", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });
    const signManifest = (manifest: EcosystemManifest) => ({
      manifest,
      signature: sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
        "base64",
      ),
      signingKeyId: "test-key",
    });
    const software = spackAsset(
      "Ecosystem isolated data companion",
      "data-companion",
      "1.0.0",
      "software/data-companion",
    );
    const firstManifest: EcosystemManifest = {
      schemaVersion: 1,
      releaseKey: dataRemovalReleaseKey,
      version: "1.0.0",
      provenance: { source: "test" },
      assets: [software, removableDataProduct],
    };
    const first = await service.stage(signManifest(firstManifest), "test");
    await service.activate(first.id, "test");

    const changedSelector = dataProductAsset(
      removableDataProduct.name,
      "reference-data",
      "ecosystem-removable-reference-renamed",
      "1.0.0",
    );
    changedSelector.ecosystemKey = removableDataProduct.ecosystemKey;
    await expect(
      service.stage(
        signManifest({ ...firstManifest, version: "1.1.0", assets: [software, changedSelector] }),
        "test",
      ),
    ).rejects.toThrow("cannot change kind or selector");

    const replacement = await service.stage(
      signManifest({ ...firstManifest, version: "2.0.0", assets: [software] }),
      "test",
    );
    await service.activate(replacement.id, "test");
    const [deprecatedAsset] = await db
      .select({ lifecycle: dataAssets.lifecycle })
      .from(dataAssets)
      .where(eq(dataAssets.id, removableDataProductReference.dataAssetId));
    const [deprecatedVersion] = await db
      .select({ status: dataAssetVersions.status })
      .from(dataAssetVersions)
      .where(eq(dataAssetVersions.id, removableDataProductReference.dataAssetVersionId));
    expect(deprecatedAsset?.lifecycle).toBe("deprecated");
    expect(deprecatedVersion?.status).toBe("deprecated");

    await service.rollback(dataRemovalReleaseKey, first.id, "test");
    const [restoredAsset] = await db
      .select({ lifecycle: dataAssets.lifecycle })
      .from(dataAssets)
      .where(eq(dataAssets.id, removableDataProductReference.dataAssetId));
    const [restoredVersion] = await db
      .select({ status: dataAssetVersions.status })
      .from(dataAssetVersions)
      .where(eq(dataAssetVersions.id, removableDataProductReference.dataAssetVersionId));
    expect(restoredAsset?.lifecycle).toBe("published");
    expect(restoredVersion?.status).toBe("ready");
  });

  test("derives a missing usecase digest from the signed canonical package spec", async () => {
    const software = spackAsset("Test", "test", "1.0.0", "software/test-derived-digest");
    const usecase = usecaseAsset(software, 1);
    usecase.ecosystemKey = "usecase/test-derived-digest";
    usecase.name = legacyDigestUsecaseName;
    delete usecase.specDigest;
    const manifest: EcosystemManifest = {
      schemaVersion: 1,
      releaseKey,
      version: "1.1.0",
      provenance: { source: "test" },
      assets: [software, usecase],
    };
    const keys = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
      "base64",
    );
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });
    const expectedSpecDigest = `sha256:${createHash("sha256")
      .update(canonicalJson(usecase.payload.spec))
      .digest("hex")}`;

    const staged = await service.stage({ manifest, signature, signingKeyId: "test-key" }, "test");
    const [persistedUsecase] = await db
      .select()
      .from(ecosystemReleaseAssets)
      .where(
        and(
          eq(ecosystemReleaseAssets.releaseId, staged.id),
          eq(ecosystemReleaseAssets.ecosystemKey, usecase.ecosystemKey),
        ),
      )
      .limit(1);
    if (!persistedUsecase) throw new Error("derived digest usecase must be staged");
    expect(persistedUsecase.usecaseSpecDigest).toBe(expectedSpecDigest);
    await service.activate(staged.id, "test");

    const status = await service.status(releaseKey);
    const stagedUsecase = status?.assets.find(
      (entry) => entry.ecosystemKey === usecase.ecosystemKey,
    );
    if (!stagedUsecase) throw new Error("derived digest usecase must be active");
    expect(stagedUsecase.usecaseSpecDigest).toBe(expectedSpecDigest);
    await db
      .update(ecosystemReleaseAssets)
      .set({ usecaseSpecDigest: `sha256:${"0".repeat(64)}` })
      .where(eq(ecosystemReleaseAssets.id, stagedUsecase.id));
    await expect(service.activate(staged.id, "test")).rejects.toThrow("specDigest must match");
  });

  test("reuses unchanged release bindings and discovers only the active replacement", async () => {
    const software = spackAsset("Reuse test", "reuse-test", "1.0.0", "software/reuse-test");
    const usecase = usecaseAsset(software, 1);
    usecase.ecosystemKey = "usecase/reuse-test";
    usecase.name = reuseUsecaseName;
    const workflow = workflowAsset(1);
    workflow.ecosystemKey = "workflow/reuse-test";
    workflow.name = reuseWorkflowName;
    const baseManifest: EcosystemManifest = {
      schemaVersion: 1,
      releaseKey: reuseReleaseKey,
      version: "1.0.0",
      provenance: { source: "test" },
      assets: [software, usecase, workflow],
    };
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });
    const signManifest = (manifest: EcosystemManifest) => ({
      manifest,
      signature: sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
        "base64",
      ),
      signingKeyId: "test-key",
    });

    const first = await service.stage(signManifest(baseManifest), "test");
    await service.activate(first.id, "test");
    const [firstPackage] = await db
      .select()
      .from(usecasePackages)
      .where(eq(usecasePackages.name, reuseUsecaseName));
    const [firstWorkflow] = await db
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.name, reuseWorkflowName));
    if (!firstPackage || !firstWorkflow) throw new Error("initial catalog binding is missing");

    const unchanged = await service.stage(
      signManifest({ ...baseManifest, version: "1.0.1" }),
      "test",
    );
    const [unchangedUsecaseEntry] = await db
      .select()
      .from(ecosystemReleaseAssets)
      .where(
        and(
          eq(ecosystemReleaseAssets.releaseId, unchanged.id),
          eq(ecosystemReleaseAssets.ecosystemKey, usecase.ecosystemKey),
        ),
      );
    expect(unchangedUsecaseEntry?.usecasePackageId).toBe(firstPackage.id);
    await service.activate(unchanged.id, "test");
    expect(
      (await db.select().from(usecasePackages).where(eq(usecasePackages.name, reuseUsecaseName)))
        .length,
    ).toBe(1);
    expect(
      (
        await db
          .select()
          .from(workflowTemplates)
          .where(eq(workflowTemplates.name, reuseWorkflowName))
      ).length,
    ).toBe(1);

    const changedSpec = {
      ...(usecase.payload.spec as Record<string, unknown>),
      description: "Changed scientific usecase description",
    };
    const changedUsecase = {
      ...usecase,
      payload: { ...usecase.payload, spec: changedSpec },
    };
    delete changedUsecase.specDigest;
    const replacement = await service.stage(
      signManifest({
        ...baseManifest,
        version: "1.0.2",
        assets: [software, changedUsecase, workflow],
      }),
      "test",
    );
    await service.activate(replacement.id, "test");
    const packages = await db
      .select()
      .from(usecasePackages)
      .where(eq(usecasePackages.name, reuseUsecaseName));
    expect(packages).toHaveLength(2);
    const current = await new UsecasePackageService(db).listPage({
      q: reuseUsecaseName,
      principal: null,
    });
    expect(current.packages.map((row) => row.id)).toEqual(
      expect.arrayContaining(
        packages.filter((row) => row.id !== firstPackage.id).map((row) => row.id),
      ),
    );
    expect(current.packages).toHaveLength(1);
    expect((await new UsecasePackageService(db).getById(firstPackage.id))?.id).toBe(
      firstPackage.id,
    );
    expect(
      (await new WorkflowTemplateService(db).findByNameVersion(reuseWorkflowName, "1.0.0"))?.id,
    ).toBe(firstWorkflow.id);
  });

  test("rejects a signed release whose declared usecase digest does not match its package spec", async () => {
    const software = spackAsset("Test", "test", "1.0.0", "software/test-digest-attack");
    const usecase = usecaseAsset(software, 1);
    usecase.ecosystemKey = "usecase/test-digest-attack";
    usecase.specDigest = `sha256:${"0".repeat(64)}`;
    const manifest: EcosystemManifest = {
      schemaVersion: 1,
      releaseKey,
      version: "2.0.0",
      provenance: { source: "test" },
      assets: [software, usecase],
    };
    const keys = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
      "base64",
    );
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const service = new EcosystemReleaseService(db, { "test-key": publicKey });

    await expect(
      service.stage({ manifest, signature, signingKeyId: "test-key" }, "test"),
    ).rejects.toThrow("specDigest must match");
  });
});
