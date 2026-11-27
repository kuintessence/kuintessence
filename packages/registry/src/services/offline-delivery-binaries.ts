import {
  agents,
  licenseEntitlementClaims as claims,
  licensedMaterialMappings as mappings,
  type PgDb,
  softwareAssets,
} from "@kuintessence/db";
import {
  ecosystemCanonicalJson,
  type OfflineDelivery,
  type OfflineDeliveryItem,
} from "@kuintessence/shared";
import { and, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { parseNamespace, type RbacPrincipal } from "./namespace";
import { DeliveryError } from "./offline-delivery-error";
import { nativeSpackMetadataSchema, RegistryError, type RegistryService } from "./registry-service";
import { materialDigest } from "./spack-material-storage";
import type { SpackMaterialStore } from "./spack-material-store";

export type DeliveryBinary = Extract<
  OfflineDeliveryItem,
  { kind: "vendor-local" | "vendor-binary" | "buildcache" }
>;
export function isDeliveryBinary(item: OfflineDeliveryItem): item is DeliveryBinary {
  return (
    item.kind === "vendor-local" || item.kind === "vendor-binary" || item.kind === "buildcache"
  );
}

const nativeRoot = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
  hash: z.string().regex(/^[0-9a-z]{32,64}$/),
  arch: z.object({
    platform: z.string().min(1),
    platform_os: z.string().min(1),
    target: z.union([z.string().min(1), z.object({ name: z.string().min(1) })]),
  }),
});
const manifestMedia = "application/vnd.oci.image.manifest.v1+json";

export class OfflineDeliveryBinaries {
  constructor(
    private readonly db: PgDb,
    private readonly registry: RegistryService,
    private readonly materials: SpackMaterialStore,
  ) {}

  async checkDistributableFiles(digests: string[]) {
    if (!digests.length) return;
    const [restricted] = await this.db
      .select({ id: mappings.id })
      .from(mappings)
      .where(
        inArray(
          sql`regexp_replace(lower(trim(${mappings.fingerprint})), '^sha256:', '')`,
          digests.map((digest) => digest.slice(7)),
        ),
      )
      .limit(1);
    if (restricted) throw new DeliveryError("DELIVERY_PROVIDER_LOCAL_BYTES", 403);
  }

  async checkLocal(repository: string, item: Extract<DeliveryBinary, { kind: "vendor-local" }>) {
    const ns = parseNamespace(repository);
    const org = z.string().uuid().safeParse(ns.owner);
    if (ns.kind !== "org" || !org.success)
      throw new DeliveryError("DELIVERY_VENDOR_SCOPE_DENIED", 403);
    const [mapping] = await this.db
      .select({
        selector: mappings.selector,
        fingerprint: mappings.fingerprint,
        agentId: mappings.agentId,
        mappingId: mappings.id,
        version: mappings.materialVersion,
      })
      .from(mappings)
      .innerJoin(
        agents,
        and(eq(agents.agentId, mappings.agentId), eq(agents.providerOrgId, mappings.providerOrgId)),
      )
      .innerJoin(softwareAssets, eq(softwareAssets.id, mappings.assetId))
      .innerJoin(
        claims,
        and(
          eq(claims.assetId, mappings.assetId),
          eq(claims.licenseSubject, mappings.licenseSubject),
          eq(claims.claimantKind, "org"),
          eq(claims.claimantId, org.data),
          or(isNull(claims.providerOrgId), eq(claims.providerOrgId, mappings.providerOrgId)),
          eq(claims.entitlement, "provider-source-install"),
          eq(claims.status, "approved"),
          isNull(claims.revokedAt),
          or(isNull(claims.expiresAt), gt(claims.expiresAt, sql`now()`)),
        ),
      )
      .where(
        and(
          eq(mappings.id, item.mappingId),
          eq(mappings.providerOrgId, org.data),
          eq(mappings.licenseSubject, item.licenseSubject),
          eq(mappings.status, "active"),
          isNull(mappings.revokedAt),
          notInArray(softwareAssets.lifecycle, ["revoked", "archived"]),
        ),
      )
      .limit(1);
    if (
      !mapping ||
      mapping.fingerprint
        .trim()
        .toLowerCase()
        .replace(/^sha256:/, "") !== item.fingerprint.slice(7)
    )
      throw new DeliveryError("DELIVERY_VENDOR_SCOPE_DENIED", 403);
    return mapping;
  }

  async process(
    plan: OfflineDelivery,
    item: DeliveryBinary,
    actor: RbacPrincipal,
    publish: boolean,
  ) {
    if (item.kind === "vendor-local")
      return { existing: true, receipt: await this.checkLocal(plan.repository, item) };
    const descriptor = (path: string) => {
      const file = plan.files.find((entry) => entry.path === path);
      if (!file) throw new DeliveryError("DELIVERY_FILE_MISSING");
      return file.blob;
    };
    const binary = descriptor(item.kind === "buildcache" ? item.archive : item.file);
    if (publish)
      await this.checkDistributableFiles(
        item.kind === "buildcache"
          ? [binary.digest, descriptor(item.metadata).digest]
          : [binary.digest],
      );
    const openBinary = async () =>
      (await this.materials.getUploadedBlob(plan.repository, binary)).stream;
    const ns = parseNamespace(plan.repository);
    if (item.kind === "buildcache") {
      const meta = descriptor(item.metadata);
      if (meta.size > 2 * 1024 ** 2) throw new DeliveryError("DELIVERY_BUILDCACHE_METADATA_SIZE");
      const { stream } = await this.materials.getUploadedBlob(plan.repository, meta);
      const metadata = new Uint8Array(await new Response(stream).arrayBuffer());
      let native: z.infer<typeof nativeRoot>;
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(metadata),
        );
        const parsed = nativeSpackMetadataSchema.parse(value);
        if (`sha256:${parsed.binary_cache_checksum.hash}` !== binary.digest)
          throw new Error("checksum mismatch");
        native = nativeRoot.parse(parsed.spec.nodes[0]);
      } catch {
        throw new DeliveryError("DELIVERY_BUILDCACHE_SPEC_INVALID");
      }
      const spec = `${native.name}@${native.version}`;
      const target = native.arch.target;
      const arch = [
        native.arch.platform,
        native.arch.platform_os,
        typeof target === "string" ? target : target.name,
      ].join("-");
      if (spec.length > 500 || arch.length > 64)
        throw new DeliveryError("DELIVERY_BUILDCACHE_SPEC_INVALID");
      const archiveStream = await openBinary();
      try {
        return await this.registry.importSpackPair({
          ns,
          pkg: native.name,
          hash: native.hash,
          spec,
          arch,
          archive: binary,
          metadata,
          actor,
          archiveStream: publish ? archiveStream : undefined,
        });
      } finally {
        if (!archiveStream.locked) await archiveStream.cancel();
      }
    }
    const config = Buffer.from(ecosystemCanonicalJson(item.licensePolicy));
    const configDigest = materialDigest(config);
    const body = Buffer.from(
      ecosystemCanonicalJson({
        schemaVersion: 2,
        mediaType: manifestMedia,
        artifactType: "application/vnd.kq.vendor-binary.v1",
        config: {
          mediaType: "application/vnd.kq.license-policy.v1+json",
          digest: configDigest,
          size: config.length,
        },
        layers: [
          {
            mediaType: "application/octet-stream",
            ...binary,
            annotations: { "org.opencontainers.image.title": item.file },
          },
        ],
      }),
    );
    const digest = materialDigest(body);
    const receipt = { repository: plan.repository, manifestDigest: digest, file: binary };
    const repo = publish
      ? await this.registry.ensureRepository(ns, actor)
      : await this.registry.findRepository(ns);
    if (!publish) await (await openBinary()).cancel();
    if (!repo) return { existing: false, receipt };
    try {
      await this.registry.getManifestByRef(repo.id, digest);
      await this.registry.verifyRepositoryBinary(repo.id, binary);
      await this.registry.verifyRepositoryBinary(repo.id, {
        digest: configDigest,
        size: config.length,
      });
      return { existing: true, receipt };
    } catch (error) {
      if (!(error instanceof RegistryError && error.status === 404)) throw error;
    }
    if (publish) {
      for (const member of [
        { digest: configDigest, size: config.byteLength, open: async () => config },
        { digest: binary.digest, size: binary.size, open: openBinary },
      ]) {
        try {
          await this.registry.verifyRepositoryBinary(repo.id, member);
          continue;
        } catch (error) {
          if (!(error instanceof RegistryError && error.status === 404)) throw error;
        }
        const { uploadId } = await this.registry.startUpload(repo.id);
        try {
          await this.registry.completeUpload(repo.id, uploadId, member.digest, await member.open());
          await this.registry.verifyRepositoryBinary(repo.id, member);
        } catch (error) {
          await this.registry.cancelUpload(repo.id, uploadId).catch((cleanup: unknown) => {
            if (!(cleanup instanceof RegistryError && cleanup.status === 404)) throw cleanup;
          });
          throw error;
        }
      }
      await this.registry.putManifest({
        repo,
        ref: digest,
        mediaType: manifestMedia,
        body,
        principal: actor,
      });
    }
    return { existing: false, receipt };
  }
}
