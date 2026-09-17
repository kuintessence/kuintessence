import { describe, expect, test } from "bun:test";
import { parseSpackCompilers, parseSpackPackageFile } from "./spack-package-parser";

const packageFile = `
class OpenfoamOrg(Package):
    homepage = "https://openfoam.org"
    maintainers("alice", "bob")
    license("GPL-3.0-only")

    version("12", sha256="abc")
    version("11", sha256="def")

    variant("mpi", default=True, description="Enable MPI support")
    variant("precision", default="double", values=("single", "double"), description="Precision")

    depends_on("mpi", when="+mpi")
    provides("cfd-solver")
    conflicts("~mpi", when="+decompose")
`;

describe("Spack package parser", () => {
  test("extracts package metadata from package.py", () => {
    const parsed = parseSpackPackageFile(packageFile);
    expect(parsed.name).toBe("openfoam-org");
    expect(parsed.homepage).toBe("https://openfoam.org");
    expect(parsed.licenses).toEqual(["GPL-3.0-only"]);
    expect(parsed.maintainers).toEqual(["alice", "bob"]);
    expect(parsed.versions).toEqual(["12", "11"]);
    expect(parsed.dependencies).toEqual(["mpi"]);
    expect(parsed.provides).toEqual(["cfd-solver"]);
    expect(parsed.conflicts).toEqual(["~mpi"]);
    expect(parsed.variants).toContainEqual({
      name: "mpi",
      default: "True",
      description: "Enable MPI support",
      values: [],
    });
    expect(parsed.variants).toContainEqual({
      name: "precision",
      default: "double",
      description: "Precision",
      values: ["single", "double"],
    });
  });

  test("extracts compiler specs from yaml, json, and plain text", () => {
    const parsed = parseSpackCompilers(`
compilers:
- compiler:
    spec: gcc@13.2.0
    paths:
      cc: /usr/bin/gcc
- compiler:
    spec: clang@17.0.6
notes: oneapi@2024.1.0 is available too
`);
    expect(parsed).toContainEqual({ spec: "gcc@13.2.0", name: "gcc", version: "13.2.0" });
    expect(parsed).toContainEqual({ spec: "clang@17.0.6", name: "clang", version: "17.0.6" });
    expect(parsed).toContainEqual({ spec: "oneapi@2024.1.0", name: "oneapi", version: "2024.1.0" });

    const fromJson = parseSpackCompilers(
      JSON.stringify({ compilers: [{ compiler: { spec: "nvhpc@24.3" } }] }),
    );
    expect(fromJson).toEqual([{ spec: "nvhpc@24.3", name: "nvhpc", version: "24.3" }]);
  });
});
