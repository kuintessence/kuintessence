import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSpackPackageFile } from "../packages/registry/src/services/spack-package-parser";

interface MetadataRecord {
  name?: string;
  homepage?: string;
  licenses: string[];
  maintainers: string[];
  versions: string[];
  variants: Array<{
    name: string;
    default?: string;
    description?: string;
    values: string[];
  }>;
  dependencies: string[];
  provides: string[];
  conflicts: string[];
}

async function main(): Promise<void> {
  const repoDir = process.argv[2];
  const output = process.argv[3] ?? "packages/registry/src/data/spack-package-metadata.json";

  if (!repoDir) {
    console.error(
      "Usage: bun run scripts/generate-spack-package-metadata.ts <spack-packages-dir> [output.json]",
    );
    process.exit(1);
  }

  const entries = await readdir(repoDir, { withFileTypes: true });
  const metadata: Record<string, MetadataRecord> = {};
  const failures: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageFile = join(repoDir, entry.name, "package.py");
    try {
      const source = await readFile(packageFile, "utf8");
      metadata[entry.name] = parseSpackPackageFile(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(entry.name);
    }
  }

  const ordered = Object.fromEntries(
    Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(output, `${JSON.stringify(ordered, null, 2)}\n`);

  console.log(`generated ${Object.keys(ordered).length} package metadata records -> ${output}`);
  if (failures.length > 0) {
    console.warn(
      `failed to parse ${failures.length} packages: ${failures.slice(0, 20).join(", ")}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
