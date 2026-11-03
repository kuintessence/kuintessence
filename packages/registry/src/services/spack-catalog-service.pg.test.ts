import { afterAll, expect, test } from "bun:test";
import { createPgDb, softwareAssets } from "@kuintessence/db";
import { inArray } from "drizzle-orm";
import { SpackCatalogService } from "./spack-catalog-service";

const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");
const service = new SpackCatalogService(db);
const prefix = `offline-catalog-${crypto.randomUUID()}`;
const ids: string[] = [];
const licensePolicy = {
  classification: "open-source",
  identifiers: [{ kind: "spdx", value: "MIT" }],
  provenance: { source: "platform-fork", reference: "https://example.test/license" },
  autoInstall: "review-required",
};

afterAll(async () => {
  if (ids.length) await db.delete(softwareAssets).where(inArray(softwareAssets.id, ids));
});

test("lists published imported Spack assets with their identity, policy and pinned spec", async () => {
  const states = [
    ["published", "platform-public"],
    ["published", "platform-public"],
    ["draft", "platform-public"],
    ["deprecated", "platform-public"],
    ["published", "private"],
    ["archived", "hidden"],
  ];
  const rows = await db
    .insert(softwareAssets)
    .values(
      states.map(([lifecycle, visibility], index) => ({
        kind: "spack-package",
        name: `${prefix}-${index}`,
        version: "1.2.3",
        source: "platform-fork",
        lifecycle,
        visibility,
        payload: {
          kind: "spack-package",
          spack: {
            packageName: "hello",
            defaultSpec: "hello@1.2.3+example target=x86_64",
            dependencies: ["zlib"],
          },
        },
        provenance: { ecosystemKey: `software/${prefix}-${index}`, licensePolicy },
      })),
    )
    .returning();
  ids.push(...rows.map((row) => row.id));
  const first = await service.list({ q: prefix, source: "official", pageSize: 1 });
  const second = await service.list({ q: prefix, source: "official", pageSize: 1, page: 2 });
  expect(first.totalCount).toBe(2);
  expect(first.totalPages).toBe(2);
  expect(second.hasNext).toBe(false);
  const packages = [...first.packages, ...second.packages];
  expect(packages.map((pkg) => pkg.asset?.id).sort()).toEqual(ids.slice(0, 2).sort());
  for (const pkg of packages) {
    expect(pkg.id).toBeUndefined();
    expect(pkg.defaultSpec).toBe("hello@1.2.3+example target=x86_64");
    expect(pkg.licensePolicy?.autoInstall).toBe("review-required");
    expect(pkg.metadata).toMatchObject({
      versions: ["1.2.3"],
      dependencies: ["zlib"],
      licenses: ["MIT"],
    });
  }
  expect((await service.list({ q: prefix, source: "all" })).totalCount).toBe(2);
  expect((await service.list({ q: prefix, source: "upstream" })).totalCount).toBe(0);
  expect((await service.list({ q: prefix, source: "vendor" })).totalCount).toBe(0);
  expect((await service.list({ q: `${prefix}-0`, source: "official" })).packages).toHaveLength(1);
});
