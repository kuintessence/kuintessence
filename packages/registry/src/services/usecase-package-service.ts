import { createHash } from "node:crypto";
import {
  ecosystemReleaseAssets,
  ecosystemReleases,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
  usecasePackages,
} from "@kuintessence/db";
import { AppError, ErrorCode, usecase } from "@kuintessence/shared";
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { RbacPrincipal } from "./namespace";
import {
  type AssetGrantInput,
  platformPublicGrants,
  type SoftwareAssetService,
} from "./software-asset-service";

export type UsecasePackageScope =
  | { namespace: "platform"; ownerSubject: string }
  | { namespace: "org"; ownerOrgId: string; ownerSubject: string }
  | { namespace: "user"; ownerSubject: string };

export interface UsecasePackageListQuery {
  page?: number;
  pageSize?: number;
  principal: RbacPrincipal | null;
  orgId?: string;
  q?: string;
  tag?: string;
}

export interface UsecasePackagePage {
  packages: PublishedUsecasePackage[];
  tags: string[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

export type PublishedUsecasePackage = typeof usecasePackages.$inferSelect & {
  /** Immutable published Spack asset revision required by the workflow DSL. */
  publishedSoftwareRevisionId?: string;
};

type PgTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

/**
 * P4-b storage: structured usecase packages. The `spec` column holds a
 * UsecasePackage validated by UsecasePackageSchema at the boundary (on write,
 * and re-validated on read by the engine's package resolver).
 */
export class UsecasePackageService {
  constructor(
    private db: PgDb,
    private readonly assets?: SoftwareAssetService,
  ) {}

  async create(
    data: usecase.UsecasePackageCreate,
    scope?: UsecasePackageScope,
    createdBy?: string,
  ) {
    const spec = usecase.UsecasePackageSchema.parse(data.spec);
    const specDigest = digestSpec(spec);
    const effectiveScope = scope ?? { namespace: "platform" as const, ownerSubject: "" };
    return this.db.transaction(async (tx) => {
      const existing = await findByIdentity(tx, data.name, data.version, effectiveScope);
      if (existing) {
        if (matchesPackage(existing, data, specDigest)) return existing;
        throw versionConflict(data.name, data.version);
      }
      const [row] = await tx
        .insert(usecasePackages)
        .values({
          name: data.name,
          version: data.version,
          description: data.description ?? null,
          spec,
          specDigest,
          namespace: effectiveScope.namespace,
          ownerSubject: effectiveScope.ownerSubject || null,
          ownerOrgId: effectiveScope.namespace === "org" ? effectiveScope.ownerOrgId : null,
          provenance: { source: "registry-api", namespace: effectiveScope.namespace },
          createdBy: createdBy ?? null,
        })
        .returning();
      if (!row) throw new AppError(ErrorCode.INTERNAL_ERROR, "Insert returned no rows", 500);
      await this.syncAsset(row, createdBy ?? null, tx);
      return row;
    });
  }

  async getById(id: string, principal: RbacPrincipal | null = null, orgId?: string) {
    const [row] = await this.db
      .select()
      .from(usecasePackages)
      .where(eq(usecasePackages.id, id))
      .limit(1);
    if (!row || !canRead(row, principal, orgId)) return null;
    return (await this.withPublishedSoftwareRevisions([row]))[0] ?? row;
  }

  async findByNameVersion(name: string, version: string) {
    const [row] = await this.db
      .select()
      .from(usecasePackages)
      .where(
        and(
          eq(usecasePackages.name, name),
          eq(usecasePackages.version, version),
          usecaseCatalogVisibility(),
        ),
      )
      .orderBy(desc(usecasePackages.createdAt), desc(usecasePackages.id))
      .limit(1);
    return row ?? null;
  }

  async list(limit = 100, principal: RbacPrincipal | null = null) {
    return (await this.listPage({ pageSize: limit, principal })).packages;
  }

  async listPage(input: UsecasePackageListQuery): Promise<UsecasePackagePage> {
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 24, 100));
    const requestedPage = Math.max(1, input.page ?? 1);
    const query = input.q?.trim().toLowerCase() ?? "";
    const tag = input.tag?.trim() ?? "";
    const filter = and(
      usecaseCatalogVisibility(),
      usecaseReadScope(input.principal, input.orgId),
      query.length > 0
        ? or(
            ilike(usecasePackages.name, `%${escapeLike(query)}%`),
            ilike(usecasePackages.version, `%${escapeLike(query)}%`),
            ilike(usecasePackages.description, `%${escapeLike(query)}%`),
          )
        : undefined,
      tag.length > 0
        ? sql`(${usecasePackages.provenance} -> 'tags') @> ${JSON.stringify([tag])}::jsonb`
        : undefined,
    );
    const [totalRows, tagRows] = await Promise.all([
      this.db.select({ total: count() }).from(usecasePackages).where(filter),
      this.db.execute<{ tag: string }>(sql`
        SELECT DISTINCT package_tag.value AS tag
        FROM ${usecasePackages}
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(${usecasePackages.provenance} -> 'tags') = 'array'
              THEN ${usecasePackages.provenance} -> 'tags'
            ELSE '[]'::jsonb
          END
        ) AS package_tag(value)
        WHERE ${and(usecaseCatalogVisibility(), usecaseReadScope(input.principal, input.orgId))}
        ORDER BY package_tag.value
      `),
    ]);
    const total = totalRows[0]?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const [packages] = await Promise.all([
      this.db
        .select()
        .from(usecasePackages)
        .where(filter)
        .orderBy(desc(usecasePackages.createdAt), desc(usecasePackages.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);
    return {
      packages: await this.withPublishedSoftwareRevisions(packages),
      tags: tagRows.map((row) => row.tag),
      total,
      page,
      pageSize,
      totalPages,
      hasNext: page < totalPages,
    };
  }

  /**
   * Workflow execution requires a frozen software asset revision. Resolve
   * the package's logical selector here, so packages without a published
   * revision remain visible but cannot be picked for execution.
   */
  private async withPublishedSoftwareRevisions(
    packages: Array<typeof usecasePackages.$inferSelect>,
  ): Promise<PublishedUsecasePackage[]> {
    const selectors = packages.flatMap((pkg) => {
      const spec = usecase.UsecasePackageSchema.parse(pkg.spec);
      return "softwareRef" in spec ? [{ packageId: pkg.id, selector: spec.softwareRef }] : [];
    });
    if (selectors.length === 0) return packages;

    const assets = await this.db
      .select({
        source: softwareAssets.source,
        name: softwareAssets.name,
        version: softwareAssets.version,
        providerOrgId: softwareAssets.providerOrgId,
        revisionId: softwareAssetRevisions.id,
      })
      .from(softwareAssets)
      .innerJoin(softwareAssetRevisions, eq(softwareAssetRevisions.assetId, softwareAssets.id))
      .where(
        and(
          eq(softwareAssets.kind, "spack-package"),
          eq(softwareAssets.lifecycle, "published"),
          or(
            ...selectors.map(({ selector }) =>
              and(
                eq(softwareAssets.source, selector.source),
                eq(softwareAssets.name, selector.name),
                eq(softwareAssets.version, selector.version),
                selector.providerOrgId
                  ? eq(softwareAssets.providerOrgId, selector.providerOrgId)
                  : isNull(softwareAssets.providerOrgId),
              ),
            ),
          ),
        ),
      )
      .orderBy(desc(softwareAssetRevisions.revision));

    const revisionBySelector = new Map<string, string>();
    for (const asset of assets) {
      const key = softwareSelectorKey(asset);
      if (!revisionBySelector.has(key)) revisionBySelector.set(key, asset.revisionId);
    }
    return packages.map((pkg) => {
      const selector = selectors.find((entry) => entry.packageId === pkg.id)?.selector;
      const revisionId = selector && revisionBySelector.get(softwareSelectorKey(selector));
      return revisionId ? { ...pkg, publishedSoftwareRevisionId: revisionId } : pkg;
    });
  }

  async updateById(id: string, data: usecase.UsecasePackageUpdate, principal?: RbacPrincipal) {
    const spec = usecase.UsecasePackageSchema.parse(data.spec);
    const source = await this.assertMutableAndWritable(id, principal);
    const nextDigest = digestSpec(spec);
    if (matchesPackage(source, data, nextDigest)) return source;
    const scope = scopeFromRow(source);
    return this.db.transaction(async (tx) => {
      const existing = await findByIdentity(tx, data.name, data.version, scope);
      if (existing) {
        if (matchesPackage(existing, data, nextDigest)) return existing;
        throw versionConflict(data.name, data.version);
      }
      const [created] = await tx
        .insert(usecasePackages)
        .values({
          name: data.name,
          version: data.version,
          description: data.description ?? null,
          spec,
          specDigest: nextDigest,
          namespace: source.namespace,
          ownerSubject: source.ownerSubject,
          ownerOrgId: source.ownerOrgId,
          provenance: source.provenance,
          createdBy: canonicalUserId(principal?.sub),
        })
        .returning();
      if (!created) throw new AppError(ErrorCode.INTERNAL_ERROR, "Insert returned no rows", 500);
      await this.syncAsset(created, canonicalUserId(principal?.sub), tx);
      return created;
    });
  }

  async deleteById(id: string, principal?: RbacPrincipal) {
    await this.assertMutableAndWritable(id, principal);
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Published usecase packages cannot be deleted. Publish a replacement version instead.",
      409,
    );
  }

  private async assertMutableAndWritable(id: string, principal?: RbacPrincipal) {
    const [row] = await this.db
      .select()
      .from(usecasePackages)
      .where(eq(usecasePackages.id, id))
      .limit(1);
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, `Usecase package ${id} not found`, 404);
    const [pinned] = await this.db
      .select({ id: ecosystemReleaseAssets.id })
      .from(ecosystemReleaseAssets)
      .innerJoin(ecosystemReleases, eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id))
      .where(
        and(
          eq(ecosystemReleaseAssets.usecasePackageId, id),
          inArray(ecosystemReleases.status, ["staged", "active"]),
        ),
      )
      .limit(1);
    if (row.immutableAt || pinned) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Usecase package is pinned by a staged or active ecosystem release",
        409,
      );
    }
    if (!principal)
      throw new AppError(ErrorCode.FORBIDDEN, "Usecase package requires a principal", 403);
    if (principal.role === "super_admin") return row;
    if (row.namespace === "platform") {
      if (principal.role === "platform_admin") return row;
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Platform usecase packages require platform_admin",
        403,
      );
    }
    if (row.namespace === "org") {
      if (
        principal.role === "platform_admin" ||
        (principal.role === "org_admin" &&
          row.ownerOrgId !== null &&
          principal.orgIds.includes(row.ownerOrgId))
      ) {
        return row;
      }
      throw new AppError(ErrorCode.FORBIDDEN, "Organization usecase package is outside scope", 403);
    }
    if (row.ownerSubject === principal.sub) return row;
    throw new AppError(ErrorCode.FORBIDDEN, "User usecase package is outside scope", 403);
  }

  private async syncAsset(
    row: typeof usecasePackages.$inferSelect,
    createdBy: string | null,
    tx: PgTransaction,
  ) {
    if (!this.assets) return;
    const spec = usecase.UsecasePackageSchema.parse(row.spec);
    const scope = assetScope(row);
    await this.assets.inTransaction(tx).upsertAsset({
      kind: "usecase",
      name: row.name,
      version: row.version,
      source: scope.source,
      lifecycle: "published",
      visibility: scope.visibility,
      trustedForGlobalUse: scope.trustedForGlobalUse,
      ownerOrgId: scope.ownerOrgId,
      createdBy,
      legacyRef: { field: "usecasePackageId", value: row.id },
      payload: {
        kind: "usecase",
        usecasePackageId: row.id,
        packageRefs: packageRefsFromUsecase(spec),
        spec,
      },
      provenance: {
        source: scope.source,
        legacyTable: "usecase_packages",
        namespace: row.namespace,
      },
      grants: scope.grants,
    });
  }
}

function assetScope(row: typeof usecasePackages.$inferSelect): {
  source: "cp-shared" | "platform-fork" | "sp-draft";
  visibility: "platform-public" | "private" | "shared-to-orgs";
  trustedForGlobalUse: boolean;
  ownerOrgId: string | null;
  grants: AssetGrantInput[];
} {
  if (row.namespace === "org" && row.ownerOrgId) {
    return {
      source: "cp-shared" as const,
      visibility: "shared-to-orgs" as const,
      trustedForGlobalUse: false,
      ownerOrgId: row.ownerOrgId,
      grants: [
        {
          subjectKind: "org" as const,
          subjectId: row.ownerOrgId,
          capabilities: ["view", "use", "admin"],
        },
      ],
    };
  }
  if (row.namespace === "user" && row.ownerSubject) {
    return {
      source: "sp-draft" as const,
      visibility: "private" as const,
      trustedForGlobalUse: false,
      ownerOrgId: null,
      grants: [
        {
          subjectKind: "user" as const,
          subjectId: row.ownerSubject,
          capabilities: ["view", "use", "admin"],
        },
      ],
    };
  }
  return {
    source: "platform-fork" as const,
    visibility: "platform-public" as const,
    trustedForGlobalUse: true,
    ownerOrgId: null,
    grants: platformPublicGrants(),
  };
}

export function digestSpec(spec: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(spec)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new AppError(ErrorCode.VALIDATION_ERROR, "Usecase spec contains a non-JSON value", 422);
}

function packageRefsFromUsecase(spec: usecase.UsecasePackage) {
  if (spec.software.kind !== "Spack") return [];
  return [
    {
      kind: "spack-package" as const,
      source: "official-upstream",
      name: spec.software.name,
      ...(spec.software.version ? { version: spec.software.version } : {}),
    },
  ];
}

function canRead(
  row: typeof usecasePackages.$inferSelect,
  principal: RbacPrincipal | null,
  selectedOrgId?: string,
): boolean {
  if (row.namespace === "platform") return true;
  if (!principal) return false;
  if (principal.role === "super_admin" || principal.role === "platform_admin") return true;
  if (row.namespace === "org") {
    return (
      row.ownerOrgId !== null &&
      principal.orgIds.includes(row.ownerOrgId) &&
      (selectedOrgId === undefined || row.ownerOrgId === selectedOrgId)
    );
  }
  return row.ownerSubject === principal.sub;
}

function scopeFromRow(row: typeof usecasePackages.$inferSelect): UsecasePackageScope {
  if (row.namespace === "org" && row.ownerOrgId) {
    return { namespace: "org", ownerOrgId: row.ownerOrgId, ownerSubject: row.ownerSubject ?? "" };
  }
  if (row.namespace === "user") {
    return { namespace: "user", ownerSubject: row.ownerSubject ?? "" };
  }
  return { namespace: "platform", ownerSubject: row.ownerSubject ?? "" };
}

function matchesPackage(
  row: typeof usecasePackages.$inferSelect,
  data: usecase.UsecasePackageCreate,
  specDigest: string,
): boolean {
  return (
    row.name === data.name &&
    row.version === data.version &&
    row.description === (data.description ?? null) &&
    row.specDigest === specDigest
  );
}

function usecaseCatalogVisibility() {
  const binding = sql`${ecosystemReleaseAssets.kind} = 'usecase' AND ${ecosystemReleaseAssets.usecasePackageId} = ${usecasePackages.id}`;
  const anyBinding = sql`EXISTS (SELECT 1 FROM ${ecosystemReleaseAssets} WHERE ${binding})`;
  const activeBinding = sql`EXISTS (
    SELECT 1
    FROM ${ecosystemReleaseAssets}
    INNER JOIN ${ecosystemReleases} ON ${ecosystemReleaseAssets.releaseId} = ${ecosystemReleases.id}
    WHERE ${binding} AND ${ecosystemReleases.status} = 'active'
  )`;
  return sql`(${anyBinding} = false OR ${activeBinding})`;
}

function usecaseReadScope(principal: RbacPrincipal | null, selectedOrgId?: string) {
  if (!principal) return eq(usecasePackages.namespace, "platform");
  if (principal.role === "super_admin" || principal.role === "platform_admin") return sql`true`;
  const orgScope =
    principal.orgIds.length === 0
      ? sql`false`
      : and(
          eq(usecasePackages.namespace, "org"),
          inArray(usecasePackages.ownerOrgId, principal.orgIds),
          selectedOrgId ? eq(usecasePackages.ownerOrgId, selectedOrgId) : undefined,
        );
  return or(
    eq(usecasePackages.namespace, "platform"),
    orgScope,
    and(eq(usecasePackages.namespace, "user"), eq(usecasePackages.ownerSubject, principal.sub)),
  );
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function findByIdentity(
  db: PgDb | PgTransaction,
  name: string,
  version: string,
  scope: UsecasePackageScope,
) {
  const filters = [
    eq(usecasePackages.name, name),
    eq(usecasePackages.version, version),
    eq(usecasePackages.namespace, scope.namespace),
  ];
  if (scope.namespace === "org") filters.push(eq(usecasePackages.ownerOrgId, scope.ownerOrgId));
  if (scope.namespace === "user")
    filters.push(eq(usecasePackages.ownerSubject, scope.ownerSubject));
  const [row] = await db
    .select()
    .from(usecasePackages)
    .where(and(...filters))
    .limit(1);
  return row ?? null;
}

function versionConflict(name: string, version: string): AppError {
  return new AppError(
    ErrorCode.VALIDATION_ERROR,
    `Usecase package ${name}@${version} already exists with different content. Choose a new version.`,
    409,
  );
}

function canonicalUserId(subject: string | undefined): string | null {
  if (!subject) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subject)
    ? subject
    : null;
}

function softwareSelectorKey(input: {
  source: string;
  name: string;
  version: string;
  providerOrgId?: string | null;
}): string {
  return `${input.source}\u0000${input.name}\u0000${input.version}\u0000${input.providerOrgId ?? ""}`;
}
