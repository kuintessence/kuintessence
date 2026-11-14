import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import postgres from "postgres";
import durations from "./unit-test-durations.json";

const repoRoot = resolve(import.meta.dir, "..");
const defaultDatabaseUrl = "postgres://kq:kq@localhost:5432/kuintessence";
const unitDatabasePattern = /^kuintessence_unit_[a-z0-9_]+$/;
const externalE2eVariables = ["SPACK_E2E_CONTAINER", "SPICEDB_E2E_ENDPOINT"] as const;
const excludedTestPathSegments = ["/node_modules/", "/dist/", "/.git/"] as const;

interface TestSlice {
  name: string;
  paths: string[];
}

const slices: TestSlice[] = [
  {
    name: "core",
    paths: [
      "packages/shared",
      "packages/fabric-adapter",
      "contracts/fabric",
      "scripts/fabric-case-check.test.ts",
      "scripts/fabric-evidence-diagnostics.test.ts",
      "packages/proto",
      "packages/db",
      "packages/cli",
      "packages/agent/src",
      "scripts/test-unit.test.ts",
      "scripts/federation-storage-observer.test.ts",
      "scripts/workflow-software.pg.test.ts",
      "scripts/workflow-dispatch.pg.test.ts",
    ],
  },
  { name: "server", paths: ["packages/server"] },
  { name: "registry", paths: ["packages/registry"] },
];

const offlineSlurmPg: TestSlice = {
  name: "offline-slurm-pg",
  paths: ["packages/server/src/services/offline-slurm.pg.test.ts"],
};

export function selectUnitTestSlices(args: string[]): TestSlice[] {
  if (args.length === 0) return slices;
  if (args.length !== 2 || args[0] !== "--suite") {
    throw new Error("Usage: bun run test:unit [--suite core|server|registry|offline-slurm-pg]");
  }
  const selected = [...slices, offlineSlurmPg].find((slice) => slice.name === args[1]);
  if (!selected) throw new Error("Unknown unit test suite");
  return [selected];
}

export function unitTestOptions(args: string[]): {
  slices: TestSlice[];
  shard: number;
  total: number;
} {
  const index = args.indexOf("--shard");
  if (index === -1) return { slices: selectUnitTestSlices(args), shard: 1, total: 1 };
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(args[index + 1] ?? "");
  if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) > 32) {
    throw new Error("--shard must be INDEX/TOTAL with 1 <= INDEX <= TOTAL <= 32");
  }
  return {
    slices: selectUnitTestSlices([...args.slice(0, index), ...args.slice(index + 2)]),
    shard: Number(match[1]),
    total: Number(match[2]),
  };
}

export function partitionUnitTestFiles(
  files: string[],
  total: number,
  timings: Record<string, number> = durations,
): string[][] {
  if (!Number.isInteger(total) || total < 1 || total > 32) throw new Error("Invalid shard count");
  const shards = Array.from({ length: total }, () => ({ seconds: 0, files: [] as string[] }));
  const weight = (file: string) => timings[relative(repoRoot, file)] ?? 1;
  const ordered = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const file of ordered) {
    const shard = shards.reduce((a, b) => (a.seconds <= b.seconds ? a : b));
    shard.files.push(file);
    shard.seconds += weight(file);
  }
  return shards.map((shard) => shard.files);
}

export function databaseUrlWithName(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }
  if (!url.hostname) {
    throw new Error("DATABASE_URL must include a host");
  }
  if (!unitDatabasePattern.test(databaseName) && databaseName !== "postgres") {
    throw new Error("Unit database name is outside the allowed namespace");
  }
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function unitDatabaseName(now: Date, pid: number, suffix: string): string {
  const timestamp = now
    .toISOString()
    .replaceAll(/[^0-9]/g, "")
    .slice(0, 14);
  const safeSuffix = suffix
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "")
    .slice(0, 8);
  if (!safeSuffix) throw new Error("Unit database suffix must contain an alphanumeric character");
  const databaseName = `kuintessence_unit_${timestamp}_${pid}_${safeSuffix}`;
  if (!unitDatabasePattern.test(databaseName)) {
    throw new Error("Generated unit database name is outside the allowed namespace");
  }
  return databaseName;
}

export function unitChildEnvironment(
  baseEnvironment: Record<string, string | undefined>,
  databaseUrl: string,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ...baseEnvironment,
    DATABASE_URL: databaseUrl,
    KQ_PG_URL: databaseUrl,
  };
  for (const variable of externalE2eVariables) {
    delete environment[variable];
  }
  return environment;
}

async function runCommand(
  command: string[],
  env: Record<string, string | undefined>,
): Promise<void> {
  const subprocess = Bun.spawn(command, {
    cwd: repoRoot,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
  }
}

export async function collectUnitTestFiles(paths: string[]): Promise<string[]> {
  const testFiles: string[] = [];
  for (const path of paths) {
    const absolutePath = resolve(repoRoot, path);
    const pathStat = await stat(absolutePath);
    if (pathStat.isFile()) {
      testFiles.push(absolutePath);
      continue;
    }
    for (const pattern of ["**/*.test.ts", "**/*.test.tsx"]) {
      const glob = new Bun.Glob(pattern);
      for await (const testFile of glob.scan({ cwd: absolutePath, absolute: true })) {
        if (!excludedTestPathSegments.some((segment) => testFile.includes(segment))) {
          testFiles.push(testFile);
        }
      }
    }
  }
  return [...new Set(testFiles)].sort();
}

async function main(): Promise<void> {
  const selected = unitTestOptions(Bun.argv.slice(2));
  const files = await collectUnitTestFiles(selected.slices.flatMap((slice) => slice.paths));
  const testFiles = partitionUnitTestFiles(files, selected.total)[selected.shard - 1] ?? [];
  if (!testFiles.length) throw new Error("Selected unit test shard is empty");
  const sourceUrl = Bun.env.DATABASE_URL ?? defaultDatabaseUrl;
  const databaseName = unitDatabaseName(new Date(), globalThis.process.pid, randomUUID());
  const adminUrl = databaseUrlWithName(sourceUrl, "postgres");
  const testUrl = databaseUrlWithName(sourceUrl, databaseName);
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 5 });
  let created = false;
  let primaryError: unknown;

  try {
    await admin`CREATE DATABASE ${admin(databaseName)}`;
    created = true;
    process.stdout.write(`Unit test database created: ${databaseName}\n`);
    const childEnvironment = unitChildEnvironment(Bun.env, testUrl);
    await runCommand(["bun", "run", "db:migrate"], childEnvironment);
    process.stdout.write(
      `Running unit test shard ${selected.shard}/${selected.total} (${testFiles.length}/${files.length} isolated files)\n`,
    );
    for (const testFile of testFiles) {
      const started = performance.now();
      await runCommand(["bun", "test", "--timeout=15000", testFile], childEnvironment);
      process.stdout.write(
        `UNIT_TEST_TIMING ${JSON.stringify({
          file: relative(repoRoot, testFile),
          seconds: (performance.now() - started) / 1000,
        })}\n`,
      );
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    if (created) {
      await admin`DROP DATABASE ${admin(databaseName)} WITH (FORCE)`;
      process.stdout.write(`Unit test database removed: ${databaseName}\n`);
    }
  } catch (error) {
    cleanupError = error;
  }
  try {
    await admin.end({ timeout: 5 });
  } catch (error) {
    cleanupError ??= error;
  }

  if (primaryError !== undefined) {
    if (cleanupError !== undefined) {
      console.error("Unit test database cleanup also failed", cleanupError);
    }
    throw primaryError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
}

if (import.meta.main) {
  await main();
}
