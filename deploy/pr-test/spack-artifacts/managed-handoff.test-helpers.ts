import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type RecipeRepository,
  type SpackMaterialImport,
  type SpackMaterialManifest,
  type SpackMaterialPublish,
  type SpackMaterialSummary,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import { selectedCase } from "../spack-case/fixture";
import {
  type CaseId,
  caseRoots,
  repositoryId,
  TARGET,
  UPSTREAM_COMMIT,
  UPSTREAM_TREE,
} from "./export-contract";
import { ManagedHandoffError, type ManagedHandoffOptions, runManagedHandoff } from "./managed-handoff";
import { handoffDigest, type ManagedProvenance } from "./managed-handoff-input";

export interface HandoffFixture {
  work: string;
  directory: string;
  control: string;
  lock: Buffer;
  source: Buffer;
  bundle: Buffer;
  archive: Buffer;
  release: SpackMaterialPublish;
  manifest: SpackMaterialManifest;
  pack: SpackMaterialImport;
  recipeInput: {
    version: 1;
    repositories: { repository: string; bundlePath: string }[];
  };
  provenance: ManagedProvenance;
  recipe: RecipeRepository;
  files: Map<string, Buffer>;
  responses: Map<string, { status: number; bytes: Uint8Array }>;
  requests: { url: string; init: RequestInit }[];
  options: ManagedHandoffOptions;
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
  dependencies: {
    name: string;
    hash: string;
    parameters: { deptypes: string[]; virtuals: string[] };
  }[];
}

export function handoffFixtureLock(caseId: CaseId) {
  const names =
    caseId === "hello"
      ? ["hello", "gcc", "gmake"]
      : ["samtools", "htslib", "zlib", "ncurses", "pkgconf", "gcc", "gmake", "python", "perl"];
  const versions: Record<string, string> = {
    hello: "2.12.1",
    samtools: "1.19.2",
    htslib: "1.19.1",
    zlib: "1.3.1",
  };
  const external = new Set(["gcc", "gmake", "python", "perl"]);
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
      ...(external.has(name)
        ? { external: { path: "/usr" } }
        : { package_hash: "b".repeat(32) }),
      dependencies: [],
    }),
  );
  const root = nodes[0];
  assert(root);
  const edge = (node: LockNode) => ({
    name: node.name,
    hash: node.hash,
    parameters: { deptypes: ["build", "link"], virtuals: [] as string[] },
  });
  root.dependencies = nodes.slice(1).filter((node) => node.name !== "pkgconf").map(edge);
  const ncurses = nodes.find((node) => node.name === "ncurses");
  const pkgconf = nodes.find((node) => node.name === "pkgconf");
  if (ncurses && pkgconf) {
    ncurses.dependencies = [
      {
        ...edge(pkgconf),
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

export const encoded = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export async function putHandoffFile(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await writeFile(path, bytes, { mode: 0o644 });
  await chmod(path, 0o644);
}

export async function createHandoffFixture(caseId: CaseId = "hello"): Promise<HandoffFixture> {
  const work = await realpath(await mkdtemp(join(tmpdir(), "kq-managed-handoff-")));
  const directory = join(work, "delivery");
  const control = join(work, "control");
  await mkdir(directory);
  await mkdir(control);
  await putHandoffFile(join(control, "bindings.json"), Buffer.from("{}\n"));
  const fixture = selectedCase(caseId);
  const lock = encoded(handoffFixtureLock(caseId));
  const source = Buffer.from("synthetic source bytes\0\xff\n", "latin1");
  // HTTP/byte-contract fixtures only: these bytes are never imported or executed as Git/recipes.
  const bundle = Buffer.from("synthetic bundle bytes\n");
  const archive = Buffer.from("synthetic archive bytes\n");
  const commit = "a".repeat(40);
  const selection = {
    repositoryId: repositoryId(fixture.recipes),
    commit,
    roots: caseRoots(caseId),
  };
  const release: SpackMaterialPublish = {
    version: 1,
    repository: fixture.repository,
    spec: fixture.spec,
    target: TARGET,
    spackVersion: "1.0.0",
    redistribution: "unrestricted",
    recipes: [selection],
    sources: [{ path: `${caseId}/source.tar.gz`, blob: handoffDigest(source) }],
    lockfile: handoffDigest(lock),
  };
  const manifest: SpackMaterialManifest = {
    ...structuredClone(release),
    recipes: [{ ...selection, archive: handoffDigest(archive) }],
  };
  const pack: SpackMaterialImport = {
    version: 1,
    releases: [release],
    files: [lock, source].map((bytes) => {
      const blob = handoffDigest(bytes);
      return { path: `blobs/${blob.digest.slice(7)}`, blob };
    }),
  };
  const recipeInput: HandoffFixture["recipeInput"] = {
    version: 1,
    repositories: [{ repository: fixture.recipes, bundlePath: "recipes.bundle" }],
  };
  const provenance: ManagedProvenance = {
    version: 1,
    case: caseId,
    spec: fixture.spec,
    target: TARGET,
    spackVersion: "1.0.0",
    preparationContract: {
      upstreamRepository: "spack/spack-packages",
      upstreamCommit: UPSTREAM_COMMIT,
      upstreamTree: UPSTREAM_TREE,
      clingoVersion: "5.7.1",
    },
    recipe: { repository: fixture.recipes, ...selection, bundle: handoffDigest(bundle) },
    materialRepository: fixture.repository,
    materialRepositoryId: repositoryId(fixture.repository),
    preparedMetadata: handoffDigest(Buffer.from("synthetic prepared metadata")),
    lockfile: handoffDigest(lock),
    rootHash: "a".repeat(32),
    sources: structuredClone(release.sources),
    validation: {
      kind: "static-only",
      nativeDAGHashes: "not-recomputed",
      sourceCoverage: "not-revalidated",
      upstreamTree: "preparation-contract-only",
      licenseReview: "not-performed",
    },
  };
  const recipe: RecipeRepository = {
    id: selection.repositoryId,
    repository: fixture.recipes,
    activeCommit: null,
    snapshots: [
      {
        commit,
        importedAt: "2026-09-22T00:00:00.000Z",
        importedBy: "fixture-operator",
        bundleSha256: handoffDigest(bundle).digest.slice(7),
        fileCount: 3,
        totalBytes: 100,
        roots: selection.roots.map((path) => ({
          path,
          namespace: path.split("/").at(-1) ?? "",
          api: "v2.2",
          packageCount: 1,
        })),
        diagnostics: [],
        validation: "static-only",
      },
    ],
  };
  const files = new Map<string, Buffer>([
    ["README.md", Buffer.from("Synthetic handoff fixture; no real import.\n")],
    ["recipe-pack/recipes.bundle", bundle],
    ...[lock, source].map((bytes): [string, Buffer] => [
      `material-pack/blobs/${handoffDigest(bytes).digest.slice(7)}`,
      bytes,
    ]),
  ]);
  const responses = new Map<string, { status: number; bytes: Uint8Array }>();
  const requests: { url: string; init: RequestInit }[] = [];
  const options: ManagedHandoffOptions = {
    deliveryDirectory: directory,
    controlDirectory: control,
    environment: { GITHUB_ACTIONS: "true", KQ_PR_TEST: "1", KQ_PR_SPACK_CASE: caseId },
    pollIntervalMs: 0,
    fetcher: async (url, init) => {
      requests.push({ url, init });
      const response = responses.get(url);
      assert(response, "Unexpected fixture URL");
      return new Response(Uint8Array.from(response.bytes), { status: response.status });
    },
  };
  const result: HandoffFixture = {
    work,
    directory,
    control,
    lock,
    source,
    bundle,
    archive,
    release,
    manifest,
    pack,
    recipeInput,
    provenance,
    recipe,
    files,
    responses,
    requests,
    options,
  };
  await sealHandoffDelivery(result);
  setHandoffResponses(result);
  return result;
}

type DeliveryFixture = Pick<
  HandoffFixture,
  "files" | "directory" | "pack" | "recipeInput" | "provenance"
>;

export async function sealHandoffDelivery(fixture: DeliveryFixture) {
  fixture.files.set("material-pack/manifest.json", encoded(fixture.pack));
  fixture.files.set("recipe-pack/manifest.json", encoded(fixture.recipeInput));
  fixture.files.set("provenance.json", encoded(fixture.provenance));
  const checksums = [...fixture.files.keys()]
    .sort()
    .map((path) => {
      const bytes = fixture.files.get(path);
      assert(bytes);
      return `${handoffDigest(bytes).digest.slice(7)}  ${path}\n`;
    })
    .join("");
  for (const [path, bytes] of fixture.files) {
    await putHandoffFile(join(fixture.directory, path), bytes);
  }
  await putHandoffFile(join(fixture.directory, "checksums.txt"), Buffer.from(checksums));
}

export function setHandoffResponses(
  fixture: Pick<HandoffFixture, "manifest" | "recipe" | "responses" | "lock" | "source" | "archive">,
) {
  const root = "http://registry:3100/api";
  const manifestBytes = encoded(fixture.manifest);
  const binding = {
    repositoryId: repositoryId(fixture.manifest.repository),
    manifestDigest: handoffDigest(manifestBytes).digest,
  };
  const base = `${root}/spack/material-repositories`;
  const releasePath = `${base}/${binding.repositoryId}/releases/${binding.manifestDigest}`;
  const blobs = new Map(spackMaterialBlobs(fixture.manifest).map((blob) => [blob.digest, blob]));
  const summary: SpackMaterialSummary = {
    ...binding,
    repository: fixture.manifest.repository,
    spec: fixture.manifest.spec,
    target: fixture.manifest.target,
    spackVersion: fixture.manifest.spackVersion,
    redistribution: fixture.manifest.redistribution,
    sourceCount: fixture.manifest.sources.length,
    totalBytes: [...blobs.values()].reduce((sum, blob) => sum + blob.size, 0),
  };
  const catalog = `${base}?repository=${encodeURIComponent(fixture.manifest.repository)}`;
  fixture.responses.set("http://server:3000/api/auth/login", {
    status: 200,
    bytes: encoded({ token: "synthetic-test-token" }),
  });
  fixture.responses.set(catalog, { status: 200, bytes: encoded({ releases: [summary] }) });
  fixture.responses.set(releasePath, { status: 200, bytes: manifestBytes });
  fixture.responses.set(`${root}/spack/recipe-repositories/${fixture.recipe.id}`, {
    status: 200,
    bytes: encoded(fixture.recipe),
  });
  for (const bytes of [fixture.lock, fixture.source, fixture.archive]) {
    fixture.responses.set(`${releasePath}/blobs/${handoffDigest(bytes).digest}`, { status: 200, bytes });
  }
  for (const selection of fixture.manifest.recipes) {
    fixture.responses.set(
      `${root}/spack/recipe-repositories/${selection.repositoryId}/snapshots/${selection.commit}/archive`,
      { status: 200, bytes: fixture.archive },
    );
  }
  return { binding, catalog, releasePath, summary };
}

export async function handoffControlBytes(fixture: Pick<HandoffFixture, "control">) {
  return Promise.all(
    ["bindings.json", "release.json", "managed-lock.json"].map(async (name) => ({
      name,
      bytes: await readFile(join(fixture.control, name)),
    })),
  );
}

export async function withHandoffFixture(
  caseId: CaseId,
  run: (fixture: HandoffFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createHandoffFixture(caseId);
  try {
    await run(fixture);
  } finally {
    await rm(fixture.work, { recursive: true, force: true });
  }
}

export async function rejectHandoff(
  fixture: HandoffFixture,
  phase: "prepare" | "verify",
  stage: ManagedHandoffError["stage"],
): Promise<void> {
  await assert.rejects(runManagedHandoff(phase, fixture.options), (error: unknown) => {
    assert(error instanceof ManagedHandoffError);
    assert.equal(error.stage, stage);
    assert.match(
      error.code,
      /^(SCHEMA_INVALID|ASSERTION_FAILED|INVALID_JSON|TIMEOUT|HANDOFF_FAILED)$/,
    );
    assert.equal(error.message, `Spack artifact managed handoff: stage=${stage} code=${error.code}`);
    assert.equal(error.cause, undefined);
    return true;
  });
}
