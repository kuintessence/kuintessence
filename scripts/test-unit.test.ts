import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPgMigrationFiles } from "@kuintessence/db";
import { parse } from "yaml";
import {
  collectUnitTestFiles,
  databaseUrlWithName,
  selectUnitTestSlices,
  unitChildEnvironment,
  unitDatabaseName,
} from "./test-unit";

describe("unit test database harness", () => {
  test("suite selection is explicit, rejects unknown arguments and preserves the default slices", async () => {
    expect(selectUnitTestSlices([]).map((slice) => slice.name)).toEqual([
      "core",
      "server",
      "registry",
    ]);
    expect(selectUnitTestSlices(["--suite", "offline-slurm-pg"])).toEqual([
      {
        name: "offline-slurm-pg",
        paths: ["packages/server/src/services/offline-slurm.pg.test.ts"],
      },
    ]);
    expect(selectUnitTestSlices(["--suite", "server"])[0]?.name).toBe("server");
    expect(() => selectUnitTestSlices(["--suite", "unknown"])).toThrow("Unknown unit test suite");
    expect(() => selectUnitTestSlices(["packages/server"])).toThrow("Usage:");
    expect(() => selectUnitTestSlices(["--suite", "server", "--unsafe"])).toThrow("Usage:");
    const selected = selectUnitTestSlices(["--suite", "offline-slurm-pg"])[0];
    expect(await collectUnitTestFiles(selected?.paths ?? [])).toHaveLength(1);
  });

  test("recovery migrations follow 0072 in journal order with strictly increasing timestamps", async () => {
    const migrations = await loadPgMigrationFiles();
    const index = migrations.findIndex((migration) => migration.tag === "0073_classy_dagger");
    expect(index).toBeGreaterThan(0);
    expect(migrations.slice(index - 1, index + 2).map((migration) => migration.tag)).toEqual([
      "0072_odd_thunderbolt",
      "0073_classy_dagger",
      "0074_neat_zarda",
    ]);
    expect(migrations[index]?.folderMillis ?? 0).toBeGreaterThan(
      migrations[index - 1]?.folderMillis ?? 0,
    );
    expect(migrations[index + 1]?.folderMillis ?? 0).toBeGreaterThan(
      migrations[index]?.folderMillis ?? 0,
    );
    expect(migrations[index]?.statements.join("\n")).toMatch(
      /ALTER TABLE "file_transfers" ADD COLUMN "resume_session" jsonb/,
    );
    expect(migrations[index + 1]?.statements.join("\n")).toMatch(
      /ALTER TABLE "agents" ADD COLUMN "site_operations" jsonb/,
    );
  });

  test("CI runs the focused disposable-database suite against its PostgreSQL service", async () => {
    const workflow = parse(
      await readFile(resolve(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          services?: Record<string, { image?: string }>;
          steps: { name?: string; run?: string; env?: Record<string, string> }[];
        }
      >;
    };
    const job = workflow.jobs.test;
    expect(job?.services?.postgres?.image).toBe("postgres:16-alpine");
    const focused = job?.steps.find(
      (step) => step.run === "bun run test:unit --suite offline-slurm-pg",
    );
    expect(focused).toBeDefined();
    expect(focused?.env?.DATABASE_URL).toBe("postgres://kq:kq@localhost:5432/kuintessence");
    const stepIndex = focused ? (job?.steps.indexOf(focused) ?? -1) : -1;
    const migrateIndex =
      job?.steps.findIndex((step) => step.name === "Run database migrations") ?? -1;
    expect(stepIndex).toBeGreaterThanOrEqual(0);
    expect(migrateIndex).toBeGreaterThan(stepIndex);
  });

  test("replaces only the database name and preserves connection options", () => {
    expect(
      databaseUrlWithName(
        "postgres://user:pass@localhost:15432/kuintessence?sslmode=disable",
        "kuintessence_unit_1",
      ),
    ).toBe("postgres://user:pass@localhost:15432/kuintessence_unit_1?sslmode=disable");
  });

  test("preserves encoded credentials and TLS connection options", () => {
    expect(
      databaseUrlWithName(
        "postgresql://unit:p%40ss@db.example:5432/source?sslmode=require&application_name=kq",
        "kuintessence_unit_encoded",
      ),
    ).toBe(
      "postgresql://unit:p%40ss@db.example:5432/kuintessence_unit_encoded?sslmode=require&application_name=kq",
    );
  });

  test("rejects a non-PostgreSQL database URL", () => {
    expect(() => databaseUrlWithName("https://localhost/database", "unit")).toThrow(
      "DATABASE_URL must use postgres:// or postgresql://",
    );
  });

  test("rejects a PostgreSQL URL without a host", () => {
    expect(() => databaseUrlWithName("postgres:///database", "kuintessence_unit_1")).toThrow(
      "DATABASE_URL must include a host",
    );
  });

  test("rejects database names outside the unit-test namespace", () => {
    expect(() => databaseUrlWithName("postgres://localhost/source", "production")).toThrow(
      "Unit database name is outside the allowed namespace",
    );
  });

  test("builds a bounded identifier from stable inputs", () => {
    expect(unitDatabaseName(new Date("2026-07-28T09:30:45.000Z"), 1234, "ABCD-1234-extra")).toBe(
      "kuintessence_unit_20260728093045_1234_abcd1234",
    );
  });

  test("isolates database URLs and removes opt-in external E2E gates", () => {
    expect(
      unitChildEnvironment(
        {
          HOME: "/tmp/home",
          DATABASE_URL: "postgres://localhost/live",
          KQ_PG_URL: "postgres://localhost/live",
          SPACK_E2E_CONTAINER: "spack:latest",
          SPICEDB_E2E_ENDPOINT: "localhost:50051",
        },
        "postgres://localhost/kuintessence_unit_child",
      ),
    ).toEqual({
      HOME: "/tmp/home",
      DATABASE_URL: "postgres://localhost/kuintessence_unit_child",
      KQ_PG_URL: "postgres://localhost/kuintessence_unit_child",
    });
  });

  test("collects explicit test files for isolated subprocess execution", async () => {
    const files = await collectUnitTestFiles(["scripts/test-unit.test.ts"]);

    expect(files).toHaveLength(1);
    expect(files[0]?.endsWith("/scripts/test-unit.test.ts")).toBe(true);
  });

  test("does not collect tests shipped inside workspace dependencies", async () => {
    const files = await collectUnitTestFiles(["packages/shared"]);

    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.includes("/node_modules/"))).toBe(false);
  });
});
