import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgDb, loadPgMigrationFiles, migratePostgresDatabase } from "@kuintessence/db";
import { InMemoryBlobStore } from "./blob-store";
import { NoopAuditPort, RegistryService } from "./registry-service";

test("a populated buildcache upgrade rolls back without ownership and binds each row to exactly one repository", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!/^\/kuintessence_unit_[a-z0-9_]+$/.test(url.pathname))
    throw new Error("Requires an isolated unit database");
  const admin = createPgDb(url.toString()).$client;
  const name = `kuintessence_unit_spack_${crypto.randomUUID().replaceAll("-", "")}`;
  url.pathname = `/${name}`;
  const db = createPgDb(url.toString());
  const sql = db.$client;
  const dir = await mkdtemp(join(tmpdir(), "kq-spack-bindings-"));
  const file = join(dir, "bindings.json");
  const previous = process.env.SPACK_REPOSITORY_BINDINGS_FILE;
  let created = false;
  try {
    await admin`CREATE DATABASE ${admin(name)}`;
    created = true;
    const migrations = await loadPgMigrationFiles();
    await migratePostgresDatabase(
      url.toString(),
      migrations.filter((m) => m.tag < "0081"),
    );
    const owner = crypto.randomUUID();
    const hash = "a".repeat(32);
    const blobs = new InMemoryBlobStore();
    const archive = await blobs.put(new TextEncoder().encode("previously published"));
    const archiveUrl = `blob:${archive.digest}`;
    const [row] =
      await sql`INSERT INTO spack_package(namespace_kind, namespace_owner, spec, hash, arch, buildcache_url, manifest_url)
       VALUES ('user', ${owner}, 'tool@1', ${hash}, 'linux', ${archiveUrl}, ${archiveUrl}) RETURNING id`;
    if (!row) throw new Error("Missing test package");
    delete process.env.SPACK_REPOSITORY_BINDINGS_FILE;
    await expect(migratePostgresDatabase(url.toString(), migrations)).rejects.toThrow(
      "SPACK_REPOSITORY_BINDINGS_FILE",
    );
    process.env.SPACK_REPOSITORY_BINDINGS_FILE = file;
    await writeFile(file, JSON.stringify({ [row.id]: "public/other" }));
    await expect(migratePostgresDatabase(url.toString(), migrations)).rejects.toThrow(
      "Invalid repository binding",
    );
    const columns =
      await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'spack_package' AND column_name = 'repository_name'`;
    expect(columns).toHaveLength(0);
    await writeFile(file, JSON.stringify({ [row.id]: `user/${owner}/science` }));
    await migratePostgresDatabase(url.toString(), migrations);
    await migratePostgresDatabase(url.toString(), migrations);
    const registry = new RegistryService(db, blobs, new NoopAuditPort());
    const ns = { kind: "user" as const, owner, name: "science" };
    const artifact = { ns, package: "tool", hash, kind: "tarball" as const };
    expect(await registry.listSpackIndex(ns)).toMatchObject([
      { hash, buildcacheUrl: archiveUrl, manifestUrl: null },
    ]);
    const { stream } = await registry.getSpackArtifact(artifact);
    expect(await new Response(stream).text()).toBe("previously published");
    const neighbor = { ...ns, name: "other" };
    expect(await registry.listSpackIndex(neighbor)).toHaveLength(0);
    await expect(registry.getSpackArtifact({ ...artifact, ns: neighbor })).rejects.toMatchObject({
      status: 404,
    });
  } finally {
    if (previous === undefined) delete process.env.SPACK_REPOSITORY_BINDINGS_FILE;
    else process.env.SPACK_REPOSITORY_BINDINGS_FILE = previous;
    await sql.end();
    try {
      if (created) await admin`DROP DATABASE ${admin(name)}`;
    } finally {
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 30000);
