import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  RecipeBootstrapManifestSchema,
  SPACK_LOCK_MAX_BYTES,
  SpackMaterialImportSchema,
} from "@kuintessence/shared";
import {
  DEFAULT_RECIPE_LIMITS,
  runRecipeGit,
} from "../../../packages/registry/src/services/recipe-git";
import { selectedCase } from "../spack-case/fixture";
import { exportMaterialPack, type ExportMaterialPackOptions } from "./export";
import {
  type CaseId,
  caseRoots,
  LIMITS,
  OptionsSchema,
  type PreparedMetadata,
  TARGET,
  UPSTREAM_COMMIT,
} from "./export-contract";
import { inputInventory, verifyInventory } from "./export-files";

interface Edge {
  name: string;
  hash: string;
  parameters: { deptypes: string[]; virtuals: string[]; direct?: boolean };
}

interface LockNode {
  name: string;
  version: string;
  namespace: string;
  hash: string;
  arch: { platform: string; platform_os: string; target: string };
  parameters: Record<string, unknown>;
  package_hash?: string;
  external?: { path: string };
  dependencies: Edge[];
}

interface FixtureLock {
  _meta: Record<string, string | number>;
  spack: { version: string };
  roots: { hash: string; spec: string }[];
  concrete_specs: Record<string, LockNode>;
}

interface Fixture {
  work: string;
  input: string;
  output: string;
  tree: string;
  metadata: PreparedMetadata;
  lock: FixtureLock;
  options: ExportMaterialPackOptions;
}

let suite: string;
const seeds = new Map<CaseId, Fixture>();
const workspaces: string[] = [];
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const git = (directory: string, args: string[]) =>
  runRecipeGit(directory, args, DEFAULT_RECIPE_LIMITS);

function lockFor(caseId: CaseId): FixtureLock {
  const names =
    caseId === "hello"
      ? ["hello", "gcc", "gmake"]
      : ["samtools", "htslib", "zlib", "ncurses", "pkgconf", "gcc", "gmake", "python", "perl"];
  const externals = new Set(["gcc", "gmake", "python", "perl"]);
  const versions: Record<string, string> = {
    hello: "2.12.1",
    samtools: "1.19.2",
    htslib: "1.19.1",
    zlib: "1.3.1",
  };
  const nodes = names.map(
    (name, index): LockNode => ({
      name,
      version: versions[name] ?? "1.0",
      namespace: name === "hello" ? "kq_case" : "builtin",
      hash: String.fromCharCode(97 + index).repeat(32),
      arch: { platform: "linux", platform_os: "ubuntu20.04", target: "x86_64" },
      parameters:
        name === "htslib"
          ? { libcurl: false, libdeflate: false }
          : name === "ncurses"
            ? { symlinks: true }
            : {},
      ...(externals.has(name)
        ? { external: { path: "/usr" } }
        : { package_hash: "b".repeat(32) }),
      dependencies: [],
    }),
  );
  const root = nodes[0];
  if (!root) throw new Error("Missing fixture root");
  root.dependencies = nodes.slice(1).filter((node) => node.name !== "pkgconf").map(edgeFor);
  const ncurses = nodes.find((node) => node.name === "ncurses");
  const pkgconf = nodes.find((node) => node.name === "pkgconf");
  if (ncurses && pkgconf) {
    ncurses.dependencies = [
      {
        ...edgeFor(pkgconf),
        parameters: { deptypes: ["build"], virtuals: ["pkgconfig"] },
      },
    ];
  }
  return {
    _meta: { "file-type": "spack-lockfile", "lockfile-version": 6, "specfile-version": 5 },
    spack: { version: "1.0.0" },
    roots: [{ hash: root.hash, spec: selectedCase(caseId).spec }],
    concrete_specs: Object.fromEntries(nodes.map((node) => [node.hash, node])),
  };
}

function edgeFor(node: LockNode): Edge {
  return {
    name: node.name,
    hash: node.hash,
    parameters: { deptypes: ["build", "link"], virtuals: [] },
  };
}

async function put(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await writeFile(path, value, { mode: 0o644 });
}

async function writeMetadata(fixture: Fixture): Promise<void> {
  await put(join(fixture.input, "metadata.json"), `${JSON.stringify(fixture.metadata)}\n`);
}

async function writeLock(fixture: Fixture): Promise<void> {
  await put(join(fixture.input, "spack.lock"), `${JSON.stringify(fixture.lock, null, 2)}\n`);
}

async function bundle(fixture: Fixture, refs = ["HEAD", "refs/heads/case"]): Promise<void> {
  await rm(join(fixture.input, "recipes.bundle"), { force: true });
  await git(fixture.tree, ["bundle", "create", join(fixture.input, "recipes.bundle"), ...refs]);
  await chmod(join(fixture.input, "recipes.bundle"), 0o644);
  fixture.metadata.commit = (await git(fixture.tree, ["rev-parse", "HEAD"])).stdout.toString().trim();
  await writeMetadata(fixture);
}

async function makeSeed(caseId: CaseId): Promise<Fixture> {
  const work = await mkdtemp(join(suite, `${caseId}-seed-`));
  const input = join(work, "input");
  const tree = join(work, "tree");
  await mkdir(input, { mode: 0o755 });
  await mkdir(tree, { mode: 0o755 });
  const lock = lockFor(caseId);
  const metadata: PreparedMetadata = {
    case: caseId,
    spec: selectedCase(caseId).spec,
    target: TARGET,
    commit: "a".repeat(40),
    roots: caseRoots(caseId),
    sources: [
      { path: `${caseId}/source.tar.gz`, file: `sources/${caseId}/source.tar.gz` },
      {
        path: "_source-cache/archive/aa/source.tar.gz",
        file: "sources/_source-cache/archive/aa/source.tar.gz",
      },
    ],
    lockfile: "spack.lock",
  };
  for (const root of metadata.roots) {
    await put(
      join(tree, root, "repo.yaml"),
      `repo:\n  namespace: ${root.endsWith("kq_case") ? "kq_case" : "builtin"}\n  api: v2.2\n`,
    );
  }
  for (const node of Object.values(lock.concrete_specs)) {
    if (node.external) continue;
    await put(
      join(
        tree,
        "repos/spack_repo",
        node.namespace,
        "packages",
        node.name.replaceAll("-", "_"),
        "package.py",
      ),
      "# Test-only recipe; no Python is executed.\n",
    );
  }
  for (const name of ["COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT"]) {
    await put(join(tree, name), "Synthetic test fixture notice, not upstream content.\n");
  }
  await put(
    join(tree, "upstream.json"),
    JSON.stringify({ repository: "spack/spack-packages", commit: UPSTREAM_COMMIT }),
  );
  await git(tree, ["init", "--template="]);
  await git(tree, ["symbolic-ref", "HEAD", "refs/heads/case"]);
  await git(tree, ["add", "--all"]);
  await git(tree, ["-c", "commit.gpgsign=false", "commit", "-m", "Synthetic export fixture"]);
  const fixture: Fixture = {
    work,
    input,
    output: join(work, "delivery"),
    tree,
    metadata,
    lock,
    options: {
      inputDirectory: input,
      outputDirectory: join(work, "delivery"),
      caseId,
      recipeRepository: `public/${caseId}-recipes`,
      materialRepository: `public/${caseId}-sources`,
    },
  };
  for (const source of metadata.sources) {
    await put(join(input, source.file), Buffer.from("synthetic source bytes\0\xff\n", "latin1"));
  }
  await writeLock(fixture);
  await bundle(fixture);
  return fixture;
}

async function fixture(caseId: CaseId = "hello"): Promise<Fixture> {
  const seed = seeds.get(caseId);
  if (!seed) throw new Error("Missing fixture seed");
  const work = await mkdtemp(join(suite, "test-"));
  workspaces.push(work);
  const input = join(work, "input");
  const output = join(work, "delivery");
  await cp(seed.input, input, { recursive: true });
  return {
    ...seed,
    work,
    input,
    output,
    tree: join(work, "tree"),
    metadata: structuredClone(seed.metadata),
    lock: structuredClone(seed.lock),
    options: { ...seed.options, inputDirectory: input, outputDirectory: output },
  };
}

async function mutableTree(fixture: Fixture): Promise<void> {
  const seed = seeds.get(fixture.options.caseId);
  if (!seed) throw new Error("Missing fixture seed");
  await cp(seed.tree, fixture.tree, { recursive: true });
}

async function expectRejected(fixture: Fixture, message?: string): Promise<void> {
  if (message) await expect(exportMaterialPack(fixture.options)).rejects.toThrow(message);
  else await expect(exportMaterialPack(fixture.options)).rejects.toThrow();
  await expect(lstat(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(fixture.work)).filter((name) => name.startsWith(".delivery."))).toEqual([]);
}

beforeAll(async () => {
  // Real Git runs only when this test suite is explicitly executed in Actions.
  suite = await mkdtemp(join(await realpath(tmpdir()), "kq-export-tests-"));
  for (const caseId of ["hello", "samtools"] satisfies CaseId[]) {
    seeds.set(caseId, await makeSeed(caseId));
  }
}, 30_000);

afterEach(async () => {
  for (const work of workspaces.splice(0)) await rm(work, { recursive: true, force: true });
});

afterAll(async () => {
  if (suite) await rm(suite, { recursive: true, force: true });
});

test.each(["hello", "samtools"] satisfies CaseId[])(
  "exports %s with a real bundle, unchanged payloads, and deduplicated mirror aliases",
  async (caseId) => {
    const sample = await fixture(caseId);
    await exportMaterialPack(sample.options);
    const recipe = RecipeBootstrapManifestSchema.parse(
      JSON.parse(await readFile(join(sample.output, "recipe-pack/manifest.json"), "utf8")),
    );
    expect(recipe.repositories).toEqual([
      { repository: sample.options.recipeRepository, bundlePath: "recipes.bundle" },
    ]);
    expect(await readFile(join(sample.output, "recipe-pack/recipes.bundle"))).toEqual(
      await readFile(join(sample.input, "recipes.bundle")),
    );
    const material = SpackMaterialImportSchema.parse(
      JSON.parse(await readFile(join(sample.output, "material-pack/manifest.json"), "utf8")),
    );
    const release = material.releases[0];
    expect(release).toBeDefined();
    if (!release) throw new Error("Missing release");
    expect(release.recipes).toEqual([
      {
        repositoryId: hash(Buffer.from(sample.options.recipeRepository)),
        commit: sample.metadata.commit,
        roots: sample.metadata.roots,
      },
    ]);
    expect(release.spec).toBe(sample.metadata.spec);
    expect(material.files).toHaveLength(2);
    expect(release.sources).toHaveLength(2);
    expect(new Set(release.sources.map((source) => source.blob.digest)).size).toBe(1);
    for (const entry of material.files) {
      const path = join(sample.output, "material-pack", entry.path);
      const bytes = await readFile(path);
      expect(entry.blob).toEqual({ digest: `sha256:${hash(bytes)}`, size: bytes.byteLength });
      expect(bytes).toEqual(
        await readFile(
          join(
            sample.input,
            entry.blob.digest === release.lockfile.digest
              ? "spack.lock"
              : `sources/${caseId}/source.tar.gz`,
          ),
        ),
      );
      const stat = await lstat(path);
      expect(stat.isFile()).toBe(true);
      expect(stat.nlink).toBe(1);
      expect(stat.mode & 0o777).toBe(0o644);
    }
    const checksumLines = (await readFile(join(sample.output, "checksums.txt"), "utf8"))
      .trim()
      .split("\n");
    const covered: string[] = [];
    for (const line of checksumLines) {
      const [expected, path] = line.split("  ");
      if (!path) throw new Error("Missing checksum path");
      expect(hash(await readFile(join(sample.output, path)))).toBe(expected);
      covered.push(path);
    }
    expect(covered).toEqual(
      [
        "README.md",
        ...material.files.map((entry) => `material-pack/${entry.path}`),
        "material-pack/manifest.json",
        "provenance.json",
        "recipe-pack/manifest.json",
        "recipe-pack/recipes.bundle",
      ].sort(),
    );
    const provenance = await readFile(join(sample.output, "provenance.json"), "utf8");
    expect(provenance).not.toContain(suite);
    expect(provenance).not.toContain("manifestDigest");
    expect(provenance).not.toContain('"archive"');
    expect(JSON.parse(provenance)).toMatchObject({
      case: caseId,
      materialRepositoryId: hash(Buffer.from(sample.options.materialRepository)),
      validation: {
        kind: "static-only",
        sourceCoverage: "not-revalidated",
        licenseReview: "not-performed",
      },
    });
    expect(await readFile(join(sample.output, "README.md"), "utf8")).toContain(
      "Do not redistribute without reviewing",
    );
    expect((await lstat(sample.output)).mode & 0o777).toBe(0o755);
    expect((await readdir(sample.work)).filter((name) => name.startsWith(".delivery."))).toEqual([]);
  },
  30_000,
);

const metadataFailures: { name: string; change: (metadata: PreparedMetadata) => void }[] = [
  {
    name: "case mismatch",
    change: (metadata) => {
      metadata.case = "samtools";
    },
  },
  {
    name: "arbitrary spec",
    change: (metadata) => {
      metadata.spec = "hello@9";
    },
  },
  {
    name: "root order",
    change: (metadata) => {
      metadata.roots.reverse();
    },
  },
  {
    name: "duplicate roots",
    change: (metadata) => {
      metadata.roots = ["repos/spack_repo/kq_case", "repos/spack_repo/kq_case"];
    },
  },
  {
    name: "traversal",
    change: (metadata) => {
      metadata.sources[0] = { path: "../escape", file: "sources/../escape" };
    },
  },
  {
    name: "alias mismatch",
    change: (metadata) => {
      metadata.sources[0] = { path: "hello/other", file: "sources/hello/source.tar.gz" };
    },
  },
  {
    name: "duplicate source path",
    change: (metadata) => {
      metadata.sources.push({ path: "hello/source.tar.gz", file: "sources/hello/source.tar.gz" });
    },
  },
  {
    name: "source entry budget",
    change: (metadata) => {
      metadata.sources = Array.from({ length: 129 }, (_, index) => ({
        path: `p${index}`,
        file: `sources/p${index}`,
      }));
    },
  },
];
test.each(metadataFailures)("rejects $name without a partial delivery", async ({ change }) => {
  const sample = await fixture();
  change(sample.metadata);
  await writeMetadata(sample);
  await expectRejected(sample);
});

test("rejects unknown cases and unknown option/metadata fields", async () => {
  const sample = await fixture();
  expect(OptionsSchema.safeParse({ ...sample.options, caseId: "arbitrary" }).success).toBe(false);
  expect(OptionsSchema.safeParse({ ...sample.options, spec: "other" }).success).toBe(false);
  await put(
    join(sample.input, "metadata.json"),
    JSON.stringify({ ...sample.metadata, license_ack: true, environment: "must-not-export" }),
  );
  await expectRejected(sample);
});

test.each(["extra-file", "empty-directory", "missing-source"])("rejects %s input", async (kind) => {
  const sample = await fixture();
  if (kind === "extra-file") await put(join(sample.input, ".DS_Store"), "extra");
  if (kind === "empty-directory") await mkdir(join(sample.input, "extra"));
  if (kind === "missing-source") await rm(join(sample.input, "sources/hello/source.tar.gz"));
  await expectRejected(sample);
});

test.each([
  "symlink",
  "hardlink",
  "writable-file",
  "writable-directory",
  "directory-file",
  "empty-file",
])(
  "rejects %s in the prepared tree",
  async (kind) => {
    const sample = await fixture();
    const path = join(sample.input, "sources/hello/source.tar.gz");
    if (kind === "symlink" || kind === "hardlink") {
      const other = join(sample.work, "outside");
      await put(other, "not a prepared ordinary file");
      await rm(path);
      if (kind === "symlink") await symlink(other, path);
      else await link(other, path);
    }
    if (kind === "writable-file") await chmod(path, 0o666);
    if (kind === "writable-directory") await chmod(dirname(path), 0o777);
    if (kind === "directory-file") {
      await rm(path);
      await mkdir(path);
    }
    if (kind === "empty-file") await truncate(path, 0);
    await expectRejected(sample);
  },
);

const sizeFailures: { path: string; maximum: number }[] = [
  { path: "metadata.json", maximum: LIMITS.metadata },
  { path: "recipes.bundle", maximum: LIMITS.bundle },
  { path: "spack.lock", maximum: SPACK_LOCK_MAX_BYTES },
  { path: "sources/hello/source.tar.gz", maximum: LIMITS.sources },
];
test.each(sizeFailures)(
  "rejects oversized $path before reading its bytes",
  async ({ path, maximum }) => {
    const sample = await fixture();
    await truncate(join(sample.input, path), maximum + 1);
    await expectRejected(sample);
  },
);

test("charges every source alias before digest deduplication", async () => {
  const sample = await fixture();
  for (const source of sample.metadata.sources) {
    await truncate(join(sample.input, source.file), LIMITS.sources / 2 + 1);
  }
  await expectRejected(sample, "Source alias byte budget exceeded");
});

test("rejects bundle HEAD mismatch and malformed packs without publishing", async () => {
  const sample = await fixture();
  sample.metadata.commit = "f".repeat(40);
  await writeMetadata(sample);
  await expectRejected(sample, "Bundle references do not match");
  await put(join(sample.input, "recipes.bundle"), "not a Git bundle");
  await expectRejected(sample);
});

test("requires HEAD and refuses prerequisite bundles", async () => {
  const sample = await fixture();
  await mutableTree(sample);
  await bundle(sample, ["refs/heads/case"]);
  await expectRejected(sample, "Bundle references do not match");
  const previous = sample.metadata.commit;
  await put(join(sample.tree, "extra"), "second commit");
  await git(sample.tree, ["add", "--all"]);
  await git(sample.tree, ["-c", "commit.gpgsign=false", "commit", "-m", "Second"]);
  await bundle(sample, ["HEAD", "refs/heads/case", `^${previous}`]);
  await expectRejected(sample);
}, 30_000);

test.each(["symlink", "missing-recipe", "wrong-namespace", "wrong-upstream"])(
  "rejects real bundle with %s",
  async (kind) => {
    const sample = await fixture();
    await mutableTree(sample);
    const root = join(sample.tree, "repos/spack_repo/kq_case");
    if (kind === "symlink") await symlink("LICENSE-MIT", join(sample.tree, "linked-notice"));
    if (kind === "missing-recipe") await rm(join(root, "packages/hello/package.py"));
    if (kind === "wrong-namespace") {
      await put(join(root, "repo.yaml"), "repo:\n  namespace: wrong\n  api: v2.2\n");
    }
    if (kind === "wrong-upstream") await put(join(sample.tree, "upstream.json"), "{}");
    await git(sample.tree, ["add", "--all"]);
    await git(sample.tree, ["-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit"]);
    await bundle(sample);
    await expectRejected(sample);
  },
  30_000,
);

function nodeNamed(lock: FixtureLock, name: string): LockNode {
  const node = Object.values(lock.concrete_specs).find((node) => node.name === name);
  if (!node) throw new Error("Missing fixture node");
  return node;
}

const lockFailures: { name: string; change: (lock: FixtureLock) => void }[] = [
  {
    name: "root spec",
    change: (lock) => {
      const root = lock.roots[0];
      if (!root) throw new Error("Missing fixture root");
      root.spec = "samtools@9";
    },
  },
  {
    name: "root version",
    change: (lock) => {
      nodeNamed(lock, "samtools").version = "9";
    },
  },
  {
    name: "htslib version",
    change: (lock) => {
      nodeNamed(lock, "htslib").version = "9";
    },
  },
  {
    name: "zlib version",
    change: (lock) => {
      nodeNamed(lock, "zlib").version = "9";
    },
  },
  {
    name: "missing pkgconf",
    change: (lock) => {
      const provider = nodeNamed(lock, "pkgconf");
      delete lock.concrete_specs[provider.hash];
      nodeNamed(lock, "ncurses").dependencies = [];
    },
  },
  {
    name: "ncurses hardlinks",
    change: (lock) => {
      nodeNamed(lock, "ncurses").parameters.symlinks = false;
    },
  },
  {
    name: "nonadjacent provider",
    change: (lock) => {
      nodeNamed(lock, "ncurses").dependencies = [];
      nodeNamed(lock, "samtools").dependencies.push(edgeFor(nodeNamed(lock, "pkgconf")));
    },
  },
  {
    name: "provider hash mismatch",
    change: (lock) => {
      for (const edge of nodeNamed(lock, "ncurses").dependencies) {
        edge.hash = nodeNamed(lock, "htslib").hash;
      }
    },
  },
  {
    name: "non-build provider",
    change: (lock) => {
      for (const edge of nodeNamed(lock, "ncurses").dependencies) {
        edge.parameters.deptypes = ["run"];
      }
    },
  },
  {
    name: "missing pkgconfig virtual",
    change: (lock) => {
      for (const edge of nodeNamed(lock, "ncurses").dependencies) {
        edge.parameters.virtuals = [];
      }
    },
  },
  {
    name: "pkg-config replacement",
    change: (lock) => {
      nodeNamed(lock, "pkgconf").name = "pkg-config";
      for (const node of Object.values(lock.concrete_specs)) {
        for (const edge of node.dependencies) {
          if (edge.name === "pkgconf") edge.name = "pkg-config";
        }
      }
    },
  },
];
test.each(lockFailures)("rejects lock $name", async ({ change }) => {
  const sample = await fixture("samtools");
  change(sample.lock);
  await writeLock(sample);
  await expectRejected(sample);
});

test("rejects more than sixteen native nodes", async () => {
  const sample = await fixture();
  const root = sample.lock.concrete_specs["a".repeat(32)];
  if (!root) throw new Error("Missing root");
  for (let index = 3; index < 17; index++) {
    const node: LockNode = {
      ...root,
      name: "glibc",
      namespace: "builtin",
      hash: String.fromCharCode(97 + index).repeat(32),
      external: { path: "/usr" },
      dependencies: [],
    };
    sample.lock.concrete_specs[node.hash] = node;
    root.dependencies.push(edgeFor(node));
  }
  await writeLock(sample);
  await expectRejected(sample, "Prepared lock failed fixed-case validation");
});

test("accepts supporting solver-selected versions without rewriting the lock", async () => {
  const sample = await fixture("samtools");
  for (const node of Object.values(sample.lock.concrete_specs)) {
    if (node.name === "ncurses" || node.name === "pkgconf") node.version = "99.1";
  }
  await writeLock(sample);
  await exportMaterialPack(sample.options);
  const bytes = await readFile(join(sample.input, "spack.lock"));
  expect(await readFile(join(sample.output, "material-pack/blobs", hash(bytes)))).toEqual(bytes);
}, 30_000);

test("accepts a native adjacent provider with direct absent or false, preserving lock bytes", async () => {
  for (const direct of [undefined, false]) {
    const sample = await fixture("samtools");
    for (const edge of nodeNamed(sample.lock, "ncurses").dependencies) {
      if (direct === undefined) delete edge.parameters.direct;
      else edge.parameters.direct = direct;
    }
    await writeLock(sample);
    await exportMaterialPack(sample.options);
    const bytes = await readFile(join(sample.input, "spack.lock"));
    expect(await readFile(join(sample.output, "material-pack/blobs", hash(bytes)))).toEqual(bytes);
  }
}, 30_000);

test("refuses broader material namespaces and preserves an existing destination", async () => {
  const sample = await fixture();
  await expectRejected(
    { ...sample, options: { ...sample.options, recipeRepository: "org/private/recipes" } },
    "Export requires public/public or same-owner org/org repositories",
  );
  await mkdir(sample.output);
  await put(join(sample.output, "sentinel"), "keep");
  await expect(exportMaterialPack(sample.options)).rejects.toThrow("already exists");
  expect(await readFile(join(sample.output, "sentinel"), "utf8")).toBe("keep");
  expect((await readdir(sample.work)).filter((name) => name.startsWith(".delivery."))).toEqual([]);
});

test("rejects input symlinks and nested outputs", async () => {
  const sample = await fixture();
  await symlink(sample.input, join(sample.work, "input-link"));
  await expectRejected({
    ...sample,
    options: { ...sample.options, inputDirectory: join(sample.work, "input-link") },
  });
  await expect(
    exportMaterialPack({ ...sample.options, outputDirectory: join(sample.input, "delivery") }),
  ).rejects.toThrow("must be separate");
  await expect(lstat(join(sample.input, "delivery"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("inventory detects both content replacement and extra entries after inspection", async () => {
  const sample = await fixture();
  const expected = new Map([
    ["metadata.json", LIMITS.metadata],
    ["recipes.bundle", LIMITS.bundle],
    ["spack.lock", SPACK_LOCK_MAX_BYTES],
    ...sample.metadata.sources.map((source): [string, number] => [source.file, LIMITS.sources]),
  ]);
  const before = await inputInventory(sample.input, expected);
  await put(join(sample.input, "extra"), "changed");
  await expect(verifyInventory(sample.input, before)).rejects.toThrow("changed");
  await rm(join(sample.input, "extra"));
  const second = await inputInventory(sample.input, expected);
  await rm(join(sample.input, "sources/hello/source.tar.gz"));
  await put(join(sample.input, "sources/hello/source.tar.gz"), "replacement");
  await expect(verifyInventory(sample.input, second)).rejects.toThrow("changed");
});

test("CLI rejects unknown cases with a fixed safe error and no output", async () => {
  const sample = await fixture();
  try {
    await promisify(execFile)(
      process.execPath,
      [
        join(import.meta.dir, "export.ts"),
        sample.input,
        sample.output,
        "unknown",
        "public/r",
        "public/m",
      ],
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        env: { PATH: process.env.PATH, PRIVATE_MARKER: "not-for-output" },
      },
    );
    throw new Error("CLI unexpectedly succeeded");
  } catch (error) {
    expect(error).toHaveProperty("code", 1);
    expect(error).toHaveProperty("stdout", "");
    expect(error).toHaveProperty("stderr", "Invalid material pack export arguments\n");
  }
  await expect(lstat(sample.output)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

test("concurrent exporters cannot replace each other's destination or staging lock", async () => {
  const sample = await fixture();
  const results = await Promise.allSettled([
    exportMaterialPack(sample.options),
    exportMaterialPack(sample.options),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect((await readdir(sample.work)).filter((name) => name.startsWith(".delivery."))).toEqual([]);
  const pack = SpackMaterialImportSchema.parse(
    JSON.parse(await readFile(join(sample.output, "material-pack/manifest.json"), "utf8")),
  );
  expect(pack.releases).toHaveLength(1);
}, 30_000);

const rejectedNamespaces: [string, string][] = [
  ["public/recipes", "org/team/materials"],
  ["org/team/recipes", "public/materials"],
  ["org/team/recipes", "org/other/materials"],
  ["user/alice/recipes", "user/alice/materials"],
  ["public/recipes", "user/alice/materials"],
  ["user/alice/recipes", "public/materials"],
  ["org/team/recipes", "user/team/materials"],
  ["user/team/recipes", "org/team/materials"],
];
test.each(rejectedNamespaces)(
  "rejects export namespace pairing %s -> %s",
  async (recipeRepository, materialRepository) => {
    const sample = await fixture();
    await expectRejected(
      { ...sample, options: { ...sample.options, recipeRepository, materialRepository } },
      "Export requires public/public or same-owner org/org repositories",
    );
  },
);

test("exports same-owner org repositories with exact repository IDs", async () => {
  const sample = await fixture();
  const recipeRepository = "org/team/recipes";
  const materialRepository = "org/team/materials";
  await exportMaterialPack({ ...sample.options, recipeRepository, materialRepository });
  const pack = SpackMaterialImportSchema.parse(
    JSON.parse(await readFile(join(sample.output, "material-pack/manifest.json"), "utf8")),
  );
  expect(pack.releases[0]?.repository).toBe(materialRepository);
  expect(pack.releases[0]?.recipes[0]?.repositoryId).toBe(hash(Buffer.from(recipeRepository)));
}, 30_000);
