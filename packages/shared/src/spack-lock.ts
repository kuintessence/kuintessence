export const SPACK_LOCK_MAX_BYTES = 16 * 1024 ** 2;

export interface SpackLockReport {
  validation: "static-only";
  valid: boolean;
  diagnostics: {
    severity: "error" | "warning";
    code: string;
    message: string;
    hash?: string;
  }[];
  rootHash?: string;
  nodeCount: number;
  externalCount: number;
  architectures: string[];
}

const MAX_NODES = 10_000;
const MAX_EDGES = 100_000;
const MAX_DIAGNOSTICS = 100;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_CONTAINERS = 100_000;
const MAX_JSON_KEYS = 500_000;
const MAX_JSON_TOKENS = 2_000_000;
const MAX_ARCHITECTURES = 64;
const HASH = /^[a-z2-7]{32}$/;
const DEPTYPES = new Set(["build", "link", "run", "test"]);
const UNSUPPORTED_FIELDS = new Set(["include_concrete", "develop", "dev_path"]);
type JsonObject = Record<string, unknown>;
type Diagnostic = SpackLockReport["diagnostics"][number];
type ErrorReporter = (code: string, message: string, hash?: string) => void;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && value.length === 32 && HASH.test(value);
}

function stringSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty) && new Set(value).size === value.length;
}

function architectureComponent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_.-]+$/.test(value)
  );
}

function architecture(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const target = isObject(value.target) ? value.target.name : value.target;
  if (
    !architectureComponent(value.platform) ||
    !architectureComponent(value.platform_os) ||
    !architectureComponent(target)
  ) {
    return undefined;
  }
  return `${value.platform}-${value.platform_os}-${target}`;
}

// These independent allocation budgets may reject a graph below the node/edge limits.
// Tokens count containers, strings (including keys) and primitive values, not punctuation.
// Syntax (including matching bracket types and valid escapes) is still checked by JSON.parse.
function jsonBudgetError(text: string): Pick<Diagnostic, "code" | "message"> | undefined {
  let depth = 0;
  let containers = 0;
  let keys = 0;
  let tokens = 0;
  let inString = false;
  let inPrimitive = false;
  for (let index = 0; index < text.length; index++) {
    const token = text[index];
    if (inString) {
      if (token === "\\") index++;
      else if (token === '"') inString = false;
      continue;
    }
    if (token === '"') {
      inString = true;
      inPrimitive = false;
      tokens++;
    } else if (token === "{" || token === "[") {
      containers++;
      tokens++;
      inPrimitive = false;
      if (++depth > MAX_JSON_DEPTH) {
        return { code: "json-depth-limit", message: "Spack lock exceeds 128 JSON nesting levels." };
      }
    } else if (token === "}" || token === "]") {
      // Invalid excess closing brackets must not offset later nesting.
      if (depth > 0) depth--;
      inPrimitive = false;
    } else if (token === ":") {
      keys++;
      inPrimitive = false;
    } else if (
      token === "," ||
      token === " " ||
      token === "\t" ||
      token === "\r" ||
      token === "\n"
    ) {
      inPrimitive = false;
    } else if (!inPrimitive) {
      inPrimitive = true;
      tokens++;
    }
    if (containers > MAX_JSON_CONTAINERS) {
      return {
        code: "json-container-limit",
        message: "Spack lock exceeds the independent 100000 JSON container budget.",
      };
    }
    if (keys > MAX_JSON_KEYS) {
      return { code: "json-key-limit", message: "Spack lock exceeds 500000 JSON object keys." };
    }
    if (tokens > MAX_JSON_TOKENS) {
      return { code: "json-token-limit", message: "Spack lock exceeds 2000000 JSON tokens." };
    }
  }
  return undefined;
}

// JSON.parse validates syntax first. This token-only pass preserves object scopes and
// decodes keys to catch escaped duplicates, without YAML extensions or recursive walks.
function inspectJsonKeys(text: string): { duplicate: boolean; unsupported: boolean } {
  const stack: ({ keys: Set<string>; expectsKey: boolean } | null)[] = [];
  let unsupported = false;
  for (let index = 0; index < text.length; index++) {
    const token = text[index];
    if (token === '"') {
      const start = index++;
      // The input is already valid JSON. Skip escaped characters without a recursive
      // regex: V8 can overflow its regex stack on multi-megabyte string values.
      while (index < text.length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1;
      }
      const frame = stack.at(-1);
      if (!frame?.expectsKey) continue;
      const key: string = JSON.parse(text.slice(start, index + 1));
      if (frame.keys.has(key)) return { duplicate: true, unsupported };
      frame.keys.add(key);
      frame.expectsKey = false;
      if (UNSUPPORTED_FIELDS.has(key)) unsupported = true;
      continue;
    }
    if (token === "{") stack.push({ keys: new Set(), expectsKey: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") {
      const frame = stack.at(-1);
      if (frame) frame.expectsKey = true;
    }
  }
  return { duplicate: false, unsupported };
}

function validExternal(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.path !== undefined && value.path !== null && !nonempty(value.path)) return false;
  for (const field of ["module", "modules"]) {
    if (value[field] !== undefined && value[field] !== null && !stringSet(value[field]))
      return false;
  }
  return (
    nonempty(value.path) ||
    (Array.isArray(value.module) && value.module.length > 0) ||
    (Array.isArray(value.modules) && value.modules.length > 0)
  );
}

function validReference(value: unknown): value is JsonObject & { name: string; hash: string } {
  return isObject(value) && nonempty(value.name) && isHash(value.hash);
}

function validDependency(value: unknown): value is JsonObject & { name: string; hash: string } {
  if (!validReference(value) || !isObject(value.parameters)) return false;
  const { deptypes, virtuals, direct } = value.parameters;
  return (
    stringSet(deptypes) &&
    deptypes.every((deptype) => DEPTYPES.has(deptype)) &&
    stringSet(virtuals) &&
    (direct === undefined || typeof direct === "boolean")
  );
}

function inspectGraph(
  graph: Map<string, string[]>,
  rootHash: string | undefined,
  error: ErrorReporter,
): void {
  const colors = new Map<string, "active" | "done">();
  function visit(start: string): void {
    const stack = [{ hash: start, edges: graph.get(start) ?? [], next: 0 }];
    colors.set(start, "active");
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (!frame) break;
      const next = frame.edges[frame.next++];
      if (next === undefined) {
        colors.set(frame.hash, "done");
        stack.pop();
      } else if (colors.get(next) === "active") {
        error("cycle", "The concrete graph contains a dependency or build_spec cycle.", frame.hash);
      } else if (!colors.has(next)) {
        colors.set(next, "active");
        stack.push({ hash: next, edges: graph.get(next) ?? [], next: 0 });
      }
    }
  }
  if (rootHash && graph.has(rootHash)) visit(rootHash);
  const reachable = new Set(colors.keys());
  for (const hash of graph.keys()) {
    if (!reachable.has(hash))
      error("unreachable-node", "Node is unreachable from the sole root.", hash);
    if (!colors.has(hash)) visit(hash);
  }
}

/**
 * The supported contract is only Spack v1.0.0, lockfile 6 / specfile 5.
 * A valid report means these bounded static checks passed, not installation readiness.
 */
export function inspectSpackLock(
  bytes: Uint8Array,
  binding: { spec: string; spackVersion: string; target: string },
): SpackLockReport {
  const report: SpackLockReport = {
    validation: "static-only",
    valid: true,
    diagnostics: [],
    nodeCount: 0,
    externalCount: 0,
    architectures: [],
  };
  function add(
    severity: Diagnostic["severity"],
    code: string,
    message: string,
    hash?: string,
  ): void {
    if (severity === "error") report.valid = false;
    if (report.diagnostics.length >= MAX_DIAGNOSTICS) {
      report.valid = false;
      report.diagnostics[MAX_DIAGNOSTICS - 1] = {
        severity: "error",
        code: "diagnostic-limit",
        message: "The 100-diagnostic limit was exceeded; the report is incomplete.",
      };
      return;
    }
    report.diagnostics.push({ severity, code, message, ...(isHash(hash) ? { hash } : {}) });
  }
  const error: ErrorReporter = (code, message, hash) => add("error", code, message, hash);
  add(
    "warning",
    "host-target-unverified",
    "Build host and target compatibility have not been validated; target binding is an exact architecture triple only.",
  );
  add(
    "warning",
    "source-coverage-unverified",
    "Source material coverage and availability have not been validated.",
  );
  add(
    "warning",
    "root-spec-unverified",
    "Exact root.spec binding does not verify that the concrete root satisfies the spec grammar, versions or variants.",
  );
  add(
    "warning",
    "dag-hash-unverified",
    "DAG hashes are checked for shape and references only; they have not been recomputed by Spack.",
  );
  add(
    "warning",
    "recipe-compatibility-unverified",
    "Recipe namespace, recipe API and engine compatibility have not been validated.",
  );

  if (bytes.byteLength > SPACK_LOCK_MAX_BYTES) {
    error("byte-limit", "Spack lock exceeds the 16 MiB byte limit.");
    return report;
  }
  let text: string;
  try {
    // Preserve a BOM so JSON.parse rejects it rather than silently normalizing the input.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    error("invalid-utf8", "Spack lock is not valid UTF-8.");
    return report;
  }
  const budgetError = jsonBudgetError(text);
  if (budgetError) {
    error(budgetError.code, budgetError.message);
    return report;
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    error("invalid-json", "Spack lock is not strict JSON.");
    return report;
  }
  const keys = inspectJsonKeys(text);
  if (keys.duplicate) {
    error("duplicate-json-key", "Duplicate decoded JSON object keys are not allowed.");
    return report;
  }
  if (keys.unsupported) {
    error("unsupported-feature", "include_concrete, develop and dev_path are not supported.");
  }
  if (!isObject(document)) {
    error("invalid-document", "Spack lock must be a JSON object.");
    return report;
  }
  const meta = document._meta;
  if (
    !isObject(meta) ||
    meta["file-type"] !== "spack-lockfile" ||
    meta["lockfile-version"] !== 6 ||
    meta["specfile-version"] !== 5
  ) {
    error(
      "unsupported-format",
      "Only spack-lockfile format 6 with specfile format 5 is supported.",
    );
    return report;
  }
  if (
    !isObject(document.spack) ||
    document.spack.version !== "1.0.0" ||
    binding.spackVersion !== "1.0.0"
  ) {
    error(
      "unsupported-spack-version",
      "Only producer and binding Spack version 1.0.0 are verified.",
    );
    return report;
  }
  if (!isObject(document.concrete_specs)) {
    error("invalid-nodes", "concrete_specs must be a nonempty object.");
    return report;
  }
  const entries = Object.entries(document.concrete_specs);
  report.nodeCount = entries.length;
  if (entries.length === 0 || entries.length > MAX_NODES) {
    error(
      entries.length ? "node-limit" : "invalid-nodes",
      "concrete_specs must contain 1 to 10000 nodes.",
    );
    return report;
  }
  const roots = document.roots;
  if (!Array.isArray(roots) || roots.length !== 1 || !isObject(roots[0])) {
    error("invalid-roots", "Exactly one root object is required.");
    return report;
  }
  const root = roots[0];
  if (!nonempty(root.spec) || root.spec !== binding.spec) {
    error("root-spec-mismatch", "The nonempty root.spec must match binding.spec exactly.");
  }
  if (!isHash(root.hash))
    error("invalid-root-hash", "Root hash must be 32 lowercase base32 characters.");
  else report.rootHash = root.hash;

  // Count all declared edges before validation, so malformed/duplicate edges cannot evade the limit.
  let edgeCount = 0;
  for (const [, value] of entries) {
    if (!isObject(value)) continue;
    if (Array.isArray(value.dependencies)) edgeCount += value.dependencies.length;
    if (Object.hasOwn(value, "build_spec")) edgeCount++;
    if (edgeCount > MAX_EDGES) {
      error("edge-limit", "Spack lock exceeds 100000 dependency and build_spec edges.");
      return report;
    }
  }

  const nodes = new Map<string, JsonObject>();
  const graph = new Map<string, string[]>();
  const architectures = new Set<string>();
  for (const [hash, value] of entries) {
    if (!isObject(value)) {
      error("invalid-node", "Each concrete node must be an object.", hash);
      continue;
    }
    nodes.set(hash, value);
    graph.set(hash, []);
    if (!isHash(hash) || value.hash !== hash) {
      error(
        "invalid-node-hash",
        "Node key and embedded hash must be identical 32-character base32 hashes.",
        hash,
      );
    }
    const arch = architecture(value.arch);
    if (
      !nonempty(value.name) ||
      !nonempty(value.version) ||
      !nonempty(value.namespace) ||
      !arch ||
      !isObject(value.parameters)
    ) {
      error(
        "invalid-node",
        "Nodes require a name, nonempty version, namespace, architecture and parameters object.",
        hash,
      );
    }
    if (arch && !architectures.has(arch)) {
      if (architectures.size >= MAX_ARCHITECTURES) {
        error("architecture-limit", "Spack lock exceeds 64 distinct architecture triples.", hash);
      } else architectures.add(arch);
    }
    if (Object.hasOwn(value, "concrete") && value.concrete !== true) {
      error("non-concrete-node", "A node's concrete flag, when present, must be true.", hash);
    }
    if (Object.hasOwn(value, "compiler")) {
      error(
        "unsupported-compiler",
        "Specfile 5 uses compiler dependency nodes, not a compiler property.",
        hash,
      );
    }
    if (Object.hasOwn(value, "external")) {
      report.externalCount++;
      if (!validExternal(value.external)) {
        error("invalid-external", "External metadata requires a path or named modules.", hash);
      }
      add(
        "warning",
        "external-dependency",
        "External paths and modules require separate availability and compatibility validation.",
        hash,
      );
    }
  }
  report.architectures = [...architectures].sort();
  const rootNode = report.rootHash ? nodes.get(report.rootHash) : undefined;
  if (!rootNode) {
    error("missing-root", "Root hash does not reference a concrete node.", report.rootHash);
  } else {
    if (architecture(rootNode.arch) !== binding.target) {
      error(
        "target-mismatch",
        "binding.target must exactly match the root platform-platform_os-target triple.",
        report.rootHash,
      );
    }
    // Check only an unambiguous leading package label; constraints remain deliberately opaque.
    const label =
      typeof root.spec === "string"
        ? /^([A-Za-z0-9_][A-Za-z0-9_.-]*)(?=$|[\s@%+~^])/.exec(root.spec.trimStart())?.[1]
        : undefined;
    if (label) {
      const dot = label.lastIndexOf(".");
      if (
        label.slice(dot + 1) !== rootNode.name ||
        (dot !== -1 && label.slice(0, dot) !== rootNode.namespace)
      ) {
        error(
          "root-name-mismatch",
          "The leading root label does not match the concrete root name or explicit namespace.",
          report.rootHash,
        );
      }
    }
  }
  for (const [hash, value] of nodes) {
    const edges = graph.get(hash);
    if (!edges) continue;
    function reference(edge: { name: string; hash: string }): void {
      const target = nodes.get(edge.hash);
      if (!target) error("missing-reference", "An edge references a missing concrete node.", hash);
      else {
        if (target.name !== edge.name) {
          error("reference-name-mismatch", "Edge name does not match the referenced node.", hash);
        }
        edges?.push(edge.hash);
      }
    }
    if (Object.hasOwn(value, "dependencies")) {
      if (!Array.isArray(value.dependencies)) {
        error("invalid-dependency", "dependencies must be an array of specfile 5 edges.", hash);
      } else {
        const seen = new Set<string>();
        for (const dependency of value.dependencies) {
          if (!validDependency(dependency)) {
            error(
              "invalid-dependency",
              "Dependencies require name, hash and valid deptypes/virtuals/direct parameters.",
              hash,
            );
            continue;
          }
          if (seen.has(dependency.hash))
            error("duplicate-edge", "Duplicate dependency edges are not allowed.", hash);
          else {
            seen.add(dependency.hash);
            reference(dependency);
          }
        }
      }
    }
    if (Object.hasOwn(value, "build_spec")) {
      if (!validReference(value.build_spec)) {
        error("invalid-build-spec", "build_spec must contain a name and valid node hash.", hash);
      } else reference(value.build_spec);
    }
  }
  inspectGraph(graph, report.rootHash, error);
  return report;
}
