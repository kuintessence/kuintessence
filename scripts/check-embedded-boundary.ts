const FORBIDDEN = ["stream", "server-client", "queue/", "auth/", "@kuintessence/server", "server/"];

// The embedded kernel barrel (embedded/index.ts) re-exports ../adapters, ../monitor,
// and ../spack, so those dirs are part of the kernel's Server-free public surface and must
// be scanned too — a forbidden import added inside them would otherwise leak in uncaught.
export const EMBEDDED_ROOTS = [
  "packages/agent/src/embedded/**/*.ts",
  "packages/agent/src/spack/**/*.ts",
  "packages/agent/src/adapters/**/*.ts",
  "packages/agent/src/monitor/**/*.ts",
];

const IMPORT_FROM = /(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function collectSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const re of [IMPORT_FROM, BARE_IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null = re.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
      match = re.exec(source);
    }
  }
  return specifiers;
}

function matchesToken(specifier: string, token: string): boolean {
  if (token.endsWith("/")) {
    const segment = token.slice(0, -1);
    return (
      specifier === segment ||
      specifier.startsWith(token) ||
      specifier.endsWith(`/${segment}`) ||
      specifier.includes(`/${segment}/`)
    );
  }
  return (
    specifier === token ||
    specifier.endsWith(`/${token}`) ||
    specifier.includes(`/${token}/`) ||
    specifier.startsWith(`${token}/`)
  );
}

export function findForbiddenImports(_file: string, source: string, forbidden: string[]): string[] {
  const violations: string[] = [];
  for (const specifier of collectSpecifiers(stripComments(source))) {
    if (forbidden.some((token) => matchesToken(specifier, token))) {
      violations.push(specifier);
    }
  }
  return violations;
}

function isScannable(file: string): boolean {
  if (file.endsWith(".test.ts")) {
    return false;
  }
  return !file.split("/").some((segment) => segment === "__fixtures__" || segment === "__tests__");
}

async function main(): Promise<void> {
  const seen = new Set<string>();
  const violations: { file: string; specifier: string }[] = [];
  for (const root of EMBEDDED_ROOTS) {
    const glob = new Bun.Glob(root);
    for await (const file of glob.scan(".")) {
      if (seen.has(file) || !isScannable(file)) {
        continue;
      }
      seen.add(file);
      const source = await Bun.file(file).text();
      for (const specifier of findForbiddenImports(file, source, FORBIDDEN)) {
        violations.push({ file, specifier });
      }
    }
  }

  if (violations.length > 0) {
    for (const { file, specifier } of violations) {
      process.stdout.write(`${file} -> ${specifier}\n`);
    }
    process.stdout.write(
      `\nembedded boundary check FAILED: ${violations.length} forbidden import(s)\n`,
    );
    process.exit(1);
  }

  process.stdout.write("embedded boundary check OK: no forbidden imports\n");
}

if (import.meta.main) {
  await main();
}
