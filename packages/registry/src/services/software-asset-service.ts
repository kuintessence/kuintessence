import { createHash } from "node:crypto";
import {
  type PgDb,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import type {
  SoftwareAssetCapability,
  SoftwareAssetKind,
  SoftwareAssetLifecycle,
  SoftwareAssetPayload,
  SoftwareAssetSource,
  SoftwareAssetSummary,
  SoftwareAssetVisibility,
} from "@kuintessence/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SpackPackageMetadata } from "./spack-package-parser";

type AssetRow = typeof softwareAssets.$inferSelect;
type PgTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

export interface AssetGrantInput {
  subjectKind: "user" | "org" | "provider-org" | "platform";
  subjectId: string;
  capabilities: SoftwareAssetCapability[];
  reason?: string;
}

export interface UpsertSoftwareAssetInput {
  kind: SoftwareAssetKind;
  name: string;
  version: string;
  source: SoftwareAssetSource;
  lifecycle: SoftwareAssetLifecycle;
  visibility: SoftwareAssetVisibility;
  payload: SoftwareAssetPayload;
  provenance: Record<string, unknown>;
  trustedForGlobalUse?: boolean;
  ownerUserId?: string | null;
  ownerOrgId?: string | null;
  providerOrgId?: string | null;
  supplierUserId?: string | null;
  supplierOrgId?: string | null;
  officialForkOfAssetId?: string | null;
  createdBy?: string | null;
  legacyRef?: { field: string; value: string };
  grants?: AssetGrantInput[];
}

export interface UpstreamPackageInput {
  name: string;
  metadata?: SpackPackageMetadata;
}

export class SoftwareAssetService {
  constructor(private readonly db: PgDb | PgTransaction) {}

  inTransaction(tx: PgTransaction): SoftwareAssetService {
    return new SoftwareAssetService(tx);
  }

  async upsertAsset(input: UpsertSoftwareAssetInput): Promise<SoftwareAssetSummary> {
    const existing = await this.findExistingAsset(input);
    const payloadHash = hashJson(input.payload);
    const row = existing
      ? await this.updateAsset(existing.id, input)
      : await this.insertAsset(input);
    await this.ensureRevision(
      row.id,
      input.payload,
      input.provenance,
      payloadHash,
      input.createdBy,
    );
    await this.ensureGrants(row.id, input.grants ?? [], input.createdBy ?? null);
    return rowToSummary(row);
  }

  async archiveLegacyAsset(
    kind: SoftwareAssetKind,
    legacyField: string,
    legacyValue: string,
    actor?: string | null,
  ): Promise<void> {
    const existing = await this.findByLegacyRef(kind, legacyField, legacyValue);
    if (!existing) return;
    await this.db
      .update(softwareAssets)
      .set({
        lifecycle: "archived",
        visibility: "hidden",
        reviewState: {
          ...(existing.reviewState ?? {}),
          archivedBy: actor ?? null,
          archivedAt: new Date().toISOString(),
        },
        updatedAt: sql`now()`,
      })
      .where(eq(softwareAssets.id, existing.id));
  }

  async syncUpstreamPackages(packages: UpstreamPackageInput[], createdBy?: string | null) {
    let created = 0;
    let updated = 0;
    for (const pkg of packages) {
      const before = await this.findByIdentity({
        kind: "spack-package",
        name: pkg.name,
        version: "upstream",
        source: "official-upstream",
      });
      await this.upsertAsset({
        kind: "spack-package",
        name: pkg.name,
        version: "upstream",
        source: "official-upstream",
        lifecycle: "published",
        visibility: "platform-public",
        trustedForGlobalUse: true,
        payload: {
          kind: "spack-package",
          spack: {
            packageName: pkg.name,
            metadata: metadataRecord(pkg.metadata),
            defaultSpec: pkg.name,
            dependencies: metadataStringArray(pkg.metadata?.dependencies),
            providers: metadataStringArray(pkg.metadata?.provides),
            variants: metadataVariantNames(pkg.metadata?.variants),
          },
        },
        provenance: {
          source: "official-upstream",
          upstreamName: pkg.name,
          upstreamRef: "spack/spack-packages@develop",
        },
        createdBy,
        grants: platformPublicGrants(),
      });
      if (before) {
        updated += 1;
      } else {
        created += 1;
      }
    }
    return { created, updated, total: packages.length };
  }

  async findByLegacyRef(kind: SoftwareAssetKind, field: string, value: string) {
    const [row] = await this.db
      .select()
      .from(softwareAssets)
      .where(
        and(eq(softwareAssets.kind, kind), sql`${softwareAssets.payload}->>${field} = ${value}`),
      )
      .limit(1);
    return row ?? null;
  }

  private async findExistingAsset(input: UpsertSoftwareAssetInput): Promise<AssetRow | null> {
    if (input.legacyRef) {
      const byLegacy = await this.findByLegacyRef(
        input.kind,
        input.legacyRef.field,
        input.legacyRef.value,
      );
      if (byLegacy) return byLegacy;
    }
    return this.findByIdentity(input);
  }

  private async findByIdentity(input: {
    kind: SoftwareAssetKind;
    name: string;
    version: string;
    source: SoftwareAssetSource;
    ownerOrgId?: string | null;
    providerOrgId?: string | null;
  }): Promise<AssetRow | null> {
    const conditions = [
      eq(softwareAssets.kind, input.kind),
      eq(softwareAssets.name, input.name),
      eq(softwareAssets.version, input.version),
      eq(softwareAssets.source, input.source),
    ];
    if (input.ownerOrgId !== undefined) {
      conditions.push(sql`${softwareAssets.ownerOrgId} IS NOT DISTINCT FROM ${input.ownerOrgId}`);
    }
    if (input.providerOrgId !== undefined) {
      conditions.push(
        sql`${softwareAssets.providerOrgId} IS NOT DISTINCT FROM ${input.providerOrgId}`,
      );
    }
    const [row] = await this.db
      .select()
      .from(softwareAssets)
      .where(and(...conditions))
      .limit(1);
    return row ?? null;
  }

  private async insertAsset(input: UpsertSoftwareAssetInput): Promise<AssetRow> {
    const [row] = await this.db
      .insert(softwareAssets)
      .values({
        kind: input.kind,
        name: input.name,
        version: input.version,
        source: input.source,
        lifecycle: input.lifecycle,
        visibility: input.visibility,
        ownerUserId: input.ownerUserId ?? null,
        ownerOrgId: input.ownerOrgId ?? null,
        providerOrgId: input.providerOrgId ?? null,
        supplierUserId: input.supplierUserId ?? null,
        supplierOrgId: input.supplierOrgId ?? null,
        officialForkOfAssetId: input.officialForkOfAssetId ?? null,
        payload: input.payload,
        provenance: input.provenance,
        trustedForGlobalUse: input.trustedForGlobalUse ?? false,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    if (!row) throw new Error("software asset insert returned no row");
    return row;
  }

  private async updateAsset(id: string, input: UpsertSoftwareAssetInput): Promise<AssetRow> {
    const [row] = await this.db
      .update(softwareAssets)
      .set({
        name: input.name,
        version: input.version,
        source: input.source,
        lifecycle: input.lifecycle,
        visibility: input.visibility,
        ownerUserId: input.ownerUserId ?? null,
        ownerOrgId: input.ownerOrgId ?? null,
        providerOrgId: input.providerOrgId ?? null,
        supplierUserId: input.supplierUserId ?? null,
        supplierOrgId: input.supplierOrgId ?? null,
        officialForkOfAssetId: input.officialForkOfAssetId ?? null,
        payload: input.payload,
        provenance: input.provenance,
        trustedForGlobalUse: input.trustedForGlobalUse ?? false,
        updatedAt: sql`now()`,
      })
      .where(eq(softwareAssets.id, id))
      .returning();
    if (!row) throw new Error(`software asset ${id} disappeared during update`);
    return row;
  }

  private async ensureRevision(
    assetId: string,
    payload: SoftwareAssetPayload,
    provenance: Record<string, unknown>,
    payloadHash: string,
    createdBy?: string | null,
  ): Promise<void> {
    const [latest] = await this.db
      .select()
      .from(softwareAssetRevisions)
      .where(eq(softwareAssetRevisions.assetId, assetId))
      .orderBy(desc(softwareAssetRevisions.revision))
      .limit(1);
    if (latest?.recipeSha256 === payloadHash) return;
    await this.db.insert(softwareAssetRevisions).values({
      assetId,
      revision: (latest?.revision ?? 0) + 1,
      payload,
      provenance,
      recipeSha256: payloadHash,
      createdBy: createdBy ?? null,
    });
  }

  private async ensureGrants(
    assetId: string,
    grants: AssetGrantInput[],
    createdBy: string | null,
  ): Promise<void> {
    for (const grant of grants) {
      await this.db
        .insert(softwareAssetGrants)
        .values({
          assetId,
          subjectKind: grant.subjectKind,
          subjectId: grant.subjectId,
          capabilities: [...new Set(grant.capabilities)].sort(),
          reason: grant.reason ?? null,
          createdBy,
        })
        .onConflictDoUpdate({
          target: [
            softwareAssetGrants.assetId,
            softwareAssetGrants.subjectKind,
            softwareAssetGrants.subjectId,
          ],
          set: {
            capabilities: [...new Set(grant.capabilities)].sort(),
            reason: grant.reason ?? null,
          },
        });
    }
  }
}

export function platformPublicGrants(): AssetGrantInput[] {
  return [
    {
      subjectKind: "platform",
      subjectId: "platform",
      capabilities: ["view", "use", "install"],
      reason: "platform-public software asset",
    },
  ];
}

export function providerPrivateGrants(providerOrgId: string): AssetGrantInput[] {
  return [
    {
      subjectKind: "provider-org",
      subjectId: providerOrgId,
      capabilities: ["view", "use", "install", "edit"],
      reason: "provider-owned private software asset",
    },
  ];
}

export function rowToSummary(row: AssetRow): SoftwareAssetSummary {
  return {
    id: row.id,
    kind: row.kind as SoftwareAssetKind,
    name: row.name,
    version: row.version,
    source: row.source as SoftwareAssetSource,
    lifecycle: row.lifecycle as SoftwareAssetLifecycle,
    visibility: row.visibility as SoftwareAssetVisibility,
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    providerOrgId: row.providerOrgId,
    supplierUserId: row.supplierUserId,
    supplierOrgId: row.supplierOrgId,
    officialForkOfAssetId: row.officialForkOfAssetId,
    trustedForGlobalUse: row.trustedForGlobalUse,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
