import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { SpackMaterialCatalogState } from "@kuintessence/db";
import {
  type SpackMaterialManagementCatalog,
  type SpackMaterialManagementQuery,
  SpackMaterialManagementQuerySchema,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import { managementCursor } from "./spack-material-management-cursor";
import {
  isMissing,
  type MaterialMetadataReadOptions,
  SpackMaterialError,
} from "./spack-material-storage";
import type { StoredSpackMaterialManifest } from "./spack-material-store";

const DEFAULT_LIMITS = {
  maxEntries: 10_000,
  maxMetadataBytes: 32 * 1024 ** 2,
  maxConcurrent: 2,
  timeoutMs: 10_000,
};

export class SpackMaterialManagementLimitError extends SpackMaterialError {
  constructor() {
    super(503, "Material management scan limit exceeded; reduce the page size");
  }
}

export interface SpackMaterialManagementReaderPort {
  cursorSecret: string;
  subject: string;
  authorize(checkpoint: () => void): Promise<void>;
  read(
    id: string,
    digest: string,
    options: MaterialMetadataReadOptions,
  ): Promise<StoredSpackMaterialManifest>;
  inspect(
    releases: StoredSpackMaterialManifest[],
    checkpoint: () => void,
  ): Promise<SpackMaterialCatalogState[]>;
}

/** Cursor advances over candidates, including filtered entries; it is not a snapshot lease. */
export class SpackMaterialManagementCatalogReader {
  private active = 0;
  private readonly limits: typeof DEFAULT_LIMITS;

  constructor(
    private readonly root: string,
    limits: Partial<typeof DEFAULT_LIMITS> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof typeof DEFAULT_LIMITS>) {
      const value = this.limits[key];
      if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[key]) {
        throw new Error("Invalid material management limits");
      }
    }
  }

  async list(
    input: SpackMaterialManagementQuery,
    port: SpackMaterialManagementReaderPort,
    signal?: AbortSignal,
  ): Promise<SpackMaterialManagementCatalog> {
    signal?.throwIfAborted();
    const parsed = SpackMaterialManagementQuerySchema.safeParse(input);
    if (!parsed.success) throw new SpackMaterialError(422, "Invalid management catalog query");
    const query = parsed.data;
    if (this.active >= this.limits.maxConcurrent) {
      throw new SpackMaterialError(429, "Too many material management scans");
    }
    this.active++;
    const deadline = Date.now() + this.limits.timeoutMs;
    const checkpoint = () => {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new SpackMaterialManagementLimitError();
    };
    try {
      checkpoint();
      await port.authorize(checkpoint);
      checkpoint();
      const cursor = managementCursor(port.cursorSecret, port.subject, query);
      const after = query.after === undefined ? undefined : cursor.decode(query.after);
      const repositoryId = createHash("sha256").update(query.repository).digest("hex");
      const root = join(this.root, "manifests");
      const rootInfo = await directoryIdentity(root);
      const directory = join(root, repositoryId);
      const info = rootInfo ? await directoryIdentity(directory) : null;
      const validatePath = async () => {
        checkpoint();
        await assertDirectoryIdentity(root, rootInfo);
        if (rootInfo) await assertDirectoryIdentity(directory, info);
        checkpoint();
      };
      const digests: string[] = [];
      if (info) {
        const entries = await opendir(directory);
        let count = 0;
        for await (const entry of entries) {
          checkpoint();
          if (++count > this.limits.maxEntries) throw new SpackMaterialManagementLimitError();
          if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
          if (!entry.isFile()) throw new SpackMaterialError(500, "Invalid management catalog file");
          const digest = `sha256:${entry.name.slice(0, -5)}`;
          if (after === undefined || digest > after) digests.push(digest);
        }
      }
      digests.sort();
      const candidates = digests.slice(0, query.limit);
      const stored: StoredSpackMaterialManifest[] = [];
      let metadataBytes = 0;
      for (const digest of candidates) {
        checkpoint();
        const release = await port.read(repositoryId, digest, {
          checkpoint,
          validatePath,
          checkSize: (size) => {
            if (size > this.limits.maxMetadataBytes - metadataBytes) {
              throw new SpackMaterialManagementLimitError();
            }
          },
        });
        metadataBytes += release.bytes.byteLength;
        if (metadataBytes > this.limits.maxMetadataBytes) {
          throw new SpackMaterialManagementLimitError();
        }
        if (release.manifest.repository !== query.repository) {
          throw new SpackMaterialError(500, "Invalid management catalog repository");
        }
        stored.push(release);
      }
      checkpoint();
      const states = await port.inspect(stored, checkpoint);
      await validatePath();
      const releases: SpackMaterialManagementCatalog["releases"] = [];
      for (const [index, release] of stored.entries()) {
        const digest = candidates[index];
        const state = states.find(
          (value) => value.repositoryId === repositoryId && value.manifestDigest === digest,
        );
        if (!state || (query.state !== "all" && query.state !== state.state)) continue;
        const manifest = release.manifest;
        const blobs = new Map(spackMaterialBlobs(manifest).map((blob) => [blob.digest, blob.size]));
        releases.push({
          ...state,
          repository: manifest.repository,
          spec: manifest.spec,
          spackVersion: manifest.spackVersion,
          target: manifest.target,
          redistribution: manifest.redistribution,
          sourceCount: manifest.sources.length,
          totalBytes: [...blobs.values()].reduce((sum, value) => sum + value, 0),
        });
      }
      checkpoint();
      const last = candidates.at(-1);
      return {
        releases,
        nextCursor: digests.length > query.limit && last ? cursor.encode(last) : null,
      };
    } finally {
      this.active--;
    }
  }
}

async function directoryIdentity(path: string): Promise<Stats | null> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new SpackMaterialError(500, "Invalid management directory");
    return info;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function assertDirectoryIdentity(path: string, expected: Stats | null) {
  const current = await directoryIdentity(path);
  if (
    (current === null) !== (expected === null) ||
    (current && expected && (current.dev !== expected.dev || current.ino !== expected.ino))
  ) {
    throw new SpackMaterialError(500, "Management catalog directory changed during scan");
  }
}
