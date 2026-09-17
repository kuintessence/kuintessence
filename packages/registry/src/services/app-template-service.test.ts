import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appTemplates, createPgDb, type PgDb } from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import { AppTemplateService } from "./app-template-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("AppTemplateService", () => {
  let db: PgDb;
  let service: AppTemplateService;
  const ids: string[] = [];

  beforeAll(() => {
    db = createPgDb(TEST_DB_URL);
    service = new AppTemplateService(db);
  });

  afterAll(async () => {
    for (const id of ids) {
      await db.delete(appTemplates).where(eq(appTemplates.id, id));
    }
    await db.delete(appTemplates).where(like(appTemplates.name, "appsvc-test-%"));
  });

  test("create + getById", async () => {
    const t = await service.create({
      name: "appsvc-test-wrf",
      version: "4.4",
      spec: "wrf@4.4 +netcdf",
      specKind: "spack",
      tags: ["meteorology", "fortran"],
    });
    ids.push(t.id);
    const got = await service.getById(t.id);
    expect(got?.name).toBe("appsvc-test-wrf");
    expect(got?.tags).toEqual(["meteorology", "fortran"]);
  });

  test("findByNameVersion", async () => {
    const t = await service.create({
      name: "appsvc-test-vasp",
      version: "6.4.1",
      spec: "vasp@6.4.1",
      specKind: "spack",
    });
    ids.push(t.id);
    const got = await service.findByNameVersion("appsvc-test-vasp", "6.4.1");
    expect(got?.id).toBe(t.id);
  });

  test("findByNameVersion returns null for unknown", async () => {
    const got = await service.findByNameVersion("no-such-app", "0.0.0");
    expect(got).toBeNull();
  });

  test("list returns recent templates", async () => {
    const list = await service.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  test("listByTag filters by tag", async () => {
    const list = await service.listByTag("meteorology");
    expect(list.some((r) => r.name === "appsvc-test-wrf")).toBe(true);
  });

  test("deleteById removes template", async () => {
    const t = await service.create({
      name: "appsvc-test-del",
      version: "0.0.1",
      spec: "x@0.0.1",
      specKind: "spack",
    });
    await service.deleteById(t.id);
    expect(await service.getById(t.id)).toBeNull();
  });

  test("deleteById throws NOT_FOUND for unknown id", async () => {
    await expect(service.deleteById("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
  });
});
