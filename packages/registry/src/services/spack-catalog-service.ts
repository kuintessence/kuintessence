import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appTemplates, type PgDb, softwareAssets } from "@kuintessence/db";
import type { SoftwareAssetSummary } from "@kuintessence/shared";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import catalog from "../data/spack-package-catalog.json";
import type { RbacPrincipal } from "./namespace";
import {
  platformPublicGrants,
  providerPrivateGrants,
  rowToSummary,
  type SoftwareAssetService,
} from "./software-asset-service";
import { parseSpackPackageFile, type SpackPackageMetadata } from "./spack-package-parser";
import { UpstreamVersionSnapshotService } from "./upstream-version-snapshot-service";

interface SpackCatalogData {
  source: string;
  sourceRepository: string;
  sourceRef: string;
  generatedAt: string;
  packageCount: number;
  packages: string[];
}

export type SpackCatalogSource = "upstream" | "official" | "vendor";
export type CustomSpackCatalogSource = Exclude<SpackCatalogSource, "upstream">;

export interface SpackCatalogPackage {
  id?: string;
  name: string;
  source: SpackCatalogSource;
  description?: string | null;
  tags: string[];
  metadata?: SpackPackageMetadata;
  asset?: SoftwareAssetSummary;
  createdAt?: string;
  ownerOrgId?: string | null;
}

export interface SpackCatalogQuery {
  q?: string;
  limit?: number;
  page?: number;
  pageSize?: number;
  principal?: RbacPrincipal | null;
  source?: SpackCatalogSource | "all";
}

export interface SpackCatalogPackageInput {
  name: string;
  source: CustomSpackCatalogSource;
  description?: string;
  tags?: string[];
  packageFile?: string;
}

const CATALOG_TAG = "spack-catalog";
const CATALOG_VERSION = "catalog";
const SOURCE_PREFIX = "source:";
const VENDOR_ORG_PREFIX = "vendor-org:";
const CATALOG_SOURCES = new Set<SpackCatalogSource>(["upstream", "official", "vendor"]);
const METADATA_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../data/spack-package-metadata.json",
);
const UPSTREAM_METADATA = loadUpstreamMetadata();
type PgTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

export class SpackCatalogService {
  private readonly data = catalog as SpackCatalogData;
  private readonly snapshots: UpstreamVersionSnapshotService;

  constructor(
    private readonly db: PgDb,
    private readonly assets?: SoftwareAssetService,
  ) {
    this.snapshots = new UpstreamVersionSnapshotService(db);
  }

  syncUpstreamAssets() {
    if (!this.assets) return Promise.resolve({ created: 0, updated: 0, total: 0 });
    return this.assets.syncUpstreamPackages(
      this.data.packages.map((name) => ({ name, metadata: UPSTREAM_METADATA[name] })),
    );
  }

  snapshotUpstreamVersion(name: string, version: string, principal: RbacPrincipal) {
    return this.snapshots.snapshot({ name, version, principal });
  }

  supersedeLegacyUpstreamVersion(input: {
    name: string;
    version: string;
    legacyAssetId: string;
    legacyRevisionId: string;
    reason: string;
    principal: RbacPrincipal;
  }) {
    return this.snapshots.supersedeLegacy(input);
  }

  async list(input: SpackCatalogQuery = {}) {
    const pageSize = Math.max(1, Math.min(input.pageSize ?? input.limit ?? 24, 100));
    const page = Math.max(1, input.page ?? 1);
    const query = input.q?.trim().toLowerCase() ?? "";
    const source = input.source ?? "all";
    const customPackages = (await this.listCustomPackages()).filter((pkg) =>
      isCatalogPackageVisible(pkg, input.principal ?? null),
    );
    const custom = customPackages
      .filter((pkg) => source === "all" || pkg.source === source)
      .filter((pkg) => query.length === 0 || pkg.name.toLowerCase().includes(query));
    const upstreamNames =
      source === "all" || source === "upstream" ? this.listUpstreamPackageNames(query) : [];
    const totalCount = custom.length + upstreamNames.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const packages = await this.pagePackages(custom, upstreamNames, start, pageSize);
    return {
      source: this.data.source,
      sourceRepository: this.data.sourceRepository,
      sourceRef: this.data.sourceRef,
      generatedAt: this.data.generatedAt,
      packageCount: this.data.packageCount + customPackages.length,
      upstreamCount: this.data.packageCount,
      customCount: customPackages.length,
      totalCount,
      page: currentPage,
      pageSize,
      totalPages,
      hasNext: currentPage < totalPages,
      hasPrevious: currentPage > 1,
      packages,
    };
  }

  async create(data: SpackCatalogPackageInput, principal: RbacPrincipal, vendorOrgId?: string) {
    const ownerOrgId = resolveVendorOrgId(data.source, principal, vendorOrgId);
    assertCatalogWriteAllowed(data.source, principal, ownerOrgId);
    const metadata = parseOptionalPackageFile(data.packageFile);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(appTemplates)
        .values({
          name: data.name,
          version: CATALOG_VERSION,
          description: data.description ?? null,
          spec: JSON.stringify({ packageFileMetadata: metadata }),
          specKind: "spack",
          tags: customPackageTags(data, ownerOrgId),
        })
        .returning();
      if (!row) throw new AppError(ErrorCode.INTERNAL_ERROR, "Insert returned no rows", 500);
      await this.syncCustomAsset(rowToPackage(row), principal, tx);
      return rowToPackage(row);
    });
  }

  async updateById(
    id: string,
    data: SpackCatalogPackageInput,
    principal: RbacPrincipal,
    vendorOrgId?: string,
  ) {
    const existing = await this.getCustomPackage(id);
    assertCatalogWriteAllowed(
      existing.source as CustomSpackCatalogSource,
      principal,
      existing.ownerOrgId,
    );
    if (data.source !== existing.source) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Spack catalog package source cannot be changed. Create a replacement package instead.",
        409,
      );
    }
    if (vendorOrgId !== undefined && vendorOrgId !== existing.ownerOrgId) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Spack catalog package organization cannot be changed. Create a replacement package instead.",
        409,
      );
    }
    const metadata = parseOptionalPackageFile(data.packageFile) ?? existing.metadata;
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(appTemplates)
        .set({
          name: data.name,
          version: CATALOG_VERSION,
          description: data.description ?? null,
          spec: JSON.stringify({ packageFileMetadata: metadata }),
          specKind: "spack",
          tags: customPackageTags(data, existing.ownerOrgId),
          updatedAt: sql`now()`,
        })
        .where(eq(appTemplates.id, id))
        .returning();
      if (!updated) {
        throw new AppError(ErrorCode.NOT_FOUND, `Spack catalog package ${id} not found`, 404);
      }
      await this.syncCustomAsset(rowToPackage(updated), principal, tx);
      return rowToPackage(updated);
    });
  }

  async deleteById(id: string, principal: RbacPrincipal) {
    const existing = await this.getCustomPackage(id);
    assertCatalogWriteAllowed(
      existing.source as CustomSpackCatalogSource,
      principal,
      existing.ownerOrgId,
    );
    return this.db.transaction(async (tx) => {
      const [deleted] = await tx.delete(appTemplates).where(eq(appTemplates.id, id)).returning();
      if (!deleted) {
        throw new AppError(ErrorCode.NOT_FOUND, `Spack catalog package ${id} not found`, 404);
      }
      if (this.assets) {
        await this.assets
          .inTransaction(tx)
          .archiveLegacyAsset("spack-package", "legacyAppTemplateId", id, principal.sub);
      }
      return rowToPackage(deleted);
    });
  }

  private async getCustomPackage(id: string) {
    const [row] = await this.db.select().from(appTemplates).where(eq(appTemplates.id, id)).limit(1);
    if (!row || !isCatalogRow(row)) {
      throw new AppError(ErrorCode.NOT_FOUND, `Spack catalog package ${id} not found`, 404);
    }
    return rowToPackage(row);
  }

  private async listCustomPackages() {
    const rows = await this.db
      .select()
      .from(appTemplates)
      .where(eq(appTemplates.specKind, "spack"))
      .orderBy(desc(appTemplates.createdAt))
      .limit(5000);
    return rows.filter(isCatalogRow).map(rowToPackage);
  }

  private listUpstreamPackageNames(query: string): string[] {
    return this.data.packages.filter(
      (name) => query.length === 0 || name.toLowerCase().includes(query),
    );
  }

  private async pagePackages(
    custom: SpackCatalogPackage[],
    upstreamNames: string[],
    start: number,
    pageSize: number,
  ): Promise<SpackCatalogPackage[]> {
    const customPage = custom.slice(start, start + pageSize);
    const remaining = pageSize - customPage.length;
    if (remaining <= 0) return this.enrichAssets(customPage);
    const upstreamStart = Math.max(0, start - custom.length);
    return this.enrichAssets([
      ...customPage,
      ...upstreamNames.slice(upstreamStart, upstreamStart + remaining).map((name) => {
        const packageMetadata = UPSTREAM_METADATA[name];
        return {
          name,
          source: "upstream" as const,
          tags: [],
          ...(packageMetadata ? { metadata: packageMetadata } : {}),
        };
      }),
    ]);
  }

  private async enrichAssets(packages: SpackCatalogPackage[]): Promise<SpackCatalogPackage[]> {
    const enriched: SpackCatalogPackage[] = [];
    for (const pkg of packages) {
      const asset = await this.findCatalogAsset(pkg);
      enriched.push(asset ? { ...pkg, asset: rowToSummary(asset) } : pkg);
    }
    return enriched;
  }

  private async findCatalogAsset(pkg: SpackCatalogPackage) {
    if (pkg.id && this.assets) {
      const legacy = await this.assets.findByLegacyRef(
        "spack-package",
        "legacyAppTemplateId",
        pkg.id,
      );
      if (legacy) return legacy;
    }
    const source =
      pkg.source === "upstream"
        ? "official-upstream"
        : pkg.source === "official"
          ? "platform-fork"
          : "cp-private";
    const [row] = await this.db
      .select()
      .from(softwareAssets)
      .where(
        and(
          eq(softwareAssets.kind, "spack-package"),
          eq(softwareAssets.name, pkg.name),
          eq(softwareAssets.version, pkg.source === "upstream" ? "upstream" : "catalog"),
          eq(softwareAssets.source, source),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async syncCustomAsset(
    pkg: SpackCatalogPackage,
    principal: RbacPrincipal,
    tx: PgTransaction,
  ) {
    if (!this.assets || !pkg.id) return;
    const ownerOrgId = pkg.source === "vendor" ? (pkg.ownerOrgId ?? null) : null;
    const userId = uuidOrNull(principal.sub);
    const defaultSpec = pkg.name;
    await this.assets.inTransaction(tx).upsertAsset({
      kind: "spack-package",
      name: pkg.name,
      version: "catalog",
      source: pkg.source === "official" ? "platform-fork" : "cp-private",
      lifecycle: pkg.source === "official" ? "published" : "draft",
      visibility: pkg.source === "official" ? "platform-public" : "private",
      trustedForGlobalUse: pkg.source === "official",
      ownerUserId: userId,
      ownerOrgId,
      providerOrgId: ownerOrgId,
      supplierUserId: pkg.source === "vendor" ? userId : null,
      supplierOrgId: ownerOrgId,
      createdBy: userId,
      legacyRef: { field: "legacyAppTemplateId", value: pkg.id },
      payload: {
        kind: "spack-package",
        legacyAppTemplateId: pkg.id,
        spack: {
          packageName: pkg.name,
          metadata: metadataRecord(pkg.metadata),
          defaultSpec,
          dependencies: metadataStringArray(pkg.metadata?.dependencies),
          providers: metadataStringArray(pkg.metadata?.provides),
          variants: metadataVariantNames(pkg.metadata?.variants),
        },
      },
      provenance: {
        source: pkg.source === "official" ? "platform-fork" : "cp-private",
        ...(userId ? { supplierUserId: userId } : {}),
        ...(ownerOrgId ? { supplierOrgId: ownerOrgId } : {}),
      },
      grants:
        pkg.source === "official"
          ? platformPublicGrants()
          : ownerOrgId
            ? providerPrivateGrants(ownerOrgId)
            : [],
    });
  }
}

export function isCatalogPackageVisible(
  pkg: SpackCatalogPackage,
  principal: RbacPrincipal | null,
): boolean {
  if (pkg.source === "official") return true;
  if (pkg.source !== "vendor") return true;
  if (!principal) return false;
  if (principal.role === "super_admin" || principal.role === "platform_admin") return true;
  return Boolean(pkg.ownerOrgId && principal.orgIds.includes(pkg.ownerOrgId));
}

function uuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function loadUpstreamMetadata(): Record<string, SpackPackageMetadata> {
  return JSON.parse(readFileSync(METADATA_FILE, "utf8")) as Record<string, SpackPackageMetadata>;
}

function assertCatalogWriteAllowed(
  source: CustomSpackCatalogSource,
  principal: RbacPrincipal,
  ownerOrgId?: string | null,
) {
  if (
    source === "official" &&
    principal.role !== "super_admin" &&
    principal.role !== "platform_admin"
  ) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "official Spack catalog packages require platform_admin+",
      403,
    );
  }
  if (
    source === "vendor" &&
    principal.role !== "super_admin" &&
    principal.role !== "platform_admin" &&
    principal.role !== "org_admin"
  ) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "vendor Spack catalog packages require org_admin+",
      403,
    );
  }
  if (
    source === "vendor" &&
    principal.role === "org_admin" &&
    ownerOrgId &&
    !principal.orgIds.includes(ownerOrgId)
  ) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "vendor Spack catalog package belongs to another organization",
      403,
    );
  }
}

function customPackageTags(data: SpackCatalogPackageInput, ownerOrgId?: string | null): string[] {
  const tags = new Set([CATALOG_TAG, `${SOURCE_PREFIX}${data.source}`]);
  for (const tag of data.tags ?? []) {
    const trimmed = tag.trim();
    if (trimmed.length > 0 && trimmed !== CATALOG_TAG && !trimmed.startsWith(SOURCE_PREFIX)) {
      tags.add(trimmed);
    }
  }
  if (data.source === "vendor") {
    if (ownerOrgId) tags.add(`${VENDOR_ORG_PREFIX}${ownerOrgId}`);
  }
  return [...tags];
}

function resolveVendorOrgId(
  source: CustomSpackCatalogSource,
  principal: RbacPrincipal,
  orgId: string | undefined,
): string | undefined {
  if (source !== "vendor") return undefined;
  if (!orgId) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "vendor Spack catalog packages require an explicit orgId",
      422,
    );
  }
  if (
    principal.role !== "super_admin" &&
    principal.role !== "platform_admin" &&
    !principal.orgIds.includes(orgId)
  ) {
    throw new AppError(ErrorCode.FORBIDDEN, "Organization namespace is outside scope", 403);
  }
  return orgId;
}

function isCatalogRow(row: typeof appTemplates.$inferSelect): boolean {
  return row.tags.includes(CATALOG_TAG);
}

function rowToPackage(row: typeof appTemplates.$inferSelect): SpackCatalogPackage {
  const source = readSource(row.tags);
  return {
    id: row.id,
    name: row.name,
    source,
    description: row.description,
    tags: row.tags.filter(
      (tag) =>
        tag !== CATALOG_TAG && !tag.startsWith(SOURCE_PREFIX) && !tag.startsWith(VENDOR_ORG_PREFIX),
    ),
    ...(readMetadata(row.spec) ? { metadata: readMetadata(row.spec) } : {}),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    ownerOrgId: row.tags
      .find((tag) => tag.startsWith(VENDOR_ORG_PREFIX))
      ?.slice(VENDOR_ORG_PREFIX.length),
  };
}

function metadataStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function metadataVariantNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { name?: unknown }).name === "string"
      ) {
        return (item as { name: string }).name;
      }
      return null;
    })
    .filter((item): item is string => item !== null);
}

function metadataRecord(metadata: SpackPackageMetadata | undefined): Record<string, unknown> {
  return metadata ? { ...metadata } : {};
}

function readSource(tags: string[]): CustomSpackCatalogSource {
  const value = tags.find((tag) => tag.startsWith(SOURCE_PREFIX))?.slice(SOURCE_PREFIX.length);
  if (value === "official" || value === "vendor") return value;
  if (value && CATALOG_SOURCES.has(value as SpackCatalogSource)) return "official";
  return "official";
}

function parseOptionalPackageFile(source: string | undefined): SpackPackageMetadata | undefined {
  const trimmed = source?.trim();
  return trimmed ? parseSpackPackageFile(trimmed) : undefined;
}

function readMetadata(spec: string): SpackPackageMetadata | undefined {
  try {
    const parsed = JSON.parse(spec) as { packageFileMetadata?: SpackPackageMetadata };
    return parsed.packageFileMetadata;
  } catch {
    return undefined;
  }
}
