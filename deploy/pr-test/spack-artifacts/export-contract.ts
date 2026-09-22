import { createHash } from "node:crypto";
import {
  inspectSpackLock,
  RecipeCommitSchema,
  RecipeRepositoryNameSchema,
  SpackMaterialPathSchema,
} from "@kuintessence/shared";
import { z } from "zod";
import { selectedCase } from "../spack-case/fixture";

const MIB = 1024 ** 2;
export const LIMITS = {
  metadata: 256 * 1024,
  bundle: 128 * MIB,
  recipes: 128 * MIB,
  tree: 16 * MIB,
  recipeFiles: 40_000,
  sources: 64 * MIB,
  sourceEntries: 128,
  nodes: 16,
} as const;
export const TARGET = "linux-ubuntu20.04-x86_64";
export const UPSTREAM_COMMIT = "32c54f0906004d7fd1f72fd1b5970bf2bf094e26";
export const UPSTREAM_TREE = "f117b6bf72ee6d9c2951922f4afd31f461b02b0d";
export const CaseSchema = z.enum(["hello", "samtools"]);
export type CaseId = z.infer<typeof CaseSchema>;

export class MaterialPackExportError extends Error {}

export function requireExport(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MaterialPackExportError(message);
}

export const OptionsSchema = z.strictObject({
  inputDirectory: z.string().min(1),
  outputDirectory: z.string().min(1),
  caseId: CaseSchema,
  recipeRepository: RecipeRepositoryNameSchema,
  materialRepository: RecipeRepositoryNameSchema,
});
export type ExportMaterialPackOptions = z.infer<typeof OptionsSchema>;

export const MetadataSchema = z.strictObject({
  case: CaseSchema,
  spec: z.string().max(4096),
  target: z.literal(TARGET),
  commit: RecipeCommitSchema,
  roots: z.array(SpackMaterialPathSchema).min(1).max(2),
  sources: z
    .array(z.strictObject({ path: SpackMaterialPathSchema, file: SpackMaterialPathSchema }))
    .min(1)
    .max(LIMITS.sourceEntries),
  lockfile: z.literal("spack.lock"),
});
export type PreparedMetadata = z.infer<typeof MetadataSchema>;

export function caseRoots(caseId: CaseId): string[] {
  return caseId === "hello"
    ? ["repos/spack_repo/kq_case", "repos/spack_repo/builtin"]
    : ["repos/spack_repo/builtin"];
}

export function validateMetadata(value: unknown, caseId: CaseId): PreparedMetadata {
  const metadata = MetadataSchema.parse(value);
  requireExport(
    metadata.case === caseId &&
      metadata.spec === selectedCase(caseId).spec &&
      JSON.stringify(metadata.roots) === JSON.stringify(caseRoots(caseId)),
    "Prepared case identity does not match",
  );
  const paths = new Set<string>();
  for (const source of metadata.sources) {
    requireExport(
      source.file === `sources/${source.path}` && !paths.has(source.path),
      "Invalid prepared source binding",
    );
    paths.add(source.path);
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      requireExport(!paths.has(parts.slice(0, index).join("/")), "Overlapping source paths");
    }
  }
  return metadata;
}

export function repositoryId(repository: string): string {
  return createHash("sha256").update(RecipeRepositoryNameSchema.parse(repository)).digest("hex");
}

export function validateNamespaces(recipe: string, material: string): void {
  const [kind, owner] = recipe.split("/");
  const [targetKind, targetOwner] = material.split("/");
  requireExport(
    (kind === "public" && targetKind === "public") ||
      (kind === "org" && targetKind === "org" && owner === targetOwner),
    "Export requires public/public or same-owner org/org repositories",
  );
}

const NodeSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  namespace: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  package_hash: z.string().min(1).optional(),
  external: z
    .looseObject({
      path: z.string().optional(),
      module: z.array(z.string()).nullable().optional(),
      modules: z.array(z.string()).nullable().optional(),
    })
    .optional(),
  dependencies: z
    .array(
      z.looseObject({
        name: z.string(),
        hash: z.string(),
        parameters: z.looseObject({
          deptypes: z.array(z.string()),
          virtuals: z.array(z.string()),
          direct: z.boolean().optional(),
        }),
      }),
    )
    .optional(),
});
const LockSchema = z.looseObject({
  roots: z.array(z.strictObject({ hash: z.string(), spec: z.string() })).length(1),
  concrete_specs: z.record(z.string(), NodeSchema),
});

export function validateLock(
  bytes: Uint8Array,
  metadata: PreparedMetadata,
): { rootHash: string; recipePaths: string[] } {
  const report = inspectSpackLock(bytes, { ...metadata, spackVersion: "1.0.0" });
  requireExport(
    report.valid &&
      report.rootHash &&
      report.nodeCount <= LIMITS.nodes &&
      report.architectures.length === 1 &&
      report.architectures[0] === TARGET,
    "Prepared lock failed fixed-case validation",
  );
  const lock = LockSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const root = lock.concrete_specs[report.rootHash];
  const selected = selectedCase(metadata.case);
  requireExport(
    root && root.name === selected.name && root.version === selected.version && !root.external,
    "Prepared lock root does not match",
  );
  const pinned = new Map<string, string>(
    metadata.case === "hello"
      ? [["hello", "2.12.1"]]
      : [
          ["samtools", "1.19.2"],
          ["htslib", "1.19.1"],
          ["zlib", "1.3.1"],
        ],
  );
  const allowed = new Set([
    ...pinned.keys(),
    "compiler-wrapper",
    "gcc-runtime",
    ...(metadata.case === "samtools"
      ? ["ncurses", "bzip2", "xz", "pkgconf", "diffutils", "libiconv"]
      : []),
  ]);
  const requiredExternals = new Set(
    metadata.case === "hello" ? ["gcc", "gmake"] : ["gcc", "gmake", "python", "perl"],
  );
  const compiled = new Set<string>();
  const externals = new Set<string>();
  const recipePaths = new Set<string>();
  for (const node of Object.values(lock.concrete_specs)) {
    const namespace = node.name === "hello" ? "kq_case" : "builtin";
    requireExport(node.namespace === namespace, "Unexpected lock namespace");
    if (node.external) {
      requireExport(
        requiredExternals.has(node.name) || node.name === "glibc",
        "Unexpected lock external",
      );
      if (node.name === "python" || node.name === "perl") {
        requireExport(
          node.external.path === "/usr" &&
            !node.external.module?.length &&
            !node.external.modules?.length,
          "Unexpected runtime external",
        );
      }
      externals.add(node.name);
      continue;
    }
    requireExport(
      allowed.has(node.name) &&
        node.package_hash &&
        (!pinned.has(node.name) || pinned.get(node.name) === node.version),
      "Unexpected compiled lock dependency",
    );
    compiled.add(node.name);
    recipePaths.add(
      `repos/spack_repo/${namespace}/packages/${node.name.replaceAll("-", "_")}/package.py`,
    );
    if (node.name === "htslib") {
      requireExport(
        node.parameters.libcurl === false && node.parameters.libdeflate === false,
        "Unexpected htslib variants",
      );
    }
    if (node.name === "ncurses") {
      // Native edges are already adjacent. Spack 1.0.0 may omit the abstract `%` marker.
      requireExport(
        node.parameters.symlinks === true &&
          node.dependencies?.some(
            (edge) =>
              edge.name === "pkgconf" &&
              edge.parameters.deptypes.includes("build") &&
              edge.parameters.virtuals.includes("pkgconfig") &&
              lock.concrete_specs[edge.hash]?.name === "pkgconf" &&
              !lock.concrete_specs[edge.hash]?.external,
          ),
        "Unexpected ncurses variant or provider",
      );
    }
  }
  requireExport(
    [...pinned.keys()].every((name) => compiled.has(name)) &&
      [...requiredExternals].every((name) => externals.has(name)) &&
      (metadata.case === "hello" || ["ncurses", "pkgconf"].every((name) => compiled.has(name))),
    "Required fixed-case dependency is missing",
  );
  return { rootHash: report.rootHash, recipePaths: [...recipePaths].sort() };
}
