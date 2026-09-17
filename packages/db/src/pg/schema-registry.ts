/**
 * Software artifact registry schema.
 *
 * Registry tables are grouped separately from the platform schema.
 *
 * The schema implements three concerns:
 *
 *  1. **Three-tier namespacing** — every artifact lives under a
 *     (`namespace_kind`, `namespace_owner`) tuple where `kind` is one of
 *     'public' | 'org' | 'user'. `owner` is NULL for public, an org id for
 *     org, and a user id for user. The middleware enforces RBAC against
 *     this tuple.
 *
 *  2. **OCI Distribution Spec subset** — `oci_repository` / `oci_tag` /
 *     `oci_manifest` / `oci_blob` / `oci_upload_session` together model
 *     the bare minimum needed to run `docker push` and `docker pull`
 *     against the registry.
 *
 *  3. **Spack buildcache distribution** — `spack_package` is a flat
 *     index of pre-built Spack specs the agents can pull via presigned
 *     download.
 *
 * `audit_release` is a single-table append-only audit log for any
 * release-affecting action: push, force-push, pull, delete. The
 * registry is otherwise immutable: tags cannot be re-pushed without a
 * `force` flag, which always writes a 'force-push' audit row.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * `bytea` custom type — Drizzle's pg-core does not export bytea directly.
 *
 * The driver returns a Node `Buffer` for bytea columns and accepts a
 * `Buffer | Uint8Array` on insert. We expose it as `Uint8Array` to keep
 * the public API portable across runtimes while transparently accepting
 * `Buffer` (which extends `Uint8Array`) at the Bun layer.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return value instanceof Buffer ? value : Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return value;
  },
});

/**
 * Repository — the OCI "name" component before the tag.
 *
 * `(namespace_kind, namespace_owner, name)` is the natural key. We
 * choose a unique index over a composite primary key so internal
 * references can use a stable surrogate `id`.
 */
export const ociRepository = pgTable(
  "oci_repository",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespaceKind: varchar("namespace_kind", { length: 16 }).notNull(),
    /** NULL for public; orgId for org; userId for user. */
    namespaceOwner: uuid("namespace_owner"),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    nsNameIdx: uniqueIndex("oci_repository_ns_name_idx").on(
      t.namespaceKind,
      t.namespaceOwner,
      t.name,
    ),
    namespaceKindCheck: check(
      "oci_repository_namespace_kind_check",
      sql`${t.namespaceKind} IN ('public', 'org', 'user')`,
    ),
  }),
);

/**
 * Tag — points a human-readable label at an immutable manifest digest.
 *
 * Once written, application code rejects re-push of the same `(repo, tag)`
 * pair unless the caller passes `force=true` and the audit row is
 * recorded by the service layer. The `latest` tag is exempt from
 * immutability and may be re-pointed freely.
 */
export const ociTag = pgTable(
  "oci_tag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .references(() => ociRepository.id, { onDelete: "cascade" })
      .notNull(),
    tag: varchar("tag", { length: 255 }).notNull(),
    /** sha256:... pointing at the underlying manifest. */
    manifestDigest: varchar("manifest_digest", { length: 80 }).notNull(),
    immutableAt: timestamp("immutable_at").defaultNow().notNull(),
    pushedBy: uuid("pushed_by"),
  },
  (t) => ({
    repoTagIdx: uniqueIndex("oci_tag_repo_tag_idx").on(t.repositoryId, t.tag),
    repoTagDigestIdx: index("oci_tag_repo_digest_idx").on(t.repositoryId, t.manifestDigest),
  }),
);

/**
 * Manifest — content-addressed by `sha256:<digest>`.
 *
 * Content addressing is global: the same manifest can be reachable via
 * many `(repo, tag)` pairs. The raw bytes (`body`) are kept verbatim so
 * the registry can replay the exact bytes on GET — important because
 * any re-serialization changes the digest.
 */
export const ociManifest = pgTable("oci_manifest", {
  digest: varchar("digest", { length: 80 }).primaryKey(),
  mediaType: varchar("media_type", { length: 255 }).notNull(),
  configDigest: varchar("config_digest", { length: 80 }),
  layers: jsonb("layers")
    .$type<Array<{ digest: string; mediaType: string; size: number }>>()
    .notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  body: bytea("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Blob — content-addressed binary layer. Bytes live in MinIO under
 * `storage_key`; the row is metadata only.
 */
export const ociBlob = pgTable("oci_blob", {
  digest: varchar("digest", { length: 80 }).primaryKey(),
  size: bigint("size", { mode: "number" }).notNull(),
  storageKey: varchar("storage_key", { length: 512 }).notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
});

/**
 * Upload session — tracks an in-progress chunked blob upload.
 *
 * The Docker Registry v2 protocol issues a UUID on `POST .../uploads/`
 * and clients PATCH chunks against it before finalizing with PUT
 * `?digest=...`. We persist the running offset so a flaky client can
 * resume.
 */
export const ociUploadSession = pgTable("oci_upload_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .references(() => ociRepository.id, { onDelete: "cascade" })
    .notNull(),
  uuidToken: varchar("uuid_token", { length: 64 }).notNull().unique(),
  totalUploaded: bigint("total_uploaded", { mode: "number" }).notNull().default(0),
  storageKey: varchar("storage_key", { length: 512 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Spack buildcache index row. `(hash, arch)` is the natural key — the
 * same Spack DAG hash can produce different binaries per arch, so both
 * fields are needed.
 */
export const spackPackage = pgTable(
  "spack_package",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespaceKind: varchar("namespace_kind", { length: 16 }).notNull(),
    namespaceOwner: uuid("namespace_owner"),
    spec: varchar("spec", { length: 500 }).notNull(),
    /** Spack 32-char DAG hash. */
    hash: varchar("hash", { length: 64 }).notNull(),
    arch: varchar("arch", { length: 64 }).notNull(),
    buildcacheUrl: text("buildcache_url").notNull(),
    manifestUrl: text("manifest_url").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    uploadedBy: uuid("uploaded_by"),
    uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  },
  (t) => ({
    hashArchIdx: uniqueIndex("spack_package_hash_arch_idx").on(t.hash, t.arch),
    nsArchIdx: index("spack_package_ns_arch_idx").on(t.namespaceKind, t.namespaceOwner, t.arch),
    namespaceKindCheck: check(
      "spack_package_namespace_kind_check",
      sql`${t.namespaceKind} IN ('public', 'org', 'user')`,
    ),
  }),
);

/**
 * Append-only release audit log. Every push, force-push, pull, and
 * delete writes one row. `metadata` carries action-specific context —
 * for `force-push` the previous and new digests, for `delete` the
 * deleted digest, etc.
 */
export const auditRelease = pgTable(
  "audit_release",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: varchar("action", { length: 32 }).notNull(),
    resourceKind: varchar("resource_kind", { length: 32 }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    actor: uuid("actor").notNull(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({
    resourceIdx: index("audit_release_resource_idx").on(t.resourceKind, t.resourceId),
    actorIdx: index("audit_release_actor_idx").on(t.actor, t.occurredAt),
    actionCheck: check(
      "audit_release_action_check",
      sql`${t.action} IN ('push', 'force-push', 'pull', 'delete')`,
    ),
    resourceKindCheck: check(
      "audit_release_resource_kind_check",
      sql`${t.resourceKind} IN ('oci-tag', 'spack-package', 'oci-repository')`,
    ),
  }),
);
