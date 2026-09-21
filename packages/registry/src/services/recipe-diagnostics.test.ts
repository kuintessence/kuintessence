import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectRecipeTree, type RecipeTreeFile } from "./recipe-diagnostics";

const exec = promisify(execFile);
const repoYaml = (namespace = "builtin") => `repo:\n  namespace: ${namespace}\n  api: v2.0\n`;

function tree(contents: Record<string, string>) {
  const files = Object.entries(contents).map(([path, source], index) => ({
    path,
    oid: index.toString(16).padStart(40, "0"),
    size: Buffer.byteLength(source),
  }));
  const reads: string[] = [];
  return {
    files,
    reads,
    readText: async (file: RecipeTreeFile) => {
      reads.push(file.path);
      const source = contents[file.path];
      if (source === undefined) throw new Error(`Unexpected read: ${file.path}`);
      return source;
    },
  };
}

async function inspect(contents: Record<string, string>) {
  const input = tree(contents);
  return inspectRecipeTree(input.files, input.readText);
}

describe("inspectRecipeTree", () => {
  test("preserves native v2.0 paths and derives names from Python directories, not classes", async () => {
    const root = "repos/spack_repo/builtin";
    const result = await inspect({
      [`${root}/repo.yaml`]: repoYaml(),
      [`${root}/packages/py_numpy/package.py`]: `
class Helper:
    pass
class UnrelatedClassName(Package):
    name = "not-the-package-name"
    depends_on("7zip")
    depends_on("py-numpy")
`,
      [`${root}/packages/_7zip/package.py`]: "class SevenZip(Package): pass",
    });
    expect(result.roots).toEqual([
      { path: root, namespace: "builtin", api: "v2.0", packageCount: 2 },
    ]);
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.diagnostics.filter((item) => item.code === "dependency-not-in-bundle")).toEqual(
      [],
    );
  });

  test.each([
    "global",
    "pass",
    "async",
    "await",
    "class",
    "yield",
  ])("decodes the native v2 Python keyword escape for %s", async (name) => {
    const result = await inspect({
      "repo.yaml": repoYaml(),
      [`packages/_${name}/package.py`]: "class Escaped(Package): pass",
      "packages/consumer/package.py": `depends_on("${name}")\ndepends_on("builtin.${name}")`,
    });
    expect(result.roots[0]?.packageCount).toBe(2);
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.diagnostics.filter((item) => item.code === "dependency-not-in-bundle")).toEqual(
      [],
    );
  });

  test.each([
    "global",
    "pass",
    "_unknown",
    "__pass",
    "foo__bar",
    "Uppercase",
    "_pass_more",
    "_",
    "3foo",
  ])("rejects noncanonical native v2 package directory %s", async (directory) => {
    const path = `packages/${directory}/package.py`;
    const result = await inspect({
      "repo.yaml": repoYaml(),
      [path]: "class Invalid(Package): pass",
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "invalid-package-directory", path }),
    );
  });

  test.each([
    "v2.0",
    "v2.1",
    "v2.2",
  ])("preserves known API %s without asserting engine compatibility", async (api) => {
    const result = await inspect({
      "repo.yaml": `repo:\n  namespace: local_recipes\n  api: ${api}\n`,
      "packages/example/package.py": "class Example(Package): pass",
    });
    expect(result.roots).toEqual([{ path: ".", namespace: "local_recipes", api, packageCount: 1 }]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "static-only",
        message: expect.stringContaining("Engine compatibility is not verified."),
      }),
    ]);
    expect(result.diagnostics[0]?.message).toContain("Python is not imported or executed");
    expect(result.diagnostics[0]?.message).toContain("concretization are not performed");
  });

  test("accepts the archived official builtin v2.2 repo.yaml without networking", async () => {
    // spack/spack-packages@459a8f72a7dae98acf30eef103f9361cbfc4126d:
    // repos/spack_repo/builtin/repo.yaml, archived on 2026-09-17.
    const officialRepoYaml = "repo:\n  namespace: builtin\n  api: v2.2\n";
    const result = await inspect({
      "repos/spack_repo/builtin/repo.yaml": officialRepoYaml,
    });
    expect(result.roots).toEqual([
      { path: "repos/spack_repo/builtin", namespace: "builtin", api: "v2.2", packageCount: 0 },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "static-only",
        message: expect.stringContaining("Engine compatibility is not verified."),
      }),
    ]);
  });

  test.each([
    "v2.3",
    "v2.10",
    "v3.0",
    "v2",
    "v2.2.0",
    "V2.2",
    "v2.2-preview",
    " v2.2 ",
  ])("blocks unrecognized API %s instead of accepting all v2 declarations", async (api) => {
    const result = await inspect({
      "repo.yaml": `repo:\n  namespace: builtin\n  api: ${JSON.stringify(api)}\n`,
    });
    expect(result.roots[0]?.api).toBe(api);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "unsupported-repo-api",
        path: "repo.yaml",
      }),
    );
  });

  test.each([
    ".",
    "arbitrary/native/path",
  ])("accepts an empty standard repo at %s", async (root) => {
    const prefix = root === "." ? "" : `${root}/`;
    const result = await inspect({
      [`${prefix}repo.yaml`]: repoYaml("local_recipes"),
      [`${prefix}README.md`]: "An empty repository",
    });
    expect(result.roots).toEqual([
      { path: root, namespace: "local_recipes", api: "v2.0", packageCount: 0 },
    ]);
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  test("requires a repo.yaml instead of treating loose package.py files as a repo", async () => {
    const result = await inspect({ "packages/example/package.py": "class Example(Package): pass" });
    expect(result.roots).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "repo-not-found" }),
    );
  });

  test.each([
    ["malformed", "repo: [", "invalid-repo-yaml"],
    ["duplicate keys", "repo:\n  namespace: first\n  namespace: second\n", "invalid-repo-yaml"],
    ["scalar", "hello", "invalid-repo-config"],
    ["null", "", "invalid-repo-config"],
    ["sequence", "repo: [builtin]", "invalid-repo-config"],
    ["missing repo", "namespace: builtin", "invalid-repo-config"],
    ["missing namespace", "repo:\n  api: v2.0", "invalid-namespace"],
    ["non-string namespace", "repo:\n  namespace: 42\n  api: v2.0", "invalid-namespace"],
    ["unsafe namespace", repoYaml("../builtin"), "invalid-namespace"],
    ["hyphenated namespace", repoYaml("not-python"), "invalid-namespace"],
    ["empty namespace component", repoYaml("foo..bar"), "invalid-namespace"],
    ["legacy API", "repo:\n  namespace: builtin", "unsupported-repo-api"],
    ["unknown API", "repo:\n  namespace: builtin\n  api: v9.0", "unsupported-repo-api"],
    ["non-string API", "repo:\n  namespace: builtin\n  api: 2.0", "unsupported-repo-api"],
    [
      "alias",
      "name: &name builtin\nrepo:\n  namespace: *name\n  api: v2.0",
      "yaml-alias-not-allowed",
    ],
    [
      "unused alias",
      "unused: &unused [safe]\ncopy: *unused\nrepo:\n  namespace: builtin\n  api: v2.0",
      "yaml-alias-not-allowed",
    ],
  ])("rejects %s metadata with a path-bearing error", async (_label, yaml, code) => {
    const result = await inspect({ "nested/repo.yaml": yaml });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code, path: "nested/repo.yaml" }),
    );
  });

  test("rejects duplicate namespaces without renaming native paths", async () => {
    const result = await inspect({
      "one/repo.yaml": repoYaml("team.recipes"),
      "different/location/repo.yaml": repoYaml("team.recipes"),
    });
    expect(result.roots.map((root) => root.path)).toEqual(["one", "different/location"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "duplicate-namespace",
        path: "different/location/repo.yaml",
      }),
    );
  });

  test.each([
    ["packages", "packages-not-directory"],
    ["packages/missing/README.md", "package-file-missing"],
    ["packages/not-python/package.py", "invalid-package-directory"],
  ])("diagnoses invalid package structure at %s", async (path, code) => {
    const result = await inspect({ "repo.yaml": repoYaml(), [path]: "contents" });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code, path }),
    );
  });

  test("matches packages across roots and literal virtual providers without solver claims", async () => {
    const result = await inspect({
      "app/repo.yaml": repoYaml("applications"),
      "app/packages/consumer/package.py": `
class Base(Package):
    depends_on("py-numpy@1.0: +blas")
    depends_on("tools.7zip@23:")
    depends_on("mpi@3:", when="+mpi")
    depends_on("external-lib@2:", when="platform=linux")
class Consumer(Base):
    depends_on(dynamic_dep, when="+dynamic")
`,
      "tools/repo.yaml": repoYaml("tools"),
      "tools/packages/py_numpy/package.py": "class Numpy(Package): pass",
      "tools/packages/_7zip/package.py": "class SevenZip(Package): pass",
      "tools/packages/mpich/package.py": 'provides("mpi", when="@4:")',
    });
    const missing = result.diagnostics.filter((item) => item.code === "dependency-not-in-bundle");
    expect(missing).toEqual([
      expect.objectContaining({
        severity: "warning",
        path: "app/packages/consumer/package.py",
        package: "consumer",
        message: expect.stringContaining("external-lib"),
      }),
    ]);
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const limits = result.diagnostics.filter((item) => item.code === "static-only");
    expect(limits).toHaveLength(1);
    expect(limits[0]?.message).toMatch(/when/);
    expect(limits[0]?.message).toMatch(/inheritance/);
    expect(limits[0]?.message).toMatch(/dynamic/);
    expect(limits[0]?.message).toMatch(/syntax/);
    expect(limits[0]?.message).toMatch(/concretiz/);
  });

  test("does not resolve qualified dependencies from a different namespace", async () => {
    const result = await inspect({
      "repo.yaml": repoYaml("local"),
      "packages/consumer/package.py": 'depends_on("other.zlib")',
      "packages/zlib/package.py": "class Zlib(Package): pass",
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "dependency-not-in-bundle",
        package: "consumer",
        message: expect.stringContaining("other.zlib"),
      }),
    );
  });

  test("uses only literal directive arguments, ignoring comments, strings and dynamic expressions", async () => {
    const result = await inspect({
      "repo.yaml": repoYaml(),
      "packages/example/package.py": `
# depends_on("comment-only")
text = "depends_on('string-only')"
doc = """depends_on("docstring-only")"""
depends_on(dynamic, when="keyword-only")
depends_on("concatenated-" + suffix)
depends_on(f"interpolated-{suffix}")
depends_on("adjacent-" "strings")
depends_on(get_dependency("function-argument"))
depends_on("escaped\\\\name")
depends_on (
    # directive comment
    "real-dependency@1:",
    when="+optional",
)
`,
    });
    const missing = result.diagnostics.filter((item) => item.code === "dependency-not-in-bundle");
    expect(missing).toEqual([
      expect.objectContaining({
        severity: "warning",
        package: "example",
        message: expect.stringContaining("real-dependency"),
      }),
    ]);
  });

  test("dynamic provides arguments cannot hide unresolved dependency candidates", async () => {
    const result = await inspect({
      "repo.yaml": repoYaml(),
      "packages/consumer/package.py": 'depends_on("mpi")',
      "packages/provider/package.py": 'provides(dynamic, when="mpi")',
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "dependency-not-in-bundle",
        message: expect.stringContaining("mpi"),
      }),
    );
  });

  test("matches every literal positional virtual name in a provides directive", async () => {
    const result = await inspect({
      "repo.yaml": repoYaml(),
      "packages/consumer/package.py": `
depends_on("mpi")
depends_on("blas")
depends_on("lapack")
depends_on("not-a-provider")
`,
      "packages/provider/package.py": `
provides("mpi", "blas", "lapack", when="not-a-provider")
`,
    });
    expect(result.diagnostics.filter((item) => item.code === "dependency-not-in-bundle")).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("not-a-provider"),
      }),
    ]);
  });

  test("reads only repo.yaml and indexed package.py in an official-sized tree", async () => {
    const contents: Record<string, string> = { "repos/spack_repo/builtin/repo.yaml": repoYaml() };
    for (let index = 0; index < 5000; index++) {
      const prefix = `repos/spack_repo/builtin/packages/pkg_${index}`;
      contents[`${prefix}/package.py`] = "class CommonHelper(Package): pass";
      contents[`${prefix}/patches/build.patch`] = "unread patch";
      contents[`${prefix}/tests/package.py`] = "unread test";
    }
    contents["docs/package.py"] = "unread documentation";
    contents["repos/spack_repo/builtin/packages/__init__.py"] = "unread module";
    const input = tree(contents);
    const result = await inspectRecipeTree(input.files, input.readText);
    expect(result.roots[0]?.packageCount).toBe(5000);
    expect(input.reads).toHaveLength(5001);
    expect(new Set(input.reads).size).toBe(5001);
    expect(input.reads).not.toContain("docs/package.py");
    expect(result.diagnostics).toHaveLength(1);
  });

  test.each([
    "repo.yaml",
    "packages/huge/package.py",
  ])("rejects an oversized %s before reading it and preserves the path", async (oversizedPath) => {
    const input = tree({
      "repo.yaml": repoYaml(),
      "packages/huge/package.py": "class Huge(Package): pass",
    });
    const files = input.files.map((file) =>
      file.path === oversizedPath ? { ...file, size: 16 * 1024 * 1024 } : file,
    );
    const result = await inspectRecipeTree(files, input.readText);
    expect(input.reads).not.toContain(oversizedPath);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "recipe-file-too-large",
        path: oversizedPath,
      }),
    );
  });

  test("leaves read and fatal UTF-8 failures to the caller instead of hiding them", async () => {
    const input = tree({ "repo.yaml": repoYaml() });
    const failure = new Error("fatal UTF-8 decode failure");
    await expect(
      inspectRecipeTree(input.files, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test("caps diagnostics at 500 with an exact omitted count and keeps late errors", async () => {
    const contents: Record<string, string> = { "repo.yaml": repoYaml() };
    for (let index = 0; index < 600; index++) {
      contents[`packages/pkg_${index}/package.py`] = `depends_on("missing-${index}")`;
    }
    contents["late/repo.yaml"] = repoYaml("late");
    contents["late/packages/huge/package.py"] = "oversized";
    const input = tree(contents);
    const files = input.files.map((file) =>
      file.path === "late/packages/huge/package.py" ? { ...file, size: 16 * 1024 * 1024 } : file,
    );
    const result = await inspectRecipeTree(files, input.readText);
    expect(result.diagnostics).toHaveLength(500);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "recipe-file-too-large" }),
    );
    expect(result.diagnostics.at(-1)).toEqual(
      expect.objectContaining({
        severity: "warning",
        code: "diagnostics-truncated",
        message: expect.stringContaining("103"),
      }),
    );
  });

  test("treats executable and invalid Python as inert text, without claiming validation", async () => {
    const result = await inspect({
      "repo.yaml": repoYaml(),
      "packages/inert/package.py": `
raise RuntimeError("MUST NOT EXECUTE")
import does_not_exist
def invalid syntax here !!
`,
    });
    expect(result.roots[0]?.packageCount).toBe(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "static-only",
        message: expect.stringContaining("not"),
      }),
    ]);
  });

  test("bounds escaped-quote attacks and keeps unterminated strings opaque", async () => {
    const program = `
      import { inspectRecipeTree } from ${JSON.stringify(import.meta.resolve("./recipe-diagnostics"))};
      const reports = [];
      for (const quote of ['"', "'"]) {
        const other = quote === '"' ? "'" : '"';
        const source = quote + ("\\\\" + quote).repeat(500_000)
          + "\\ndepends_on(" + other + "hidden" + other + ")";
        const yaml = "repo:\\n  namespace: bounded\\n  api: v2.0\\n";
        const files = [
          { path: "repo.yaml", oid: "a".repeat(40), size: yaml.length },
          { path: "packages/attack/package.py", oid: "b".repeat(40), size: source.length },
        ];
        reports.push(await inspectRecipeTree(files, async file =>
          file.path === "repo.yaml" ? yaml : source));
      }
      console.log(JSON.stringify(reports));
    `;
    const { stdout } = await exec(process.execPath, ["--eval", program], { timeout: 5000 });
    const reports = JSON.parse(stdout);
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.roots[0]?.packageCount).toBe(1);
      expect(report.diagnostics).toEqual([
        expect.objectContaining({ code: "static-only", severity: "warning" }),
      ]);
    }
  }, 10_000);

  test("rejects too many roots before reading any metadata, even with duplicate namespaces", async () => {
    const contents: Record<string, string> = {};
    for (let index = 0; index < 129; index++) {
      contents[`root_${index}/repo.yaml`] = repoYaml();
    }
    const input = tree(contents);
    const result = await inspectRecipeTree(input.files, input.readText);
    expect(input.reads).toEqual([]);
    expect(result.roots).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "recipe-root-limit" }),
    );
  });

  test("accepts the root limit without rescanning the full tree for each root", async () => {
    const contents: Record<string, string> = {};
    for (let index = 0; index < 128; index++) {
      contents[`root_${index}/repo.yaml`] = repoYaml(`namespace_${index}`);
      contents[`root_${index}/packages/pkg/package.py`] = "class Pkg(Package): pass";
      contents[`root_${index}/packages/pkg/support.patch`] = "unread";
    }
    const input = tree(contents);
    let pathReads = 0;
    const files = input.files.map((file) => ({
      ...file,
      get path() {
        pathReads++;
        return file.path;
      },
    }));
    const result = await inspectRecipeTree(files, input.readText);
    expect(result.roots).toHaveLength(128);
    expect(result.roots.every((root) => root.packageCount === 1)).toBe(true);
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(pathReads).toBeLessThan(files.length * 12);
  });

  test("indexes nested roots and sibling prefixes without losing outer package files", async () => {
    const result = await inspect({
      "repo.yaml": repoYaml("outer"),
      "packages/wrapper/package.py": 'depends_on("inner.leaf")',
      "packages/wrapper/nested/repo.yaml": repoYaml("inner"),
      "packages/wrapper/nested/packages/leaf/package.py": "class Leaf(Package): pass",
      "repo/repo.yaml": repoYaml("sibling"),
      "repository/packages/not_a_package/package.py": "unread",
    });
    expect(result.roots).toEqual([
      { path: ".", namespace: "outer", api: "v2.0", packageCount: 1 },
      { path: "packages/wrapper/nested", namespace: "inner", api: "v2.0", packageCount: 1 },
      { path: "repo", namespace: "sibling", api: "v2.0", packageCount: 0 },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", code: "static-only" }),
    ]);
  });

  test("rejects excessive tree entries before reading metadata", async () => {
    const file = tree({ "repo.yaml": repoYaml() }).files[0];
    if (!file) throw new Error("Missing test manifest");
    const result = await inspectRecipeTree(
      Array.from({ length: 100_001 }, () => file),
      async () => {
        throw new Error("Tree entry limit must be checked before reading");
      },
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "diagnostic-work-limit" }),
    );
  });

  test("reserves the aggregate metadata budget before reading package bodies", async () => {
    const contents: Record<string, string> = { "repo.yaml": repoYaml() };
    const source = `#${"x".repeat(1024 * 1024 - 1)}`;
    for (let index = 0; index < 128; index++) {
      contents[`packages/pkg_${index}/package.py`] = source;
    }
    const input = tree(contents);
    const result = await inspectRecipeTree(input.files, input.readText);
    expect(input.reads).toEqual(["repo.yaml"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "diagnostic-work-limit" }),
    );
  });

  test("counts expanded namespace names against the work budget before reading packages", async () => {
    const contents: Record<string, string> = { "repo.yaml": repoYaml("n".repeat(512 * 1024)) };
    for (let index = 0; index < 256; index++) {
      contents[`packages/pkg_${index}/package.py`] = "pass";
    }
    const input = tree(contents);
    const result = await inspectRecipeTree(input.files, input.readText);
    expect(input.reads).toEqual(["repo.yaml"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "diagnostic-work-limit" }),
    );
  });

  test("rejects excessive individual path length before reading metadata", async () => {
    const file = {
      path: `${"a/".repeat(2048)}repo.yaml`,
      oid: "a".repeat(40),
      size: repoYaml().length,
    };
    let reads = 0;
    const result = await inspectRecipeTree([file], async () => {
      reads++;
      return repoYaml();
    });
    expect(reads).toBe(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "diagnostic-work-limit" }),
    );
  });

  test("charges cumulative path bytes before building directory indexes", async () => {
    const prefix = "p".repeat(4080);
    const files: RecipeTreeFile[] = tree({ "repo.yaml": repoYaml() }).files;
    for (let index = 0; index < 40_000; index++) {
      files.push({
        get path() {
          return `${prefix}/${index.toString().padStart(6, "0")}.patch`;
        },
        oid: "b".repeat(40),
        size: 0,
      });
    }
    let reads = 0;
    const result = await inspectRecipeTree(files, async () => {
      reads++;
      return repoYaml();
    });
    expect(reads).toBe(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "error", code: "diagnostic-work-limit" }),
    );
  });

  test.each([
    "r",
    "u",
    "b",
    "f",
    "fr",
    "rf",
    "RB",
  ])("keeps %s-prefixed strings and member calls opaque while preserving literal candidates", async (prefix) => {
    const result = await inspect({
      "repo.yaml": repoYaml(),
      "packages/example/package.py": [
        `${prefix}"depends_on('hidden-in-string')"`,
        `depends_on(${prefix}"prefixed-argument")`,
        "obj.depends_on('member-call')",
        'depends_on("real-candidate")',
      ].join("\r\n"),
    });
    expect(result.diagnostics.filter((item) => item.code === "dependency-not-in-bundle")).toEqual([
      expect.objectContaining({ message: expect.stringContaining('"real-candidate"') }),
    ]);
  });

  test("keeps escaped triple-quote delimiters inside a single opaque string", async () => {
    const result = await inspect({
      "repo.yaml": repoYaml(),
      "packages/example/package.py": String.raw`
text = """escaped \""" depends_on('hidden') still inside"""
depends_on("visible")
`,
    });
    expect(result.diagnostics.filter((item) => item.code === "dependency-not-in-bundle")).toEqual([
      expect.objectContaining({ message: expect.stringContaining('"visible"') }),
    ]);
  });
});
