export interface SpackVariantMetadata {
  name: string;
  default?: string;
  description?: string;
  values: string[];
}

export interface SpackPackageMetadata {
  name?: string;
  homepage?: string;
  licenses: string[];
  maintainers: string[];
  versions: string[];
  variants: SpackVariantMetadata[];
  dependencies: string[];
  provides: string[];
  conflicts: string[];
}

export interface SpackCompilerMetadata {
  spec: string;
  name: string;
  version?: string;
}

export function parseSpackPackageFile(source: string): SpackPackageMetadata {
  const calls = extractCalls(source);
  return {
    name: parsePackageName(source),
    homepage: parseStringAssignment(source, "homepage"),
    licenses: unique(calls.license?.flatMap((call) => quotedStrings(call)) ?? []),
    maintainers: unique(calls.maintainers?.flatMap((call) => quotedStrings(call)) ?? []),
    versions: unique(calls.version?.map((call) => firstQuoted(call)).filter(isPresent) ?? []),
    variants: (calls.variant ?? []).map(parseVariantCall).filter(isPresent),
    dependencies: unique(
      calls.depends_on?.map((call) => firstQuoted(call)).filter(isPresent) ?? [],
    ),
    provides: unique(calls.provides?.map((call) => firstQuoted(call)).filter(isPresent) ?? []),
    conflicts: unique(calls.conflicts?.map((call) => firstQuoted(call)).filter(isPresent) ?? []),
  };
}

export function parseSpackCompilers(source: string): SpackCompilerMetadata[] {
  const specs = new Set<string>();
  const trimmed = source.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    collectCompilerSpecsFromJson(trimmed, specs);
  }
  for (const match of source.matchAll(/^\s*spec:\s*["']?([^"'\n#]+)["']?/gm)) {
    const spec = match[1]?.trim();
    if (spec) specs.add(spec);
  }
  for (const match of source.matchAll(/\b([A-Za-z][A-Za-z0-9_.+-]*@[A-Za-z0-9_.+-]+)\b/g)) {
    const spec = match[1]?.trim();
    if (spec && knownCompilerName(spec.split("@")[0] ?? "")) specs.add(spec);
  }
  return [...specs].map((spec) => {
    const [name, version] = spec.split("@");
    return {
      spec,
      name: name ?? spec,
      ...(version ? { version } : {}),
    };
  });
}

function extractCalls(source: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const name of [
    "version",
    "variant",
    "depends_on",
    "provides",
    "conflicts",
    "maintainers",
    "license",
  ]) {
    result[name] = extractNamedCalls(source, name);
  }
  return result;
}

function extractNamedCalls(source: string, name: string): string[] {
  const calls: string[] = [];
  let searchFrom = 0;
  const token = `${name}(`;
  while (searchFrom < source.length) {
    const start = source.indexOf(token, searchFrom);
    if (start < 0) break;
    const open = start + name.length;
    const close = findMatchingParen(source, open);
    if (close > open) calls.push(source.slice(open + 1, close));
    searchFrom = close > open ? close + 1 : start + token.length;
  }
  return calls;
}

function findMatchingParen(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (!ch) break;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parsePackageName(source: string): string | undefined {
  const assigned = parseStringAssignment(source, "name");
  if (assigned) return assigned;
  const className = source.match(/class\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/)?.[1];
  if (!className) return undefined;
  return className
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function parseStringAssignment(source: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*(["'])(.*?)\\1`, "m"));
  return match?.[2];
}

function parseVariantCall(call: string): SpackVariantMetadata | null {
  const name = firstQuoted(call);
  if (!name) return null;
  return {
    name,
    values: parseValues(call),
    ...(parseKeywordValue(call, "default") ? { default: parseKeywordValue(call, "default") } : {}),
    ...(parseKeywordString(call, "description")
      ? { description: parseKeywordString(call, "description") }
      : {}),
  };
}

function parseValues(call: string): string[] {
  const valueStart = call.search(/\bvalues\s*=/);
  if (valueStart < 0) return [];
  const tail = call.slice(valueStart);
  const stop = tail.search(/,\s*(default|description|when|multi)\s*=/);
  const expr = stop >= 0 ? tail.slice(0, stop) : tail;
  return unique(quotedStrings(expr));
}

function parseKeywordString(call: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = call.match(new RegExp(`\\b${escapedKey}\\s*=\\s*(["'])(.*?)\\1`, "s"));
  return match?.[2];
}

function parseKeywordValue(call: string, key: string): string | undefined {
  const stringValue = parseKeywordString(call, key);
  if (stringValue) return stringValue;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = call.match(new RegExp(`\\b${escapedKey}\\s*=\\s*([^,\\n)]+)`, "s"));
  return match?.[1]?.trim();
}

function firstQuoted(source: string): string | undefined {
  return quotedStrings(source)[0];
}

function quotedStrings(source: string): string[] {
  return [...source.matchAll(/(["'])(.*?)(?<!\\)\1/gs)].map((match) => match[2]).filter(isPresent);
}

function collectCompilerSpecsFromJson(source: string, specs: Set<string>) {
  try {
    collectCompilerSpecs(JSON.parse(source), specs);
  } catch {
    return;
  }
}

function collectCompilerSpecs(value: unknown, specs: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectCompilerSpecs(item, specs);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.spec === "string" && knownCompilerName(record.spec.split("@")[0] ?? "")) {
    specs.add(record.spec);
  }
  for (const item of Object.values(record)) collectCompilerSpecs(item, specs);
}

function knownCompilerName(name: string): boolean {
  return new Set([
    "aocc",
    "apple-clang",
    "clang",
    "fj",
    "gcc",
    "intel",
    "nag",
    "nvhpc",
    "oneapi",
    "pgi",
    "xl",
  ]).has(name);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
