import { describe, expect, test } from "bun:test";
import { createPackageResolver, type PackageStore } from "./package-resolver";

const spec = {
  usecase: { commandFile: "simpleFoam", inputSlots: [] },
  software: { kind: "Spack", name: "of", argumentList: [] },
  arguments: [],
  environments: [],
  filesomeInputs: [],
  valueOutputs: [],
};

const typedSpec = {
  ...spec,
  description: "OpenFOAM computation",
  domain: "CFD",
  tags: ["CFD"],
  citations: [],
  softwareRef: { source: "official-upstream", name: "openfoam", version: "2312" },
  inputs: [],
  outputs: [],
  resources: {},
  materialMappings: [],
  licenseRequirements: [],
};

const rejects = async (p: Promise<unknown>): Promise<boolean> => {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
};

describe("createPackageResolver", () => {
  test("rejects an ungoverned stored package spec", async () => {
    const store: PackageStore = { getById: async () => ({ spec }) };
    await expect(createPackageResolver(store)("u1", "s1")).rejects.toThrow(
      "Workflow execution requires a governed usecase package with a software selector",
    );
  });

  test("throws when the package is not found", async () => {
    const resolve = createPackageResolver({ getById: async () => null });
    expect(await rejects(resolve("missing", "s1"))).toBe(true);
  });

  test("throws when the stored spec is malformed", async () => {
    const resolve = createPackageResolver({ getById: async () => ({ spec: { bogus: true } }) });
    expect(await rejects(resolve("u1", "s1"))).toBe(true);
  });

  test("loads the frozen software revision and uses its immutable Spack spec", async () => {
    const usecasePackageId = "11111111-1111-4111-8111-111111111111";
    const softwareAssetId = "22222222-2222-4222-8222-222222222222";
    const resolve = createPackageResolver({
      getById: async () => ({ spec: typedSpec, usecasePackageId }),
      getSoftwareRevision: async () => ({
        asset: {
          id: softwareAssetId,
          source: "official-upstream",
          name: "openfoam",
          version: "2312",
          providerOrgId: null,
        },
        payload: {
          kind: "spack-package",
          spack: { packageName: "openfoam", defaultSpec: "openfoam@2312+mpi" },
        },
        recipeSha256: "a".repeat(64),
        contentSha256: null,
      }),
    });

    const pkg = await resolve("u1", "s1");
    expect(pkg.usecasePackageId).toBe(usecasePackageId);
    expect(pkg.software).toMatchObject({ kind: "Spack", name: "openfoam@2312+mpi" });
    expect(pkg.softwareRequirements).toEqual([
      {
        assetId: softwareAssetId,
        name: "openfoam",
        version: "2312",
        installable: false,
      },
    ]);
  });

  test("rejects a frozen software revision that differs from the pinned selector", async () => {
    const resolve = createPackageResolver({
      getById: async () => ({ spec: typedSpec }),
      getSoftwareRevision: async () => ({
        asset: {
          id: "33333333-3333-4333-8333-333333333333",
          source: "official-upstream",
          name: "lammps",
          version: "2025",
          providerOrgId: null,
        },
        payload: { kind: "spack-package", spack: { packageName: "lammps" } },
        recipeSha256: null,
        contentSha256: null,
      }),
    });

    await expect(resolve("u1", "s1")).rejects.toThrow(
      "does not match the usecase software selector",
    );
  });
});
