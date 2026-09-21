import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import {
  SPACK_MATERIAL_CATALOG_MAX_RELEASES,
  type SpackMaterialCatalog,
  type SpackMaterialCatalogQuery,
  SpackMaterialCatalogQuerySchema,
  type SpackMaterialManifest,
  type SpackMaterialSummary,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import {
  checkNamespaceAccess,
  NamespacePermissionError,
  parseNamespace,
  type RbacPrincipal,
} from "./namespace";
import { RecipeStoreError } from "./recipe-git";
import {
  isMissing,
  type MaterialMetadataReadOptions,
  SpackMaterialError,
} from "./spack-material-storage";
import type { StoredSpackMaterialManifest } from "./spack-material-store";

const DEFAULT_LIMITS = {
  maxEntries: 10_000,
  maxMetadataBytes: 32 * 1024 ** 2,
  maxReleases: SPACK_MATERIAL_CATALOG_MAX_RELEASES,
  maxConcurrent: 2,
  timeoutMs: 10_000,
};

interface CatalogStore {
  getManifest(
    id: string,
    digest: string,
    options?: MaterialMetadataReadOptions,
  ): Promise<StoredSpackMaterialManifest>;
  authorizeManifest(
    manifest: SpackMaterialManifest,
    actor: RbacPrincipal,
    checkpoint?: () => void,
  ): Promise<void>;
}

export class SpackMaterialCatalogLimitError extends SpackMaterialError {
  constructor() {
    super(503, "Material catalog scan limit exceeded; narrow the repository filter");
  }
}

/** Read the publication source of truth; no mutable or potentially stale secondary index. */
export class SpackMaterialCatalogReader {
  private readonly limits: typeof DEFAULT_LIMITS;
  private active = 0;

  constructor(
    private readonly root: string,
    private readonly store: CatalogStore,
    limits: Partial<typeof DEFAULT_LIMITS> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof typeof DEFAULT_LIMITS>) {
      const value = this.limits[key];
      if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[key]) {
        throw new Error("Invalid material catalog limits");
      }
    }
  }

  async list(
    query: SpackMaterialCatalogQuery,
    actor: RbacPrincipal,
    signal?: AbortSignal,
  ): Promise<SpackMaterialCatalog> {
    signal?.throwIfAborted();
    const parsed = SpackMaterialCatalogQuerySchema.safeParse(query);
    if (!parsed.success) throw new SpackMaterialError(422, "Invalid material catalog query");
    const repository = parsed.data.repository;
    if (repository && !canRead(repository, actor)) return { releases: [] };
    if (this.active >= this.limits.maxConcurrent) {
      throw new SpackMaterialError(429, "Too many material catalog scans");
    }
    this.active++;
    const deadline = Date.now() + this.limits.timeoutMs;
    let entries = 0;
    let metadataBytes = 0;
    const releases: SpackMaterialSummary[] = [];
    const checkpoint = () => {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new SpackMaterialCatalogLimitError();
    };
    const countEntry = () => {
      checkpoint();
      if (++entries > this.limits.maxEntries) throw new SpackMaterialCatalogLimitError();
    };
    const root = join(this.root, "manifests");
    const scanRepository = async (id: string, rootInfo: Stats, required: boolean) => {
      checkpoint();
      const path = join(root, id);
      const directoryInfo = await directoryIdentity(path);
      if (!directoryInfo) {
        if (required) {
          throw new SpackMaterialError(500, "Material catalog directory changed during scan");
        }
        return;
      }
      const validatePath = async () => {
        checkpoint();
        await assertDirectoryIdentity(root, rootInfo);
        await assertDirectoryIdentity(path, directoryInfo);
        checkpoint();
      };
      const checkSize = (size: number) => {
        if (size > this.limits.maxMetadataBytes - metadataBytes) {
          throw new SpackMaterialCatalogLimitError();
        }
      };
      const directory = await opendir(path);
      for await (const entry of directory) {
        countEntry();
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        if (!entry.isFile()) throw new SpackMaterialError(500, "Invalid material catalog file");
        const manifestDigest = `sha256:${entry.name.slice(0, -5)}`;
        const stored = await this.store.getManifest(id, manifestDigest, {
          checkpoint,
          checkSize,
          validatePath,
        });
        checkpoint();
        metadataBytes += stored.bytes.byteLength;
        if (metadataBytes > this.limits.maxMetadataBytes) {
          throw new SpackMaterialCatalogLimitError();
        }
        try {
          await this.store.authorizeManifest(stored.manifest, actor, checkpoint);
        } catch (error) {
          // The download policy conceals inaccessible or missing recipes with 404.
          if (
            (error instanceof SpackMaterialError || error instanceof RecipeStoreError) &&
            error.status === 404
          ) {
            checkpoint();
            continue;
          }
          throw error;
        }
        checkpoint();
        if (releases.length >= this.limits.maxReleases) {
          throw new SpackMaterialCatalogLimitError();
        }
        const manifest = stored.manifest;
        const blobs = new Map(spackMaterialBlobs(manifest).map((blob) => [blob.digest, blob.size]));
        releases.push({
          repositoryId: id,
          manifestDigest,
          repository: manifest.repository,
          spec: manifest.spec,
          spackVersion: manifest.spackVersion,
          target: manifest.target,
          redistribution: manifest.redistribution,
          sourceCount: manifest.sources.length,
          totalBytes: [...blobs.values()].reduce((sum, size) => sum + size, 0),
        });
      }
      await validatePath();
    };
    try {
      const rootInfo = await directoryIdentity(root);
      if (!rootInfo) {
        checkpoint();
        return { releases };
      }
      if (repository) {
        await scanRepository(
          createHash("sha256").update(repository).digest("hex"),
          rootInfo,
          false,
        );
      } else {
        const directory = await opendir(root);
        for await (const entry of directory) {
          countEntry();
          if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
          if (!entry.isDirectory()) {
            throw new SpackMaterialError(500, "Invalid material catalog directory");
          }
          await scanRepository(entry.name, rootInfo, true);
        }
      }
      await assertDirectoryIdentity(root, rootInfo);
      checkpoint();
      releases.sort((a, b) => {
        for (const field of ["repository", "spec", "target", "manifestDigest"] as const) {
          if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
        }
        return 0;
      });
      return { releases };
    } finally {
      // Cancellation is cooperative: pending disk/recipe I/O retains its slot until settled.
      this.active--;
    }
  }
}

function canRead(repository: string, actor: RbacPrincipal): boolean {
  try {
    checkNamespaceAccess(actor, parseNamespace(repository), "read");
    return true;
  } catch (error) {
    if (error instanceof NamespacePermissionError) return false;
    throw error;
  }
}

async function directoryIdentity(path: string): Promise<Stats | null> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) {
      throw new SpackMaterialError(500, "Invalid material catalog directory");
    }
    return info;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function assertDirectoryIdentity(path: string, expected: Stats): Promise<void> {
  const current = await directoryIdentity(path);
  if (!current || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new SpackMaterialError(500, "Material catalog directory changed during scan");
  }
}
