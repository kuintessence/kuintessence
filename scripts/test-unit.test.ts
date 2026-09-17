import { describe, expect, test } from "bun:test";
import {
  collectUnitTestFiles,
  databaseUrlWithName,
  unitChildEnvironment,
  unitDatabaseName,
} from "./test-unit";

describe("unit test database harness", () => {
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
