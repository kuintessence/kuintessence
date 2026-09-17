import { describe, expect, test } from "bun:test";
import { LocalPackageStore } from "./local-package-store";

const BARE_PKG = {
  usecase: { commandFile: "run-a", inputSlots: [] },
  software: { kind: "Bare" },
  arguments: [],
  environments: [],
  filesomeInputs: [],
  filesomeOutputs: [],
  valueOutputs: [],
};

const CATALOG_YAML = `
"11111111-1111-1111-1111-111111111111":
  usecase:
    commandFile: run-a
    inputSlots: []
  software:
    kind: Bare
"22222222-2222-2222-2222-222222222222":
  usecase:
    commandFile: run-b
    inputSlots: []
  software:
    kind: Bare
`;

describe("LocalPackageStore", () => {
  test("fromEntries resolves a known usecase id to a validated package", async () => {
    const store = LocalPackageStore.fromEntries({
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": BARE_PKG,
    });

    const pkg = await store.resolvePackage(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );

    expect(pkg.usecase.commandFile).toBe("run-a");
    expect(pkg.software).toEqual({ kind: "Bare" });
    // Schema defaults fill the optional collections.
    expect(pkg.arguments).toEqual([]);
    expect(pkg.valueOutputs).toEqual([]);
  });

  test("fromYaml parses a catalog mapping usecase id -> package spec", async () => {
    const store = LocalPackageStore.fromYaml(CATALOG_YAML);

    const a = await store.resolvePackage("11111111-1111-1111-1111-111111111111", "x");
    const b = await store.resolvePackage("22222222-2222-2222-2222-222222222222", "x");

    expect(a.usecase.commandFile).toBe("run-a");
    expect(b.usecase.commandFile).toBe("run-b");
  });

  test("rejects an invalid package spec at load time", () => {
    expect(() =>
      LocalPackageStore.fromEntries({
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": { usecase: { commandFile: 42 } },
      }),
    ).toThrow();
  });

  test("throws a clear error for an unknown usecase id", async () => {
    const store = LocalPackageStore.fromEntries({});
    await expect(store.resolvePackage("missing-id", "sw")).rejects.toThrow(
      "no local package for usecase missing-id",
    );
  });
});
