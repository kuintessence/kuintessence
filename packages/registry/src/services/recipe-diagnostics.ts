import type { RecipeDiagnostic, RecipeRoot } from "@kuintessence/shared";
import { parseDocument, visit } from "yaml";

export interface RecipeTreeFile {
  path: string;
  oid: string;
  size: number;
}

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTICS = 500;
const MAX_ROOTS = 128;
const MAX_TREE_FILES = 100_000;
const MAX_PATH_LENGTH = 4096;
const STATIC_REPO_APIS = new Set(["v2.0", "v2.1", "v2.2"]);
// Bound path indexing, metadata and derived names independently of Git's limits.
const MAX_INSPECTION_BYTES = 128 * 1024 * 1024;
type AddDiagnostic = (diagnostic: RecipeDiagnostic) => void;

interface IndexedPackage {
  file: RecipeTreeFile;
  name: string;
  namespace: string;
  dependencies: string[];
}

export async function inspectRecipeTree(
  files: RecipeTreeFile[],
  readText: (file: RecipeTreeFile) => Promise<string>,
): Promise<{ roots: RecipeRoot[]; diagnostics: RecipeDiagnostic[] }> {
  const report = diagnosticCollector();
  const roots: RecipeRoot[] = [];
  const packages: IndexedPackage[] = [];
  const namespaces = new Map<string, string>();
  const finish = () => ({ roots, diagnostics: report.finish() });
  const reserve = inspectionBudget(report.add);
  report.add({
    severity: "warning",
    code: "static-only",
    message:
      "Static text inspection only: Python is not imported or executed; syntax validation and " +
      "concretization are not performed. Literal depends_on/provides are candidates only; " +
      "when conditions, inheritance, dynamic expressions, versions, variants and external " +
      "repositories are not evaluated. Engine compatibility is not verified.",
  });
  if (files.length > MAX_TREE_FILES) {
    report.add({
      severity: "error",
      code: "diagnostic-work-limit",
      message: `Static inspection accepts at most ${MAX_TREE_FILES} tree entries.`,
    });
    return finish();
  }
  const manifests: RecipeTreeFile[] = [];
  for (const file of files) {
    const path = file.path;
    if (path.length > MAX_PATH_LENGTH) {
      report.add({
        severity: "error",
        code: "diagnostic-work-limit",
        message: `Static inspection accepts paths of at most ${MAX_PATH_LENGTH} characters.`,
      });
      return finish();
    }
    if (!reserve(Buffer.byteLength(path), path)) return finish();
    if (path !== "repo.yaml" && !path.endsWith("/repo.yaml")) continue;
    manifests.push(file);
    if (manifests.length > MAX_ROOTS) {
      report.add({
        severity: "error",
        code: "recipe-root-limit",
        message: `Static inspection accepts at most ${MAX_ROOTS} repository roots.`,
        path,
      });
      return finish();
    }
  }
  if (manifests.length === 0) {
    report.add({
      severity: "error",
      code: "repo-not-found",
      message: "No native Spack repository containing repo.yaml was found.",
    });
  }
  for (const file of manifests) {
    if (!checkSize(file, report.add)) continue;
    if (!reserve(file.size, file.path)) return finish();
    const root = parseRoot(await readText(file), file.path, report.add);
    if (!root) continue;
    const previous = namespaces.get(root.namespace);
    if (previous !== undefined) {
      report.add({
        severity: "error",
        code: "duplicate-namespace",
        message: `Namespace ${root.namespace} is also declared at ${previous}.`,
        path: file.path,
      });
    } else {
      namespaces.set(root.namespace, file.path);
    }
    roots.push(root);
  }
  const packageIndexes = indexPackageDirectories(files, roots);
  for (const root of roots) {
    const index = packageIndexes.get(root.path);
    if (!index) continue;
    const indexed = indexPackages(root, index, report.add);
    root.packageCount = indexed.length;
    packages.push(...indexed);
  }

  const available = new Set<string>();
  const providers = new Set<string>();
  const readablePackages: IndexedPackage[] = [];
  for (const entry of packages) {
    if (!reserve(entry.namespace.length + entry.name.length + 1, entry.file.path)) return finish();
    if (!checkSize(entry.file, report.add)) continue;
    if (!reserve(entry.file.size, entry.file.path)) return finish();
    readablePackages.push(entry);
  }
  for (const entry of packages) {
    available.add(entry.name);
    available.add(`${entry.namespace}.${entry.name}`);
  }
  for (const entry of readablePackages) {
    const source = await readText(entry.file);
    const metadata = literalDirectives(source);
    entry.dependencies = metadata.dependencies;
    for (const spec of metadata.provides) {
      const name = specName(spec);
      if (name) providers.add(name);
    }
  }
  for (const entry of packages) {
    const seen = new Set<string>();
    for (const spec of entry.dependencies) {
      const name = specName(spec);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (available.has(name) || providers.has(name)) continue;
      report.add({
        severity: "warning",
        code: "dependency-not-in-bundle",
        message:
          `Literal dependency candidate "${name}" was not found in this bundle. ` +
          "It may be conditional, virtual or supplied externally; concretization was not performed.",
        path: entry.file.path,
        package: entry.name,
      });
    }
  }
  return finish();
}

function inspectionBudget(add: AddDiagnostic) {
  let remaining = MAX_INSPECTION_BYTES;
  return (bytes: number, path: string): boolean => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) {
      add({
        severity: "error",
        code: "diagnostic-work-limit",
        message: `Static inspection exceeds its ${MAX_INSPECTION_BYTES}-byte path, metadata and derived-name budget.`,
        path,
      });
      return false;
    }
    remaining -= bytes;
    return true;
  };
}

function diagnosticCollector() {
  const errors: RecipeDiagnostic[] = [];
  const warnings: RecipeDiagnostic[] = [];
  let count = 0;
  const add: AddDiagnostic = (diagnostic) => {
    count++;
    const target = diagnostic.severity === "error" ? errors : warnings;
    if (target.length < MAX_DIAGNOSTICS) target.push(diagnostic);
  };
  return {
    add,
    finish(): RecipeDiagnostic[] {
      const retained = [...errors, ...warnings];
      if (count <= MAX_DIAGNOSTICS) return retained;
      const diagnostics = retained.slice(0, MAX_DIAGNOSTICS - 1);
      diagnostics.push({
        severity: "warning",
        code: "diagnostics-truncated",
        message: `${count - diagnostics.length} additional diagnostics omitted; errors are retained first.`,
      });
      return diagnostics;
    },
  };
}

function checkSize(file: RecipeTreeFile, add: AddDiagnostic): boolean {
  if (file.size <= MAX_TEXT_BYTES) return true;
  add({
    severity: "error",
    code: "recipe-file-too-large",
    message: `Recipe metadata exceeds the ${MAX_TEXT_BYTES}-byte static inspection limit.`,
    path: file.path,
  });
  return false;
}

function parseRoot(source: string, path: string, add: AddDiagnostic): RecipeRoot | undefined {
  const error = (code: string, message: string) => {
    add({ severity: "error", code, message, path });
  };
  let value: unknown;
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    let hasAlias = false;
    visit(document, {
      Alias() {
        hasAlias = true;
        return visit.BREAK;
      },
    });
    if (hasAlias) {
      error("yaml-alias-not-allowed", "YAML aliases are not allowed in repo.yaml.");
      return;
    }
    if (document.errors.length > 0 || document.warnings.length > 0) {
      error(
        "invalid-repo-yaml",
        "repo.yaml must contain a valid YAML document without custom tags.",
      );
      return;
    }
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    error("invalid-repo-yaml", "repo.yaml could not be parsed as a bounded YAML document.");
    return;
  }
  if (!isRecord(value) || !isRecord(value.repo)) {
    error("invalid-repo-config", "repo.yaml must contain a repo mapping.");
    return;
  }
  const { namespace, api } = value.repo;
  if (
    typeof namespace !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(namespace)
  ) {
    error("invalid-namespace", "repo.namespace must be a nonempty Python namespace.");
    return;
  }
  if (typeof api !== "string" || !STATIC_REPO_APIS.has(api)) {
    error(
      "unsupported-repo-api",
      "Static structure inspection supports explicit repo.api v2.0, v2.1 or v2.2 only; " +
        "missing or unknown APIs are unsupported.",
    );
  }
  return {
    path: path === "repo.yaml" ? "." : path.slice(0, -"/repo.yaml".length),
    namespace,
    api: typeof api === "string" ? api : "unknown",
    packageCount: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PackageDirectory {
  first: RecipeTreeFile;
  recipe?: RecipeTreeFile;
}

interface PackageIndex {
  blob?: RecipeTreeFile;
  directories: Map<string, PackageDirectory>;
}

interface DirectoryNode {
  children: Map<string, DirectoryNode>;
  packages?: PackageIndex;
}

function indexPackageDirectories(
  files: RecipeTreeFile[],
  roots: RecipeRoot[],
): Map<string, PackageIndex> {
  const tree: DirectoryNode = { children: new Map() };
  const indexes = new Map<string, PackageIndex>();
  for (const root of roots) {
    let node = tree;
    const base = `${root.path === "." ? "" : `${root.path}/`}packages`;
    for (const part of base.split("/")) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.packages = { directories: new Map() };
    indexes.set(root.path, node.packages);
  }
  // Follow directory components once per file, including every matching nested root.
  for (const file of files) {
    const parts = file.path.split("/");
    let node = tree;
    for (const [depth, part] of parts.entries()) {
      const child = node.children.get(part);
      if (!child) break;
      node = child;
      if (node.packages) indexPackageFile(node.packages, parts, depth, file);
    }
  }
  return indexes;
}

function indexPackageFile(
  index: PackageIndex,
  parts: string[],
  depth: number,
  file: RecipeTreeFile,
): void {
  if (depth === parts.length - 1) index.blob = file;
  const directory = parts[depth + 1];
  if (!directory || depth + 2 >= parts.length) return;
  const entry = index.directories.get(directory) ?? { first: file };
  if (depth + 3 === parts.length && parts[depth + 2] === "package.py") entry.recipe = file;
  index.directories.set(directory, entry);
}

function indexPackages(
  root: RecipeRoot,
  index: PackageIndex,
  add: AddDiagnostic,
): IndexedPackage[] {
  if (index.blob) {
    add({
      severity: "error",
      code: "packages-not-directory",
      message: "packages must be a directory, not a Git blob.",
      path: index.blob.path,
    });
  }
  const packages: IndexedPackage[] = [];
  for (const [directory, entry] of index.directories) {
    if (!entry.recipe) {
      add({
        severity: "error",
        code: "package-file-missing",
        message: `Package directory ${directory} does not contain package.py.`,
        path: entry.first.path,
      });
      continue;
    }
    const name = directory.replace(/^_(?=\d)/, "").replaceAll("_", "-");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(directory) || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) {
      add({
        severity: "error",
        code: "invalid-package-directory",
        message: `Package directory ${directory} must be a Python identifier encoding a Spack package name.`,
        path: entry.recipe.path,
      });
      continue;
    }
    packages.push({ file: entry.recipe, name, namespace: root.namespace, dependencies: [] });
  }
  return packages;
}

function specName(spec: string): string | undefined {
  return spec.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)(?=$|[\s@+~%^])/u)?.[1];
}

interface DirectiveToken {
  kind: "identifier" | "literal" | "punctuation";
  value: string;
}

function literalDirectives(source: string): { dependencies: string[]; provides: string[] } {
  const dependencies = new Set<string>();
  const provides = new Set<string>();
  let state: "idle" | "open" | "literal" | "delimiter" = "idle";
  let directive = "";
  let literal = "";
  let previousDot = false;
  for (const token of directiveTokens(source)) {
    const punctuation = token.kind === "punctuation" ? token.value : "";
    if (state === "open") {
      state = punctuation === "(" ? "literal" : "idle";
    } else if (state === "literal") {
      state = token.kind === "literal" ? "delimiter" : "idle";
      literal = token.value.trim();
    } else if (state === "delimiter") {
      if (punctuation === "," || punctuation === ")") {
        if (literal) (directive === "depends_on" ? dependencies : provides).add(literal);
        state = directive === "provides" && punctuation === "," ? "literal" : "idle";
      } else {
        state = "idle";
      }
    }
    if (
      state === "idle" &&
      !previousDot &&
      token.kind === "identifier" &&
      (token.value === "depends_on" || token.value === "provides")
    ) {
      directive = token.value;
      state = "open";
    }
    previousDot = punctuation === ".";
  }
  return { dependencies: [...dependencies], provides: [...provides] };
}

function* directiveTokens(source: string): Generator<DirectiveToken> {
  // The cursor only advances, including on unterminated strings. This is not a Python parser.
  let offset = 0;
  while (offset < source.length) {
    const character = source.charAt(offset);
    if (/\s/.test(character)) {
      offset++;
    } else if (character === "#") {
      while (offset < source.length && source[offset] !== "\r" && source[offset] !== "\n") offset++;
    } else if (character === '"' || character === "'") {
      const string = scanString(source, offset);
      offset = string.end;
      yield string.token;
    } else if (isIdentifierStart(source.charCodeAt(offset))) {
      const start = offset++;
      while (offset < source.length) {
        const code = source.charCodeAt(offset);
        if (!isIdentifierStart(code) && !(code >= 48 && code <= 57)) break;
        offset++;
      }
      const value = source.slice(start, offset);
      if (/^[rRuUbBfF]{1,2}$/.test(value) && (source[offset] === '"' || source[offset] === "'")) {
        offset = scanString(source, offset).end;
        yield { kind: "punctuation", value: "" };
      } else {
        yield { kind: "identifier", value };
      }
    } else {
      offset++;
      yield { kind: "punctuation", value: character };
    }
  }
}

function isIdentifierStart(code: number): boolean {
  return code === 95 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function scanString(source: string, start: number): { end: number; token: DirectiveToken } {
  const quote = source.charAt(start);
  const triple = source.startsWith(quote.repeat(3), start);
  const delimiter = triple ? quote.repeat(3) : quote;
  const body = start + delimiter.length;
  let offset = body;
  let plain = !triple;
  while (offset < source.length) {
    const character = source[offset];
    if (character === "\\") {
      plain = false;
      offset += 2;
    } else if (source.startsWith(delimiter, offset)) {
      return {
        end: offset + delimiter.length,
        token: plain
          ? { kind: "literal", value: source.slice(body, offset) }
          : { kind: "punctuation", value: "" },
      };
    } else {
      if (character === "\r" || character === "\n") plain = false;
      offset++;
    }
  }
  return { end: source.length, token: { kind: "punctuation", value: "" } };
}
