import { describe, expect, test } from "bun:test";
import { materialize } from "./materialize";
import { GovernedUsecasePackageSchema, UsecasePackageSchema } from "./package";

const valid = {
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

describe("UsecasePackageSchema", () => {
  test("accepts a materialization package without governed metadata", () => {
    const pkg = UsecasePackageSchema.parse(valid);
    expect(pkg.usecase.commandFile).toBe("simpleFoam");
    expect("softwareRef" in pkg).toBe(false);
  });

  test("accepts Spack variant metadata", () => {
    const pkg = UsecasePackageSchema.parse({
      ...valid,
      software: {
        kind: "Spack",
        name: "openfoam@2312%gcc@13.2.0",
        version: "2312",
        compiler: "gcc@13.2.0",
        moduleName: "openfoam/2312",
        variantRef: "sw-openfoam",
        argumentList: ["+mpi"],
      },
    });
    expect(pkg.software).toMatchObject({
      version: "2312",
      compiler: "gcc@13.2.0",
      moduleName: "openfoam/2312",
      variantRef: "sw-openfoam",
    });
  });

  test("rejects a missing commandFile", () => {
    const bad = { ...valid, usecase: { inputSlots: [] } };
    expect(() => UsecasePackageSchema.parse(bad)).toThrow();
  });

  test("rejects an unknown software kind", () => {
    const bad = { ...valid, software: { kind: "Docker", image: "x" } };
    expect(() => UsecasePackageSchema.parse(bad)).toThrow();
  });

  test("a parsed package feeds materialize directly", () => {
    const pkg = UsecasePackageSchema.parse(valid);
    const task = materialize({
      usecase: pkg.usecase,
      software: pkg.software,
      arguments: pkg.arguments,
      environments: pkg.environments,
      filesomeInputs: pkg.filesomeInputs,
      inputs: { endTime: "500" },
    });
    expect(task.argv).toEqual(["simpleFoam", "-endTime", "500"]);
  });

  test("accepts StdinRef material references", () => {
    const pkg = UsecasePackageSchema.parse({
      ...valid,
      usecase: {
        commandFile: "cat",
        inputSlots: [
          {
            kind: "Text",
            descriptor: "payload",
            refMaterials: [{ kind: "StdinRef", descriptor: "stdin" }],
          },
        ],
      },
      arguments: [],
    });
    expect(pkg.usecase.inputSlots[0]?.refMaterials[0]?.kind).toBe("StdinRef");
  });

  test("accepts governed packages with typed metadata", () => {
    const pkg = UsecasePackageSchema.parse({
      ...valid,
      description: "Run a converged OpenFOAM solver.",
      domain: "CFD",
      tags: ["steady-state"],
      citations: [{ title: "OpenFOAM", url: "https://www.openfoam.com/" }],
      softwareRef: {
        source: "official-upstream",
        name: "openfoam",
        version: "2312",
      },
      inputs: [
        {
          descriptor: "endTime",
          type: "Integer",
          required: true,
          minimum: 1,
          maximum: 5000,
        },
        { descriptor: "controlDict", type: "File", required: true },
      ],
      outputs: [{ descriptor: "residual", type: "Number", validators: [{ kind: "finite" }] }],
      resources: { cpu: 4, memoryMiB: 4096 },
      materialMappings: [
        { kind: "argv", descriptor: "endTime", template: "-endTime {}" },
        { kind: "file", descriptor: "controlDict", path: "system/controlDict", direction: "input" },
      ],
      dataRequirements: [
        {
          asset: {
            kind: "licensed-material",
            selector: "vasp-potcar-pbe",
            version: "2025.1",
          },
          targetPath: "POTCAR",
          accessMode: "entitlement",
          maxSensitivity: "restricted",
          deliveryPolicy: {
            download: "deny",
            derive: "deny",
            redistribution: "deny",
            crossCenterReplication: "deny",
            retention: "source-controlled",
          },
          entitlementRequired: true,
        },
      ],
      licensedMaterials: [
        {
          selector: "vasp-potcar-pbe",
          licenseSubject: "VASP",
          targetPath: "POTCAR",
          requiredElements: ["Si", "O"],
        },
      ],
      licenseRequirements: [
        {
          identifier: "GPL-3.0-or-later",
          requiredEntitlements: ["consumer-use"],
        },
      ],
    });
    expect("softwareRef" in pkg).toBe(true);
    if (!("softwareRef" in pkg)) throw new Error("expected a governed usecase package");
    expect(pkg.softwareRef.name).toBe("openfoam");
    expect(pkg.inputs[0]).toMatchObject({ type: "Integer", minimum: 1 });
    expect(pkg.licensedMaterials).toHaveLength(1);
    expect(pkg.dataRequirements[0]?.asset.selector).toBe("vasp-potcar-pbe");
  });

  test("governed packages require a software selector and valid typed constraints", () => {
    const governed = {
      ...valid,
      description: "bad",
      domain: "CFD",
      tags: [],
      citations: [],
      softwareRef: { source: "official-upstream", name: "openfoam", version: "2312" },
      inputs: [{ descriptor: "steps", type: "Integer", minimum: 20, maximum: 10 }],
      outputs: [],
      resources: {},
      materialMappings: [],
      licenseRequirements: [],
    };
    expect(() => GovernedUsecasePackageSchema.parse(governed)).toThrow();
    expect(() => UsecasePackageSchema.parse(governed)).toThrow();
    const missingSelector = { ...governed, inputs: [], softwareRef: undefined };
    expect(() => GovernedUsecasePackageSchema.parse(missingSelector)).toThrow();
    expect(() => UsecasePackageSchema.parse(missingSelector)).toThrow();
  });

  test("does not treat an incomplete governed package as a materialization package", () => {
    expect(() =>
      UsecasePackageSchema.parse({
        ...valid,
        softwareRef: { source: "official-upstream", name: "openfoam", version: "2312" },
      }),
    ).toThrow();
  });

  test("accepts a VASP POTCAR selector without embedding licensed bytes", () => {
    const pkg = GovernedUsecasePackageSchema.parse({
      ...valid,
      description: "VASP static calculation",
      domain: "materials",
      tags: ["VASP"],
      citations: [],
      softwareRef: { source: "official-upstream", name: "vasp", version: "6.5.1" },
      inputs: [],
      outputs: [],
      resources: {},
      materialMappings: [],
      dataRequirements: [
        {
          asset: { kind: "licensed-material", selector: "vasp-potcar-pbe", version: "2025.1" },
          targetPath: "POTCAR",
          accessMode: "entitlement",
          maxSensitivity: "restricted",
          deliveryPolicy: {
            download: "deny",
            derive: "deny",
            redistribution: "deny",
            crossCenterReplication: "deny",
            retention: "source-controlled",
          },
          entitlementRequired: true,
        },
      ],
      licensedMaterials: [
        {
          selector: "vasp-potcar-pbe",
          licenseSubject: "VASP",
          targetPath: "POTCAR",
          requiredElements: ["Si"],
        },
      ],
      licenseRequirements: [{ identifier: "VASP", requiredEntitlements: ["consumer-use"] }],
    });
    expect(pkg.licensedMaterials[0]?.selector).toBe("vasp-potcar-pbe");
    expect(pkg.dataRequirements[0]?.deliveryPolicy.download).toBe("deny");
    expect(JSON.stringify(pkg)).not.toContain("POTCAR bytes");
  });

  test("accepts Dataset requirements with metadata-only Data Market selectors", () => {
    const pkg = GovernedUsecasePackageSchema.parse({
      ...valid,
      description: "QE calculation",
      domain: "materials",
      tags: [],
      citations: [],
      softwareRef: { source: "platform-fork", name: "Quantum ESPRESSO", version: "7.4.1" },
      inputs: [
        {
          descriptor: "pseudopotentials",
          type: "Dataset",
          dataRequirements: {
            dataAssets: [{ kind: "pseudopotential", selector: "qe-pslibrary", version: "1.0.0" }],
            accessModes: ["open"],
          },
        },
      ],
      outputs: [],
      resources: {},
      materialMappings: [],
      licenseRequirements: [],
    });
    expect(pkg.inputs[0]?.dataRequirements?.dataAssets[0]?.selector).toBe("qe-pslibrary");
    expect(JSON.stringify(pkg)).not.toContain("/private/");
  });
});
