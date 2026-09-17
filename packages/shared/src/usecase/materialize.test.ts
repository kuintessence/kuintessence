import { describe, expect, test } from "bun:test";
import { type MaterializeInput, materialize } from "./materialize";

const base = (over: Partial<MaterializeInput>): MaterializeInput => ({
  usecase: { commandFile: "simpleFoam", inputSlots: [] },
  software: { kind: "Spack", name: "openfoam", argumentList: [] },
  arguments: [],
  environments: [],
  filesomeInputs: [],
  inputs: {},
  ...over,
});

describe("materialize (Spack facility, arg/env/file refs)", () => {
  test("preserves selector-only licensed material requests without material bytes", () => {
    const result = materialize(
      base({
        licensedMaterials: [
          {
            selector: "vasp-potcar-pbe",
            licenseSubject: "VASP",
            targetPath: "POTCAR",
            requiredElements: ["Si", "O"],
          },
        ],
      }),
    );
    expect(result.licensedMaterials).toEqual([
      {
        selector: "vasp-potcar-pbe",
        licenseSubject: "VASP",
        targetPath: "POTCAR",
        requiredElements: ["Si", "O"],
      },
    ]);
    expect(result.dataRequirements).toEqual([
      {
        asset: { kind: "licensed-material", selector: "vasp-potcar-pbe" },
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
        allowUserPrivate: false,
      },
    ]);
  });

  test("renders commandFile + an ArgRef text value into argv, keeping the value a single token", () => {
    const r = materialize(
      base({
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
        arguments: [{ descriptor: "endTime", valueFormat: "-endTime {}" }],
        inputs: { endTime: "500" },
      }),
    );
    expect(r.argv).toEqual(["simpleFoam", "-endTime", "500"]);
    expect(r.facility).toEqual({ kind: "Spack", name: "openfoam", argumentList: [] });
  });

  test("keeps a value containing spaces as one argv token", () => {
    const r = materialize(
      base({
        usecase: {
          commandFile: "x",
          inputSlots: [
            {
              kind: "Text",
              descriptor: "label",
              refMaterials: [{ kind: "ArgRef", descriptor: "label", sort: 0 }],
            },
          ],
        },
        arguments: [{ descriptor: "label", valueFormat: "--label {}" }],
        inputs: { label: "hello world" },
      }),
    );
    expect(r.argv).toEqual(["x", "--label", "hello world"]);
  });

  test("orders arguments by their sort", () => {
    const r = materialize(
      base({
        usecase: {
          commandFile: "x",
          inputSlots: [
            {
              kind: "Text",
              descriptor: "b",
              refMaterials: [{ kind: "ArgRef", descriptor: "b", sort: 1 }],
            },
            {
              kind: "Text",
              descriptor: "a",
              refMaterials: [{ kind: "ArgRef", descriptor: "a", sort: 0 }],
            },
          ],
        },
        arguments: [
          { descriptor: "a", valueFormat: "-a {}" },
          { descriptor: "b", valueFormat: "-b {}" },
        ],
        inputs: { a: "1", b: "2" },
      }),
    );
    expect(r.argv).toEqual(["x", "-a", "1", "-b", "2"]);
  });

  test("renders an EnvRef into envVars", () => {
    const r = materialize(
      base({
        usecase: {
          commandFile: "x",
          inputSlots: [
            {
              kind: "Text",
              descriptor: "threads",
              refMaterials: [{ kind: "EnvRef", descriptor: "omp" }],
            },
          ],
        },
        environments: [{ descriptor: "omp", key: "OMP_NUM_THREADS", valueFormat: "{}" }],
        inputs: { threads: "8" },
      }),
    );
    expect(r.envVars).toEqual({ OMP_NUM_THREADS: "8" });
  });

  test("maps a FileInputRef to an input-staging entry at the material's path", () => {
    const r = materialize(
      base({
        usecase: {
          commandFile: "x",
          inputSlots: [
            {
              kind: "File",
              descriptor: "mesh",
              refMaterials: [{ kind: "FileInputRef", descriptor: "meshFile" }],
            },
          ],
        },
        filesomeInputs: [
          { descriptor: "meshFile", fileKind: { kind: "Normal", name: "mesh.tar.gz" } },
        ],
        inputs: { mesh: { fileMetadataId: "fm-1", fileMetadataName: "user-mesh.tar.gz" } },
      }),
    );
    expect(r.inputStaging).toEqual([{ fileMetadataId: "fm-1", stagePath: "mesh.tar.gz" }]);
  });

  test("maps a batched FileInputRef to one staging entry per file", () => {
    const r = materialize(
      base({
        usecase: {
          commandFile: "x",
          inputSlots: [
            {
              kind: "File",
              descriptor: "frames",
              refMaterials: [{ kind: "FileInputRef", descriptor: "frameFiles" }],
            },
          ],
        },
        filesomeInputs: [
          { descriptor: "frameFiles", fileKind: { kind: "Batched", pattern: "inputs/*.txt" } },
        ],
        inputs: {
          frames: [
            { fileMetadataId: "fm-1", fileMetadataName: "a.txt" },
            { fileMetadataId: "fm-2", fileMetadataName: "b with space.txt" },
          ],
        },
      }),
    );
    expect(r.inputStaging).toEqual([
      { fileMetadataId: "fm-1", stagePath: "inputs/a.txt" },
      { fileMetadataId: "fm-2", stagePath: "inputs/b_with_space.txt" },
    ]);
  });

  test("rejects a FileInputRef whose stagePath escapes the run dir via '..'", () => {
    expect(() =>
      materialize(
        base({
          usecase: {
            commandFile: "x",
            inputSlots: [
              {
                kind: "File",
                descriptor: "mesh",
                refMaterials: [{ kind: "FileInputRef", descriptor: "meshFile" }],
              },
            ],
          },
          filesomeInputs: [
            { descriptor: "meshFile", fileKind: { kind: "Normal", name: "../../etc/cron.d/x" } },
          ],
          inputs: { mesh: { fileMetadataId: "fm-1", fileMetadataName: "x" } },
        }),
      ),
    ).toThrow(/stagePath/);
  });

  test("emits expectedOutputs from filesome outputs (Normal + Batched)", () => {
    const r = materialize(
      base({
        filesomeOutputs: [
          { descriptor: "result", fileKind: { kind: "Normal", name: "out/result.dat" } },
          { descriptor: "frames", fileKind: { kind: "Batched", pattern: "frames/*.png" } },
        ],
      }),
    );
    expect(r.expectedOutputs).toEqual([
      { descriptor: "result", path: "out/result.dat", isBatch: false },
      { descriptor: "frames", path: "frames/*.png", isBatch: true },
    ]);
  });

  test("renders a StdinRef text value into stdinText", () => {
    const r = materialize(
      base({
        usecase: {
          commandFile: "awk",
          inputSlots: [
            {
              kind: "Text",
              descriptor: "numbers",
              refMaterials: [{ kind: "StdinRef", descriptor: "stdin" }],
            },
          ],
        },
        inputs: { numbers: "1\n2\n3\n" },
      }),
    );
    expect(r.argv).toEqual(["awk"]);
    expect(r.stdinText).toBe("1\n2\n3\n");
  });

  test("rejects a StdinRef bound to a File slot", () => {
    expect(() =>
      materialize(
        base({
          usecase: {
            commandFile: "cat",
            inputSlots: [
              {
                kind: "File",
                descriptor: "input",
                refMaterials: [{ kind: "StdinRef", descriptor: "stdin" }],
              },
            ],
          },
          inputs: { input: { fileMetadataId: "fm-1", fileMetadataName: "input.txt" } },
        }),
      ),
    ).toThrow(/expected a text value/);
  });

  test("rejects multiple StdinRef bindings", () => {
    expect(() =>
      materialize(
        base({
          usecase: {
            commandFile: "cat",
            inputSlots: [
              {
                kind: "Text",
                descriptor: "a",
                refMaterials: [{ kind: "StdinRef", descriptor: "stdin-a" }],
              },
              {
                kind: "Text",
                descriptor: "b",
                refMaterials: [{ kind: "StdinRef", descriptor: "stdin-b" }],
              },
            ],
          },
          inputs: { a: "one", b: "two" },
        }),
      ),
    ).toThrow(/multiple StdinRef/);
  });

  test("rejects a filesome output whose path escapes the run dir via '..'", () => {
    expect(() =>
      materialize(
        base({
          filesomeOutputs: [
            { descriptor: "leak", fileKind: { kind: "Normal", name: "../../etc/shadow" } },
          ],
        }),
      ),
    ).toThrow(/output path/);
  });

  test("supports a Singularity facility", () => {
    const r = materialize(base({ software: { kind: "Singularity", image: "of", tag: "v2312" } }));
    expect(r.facility).toEqual({ kind: "Singularity", image: "of", tag: "v2312" });
    expect(r.argv).toEqual(["simpleFoam"]);
  });
});
