import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  type SpackMaterialLifecycle,
  type SpackMaterialLifecycleChange,
  SpackMaterialLifecycleError,
} from "@kuintessence/db";
import {
  inspectSpackLock,
  type RecipeRepository,
  RecipeRepositoryIdSchema,
  RecipeRepositoryNameSchema,
  type RegistryRole,
  RegistryRoleSchema,
  SPACK_LOCK_MAX_BYTES,
  type SpackLockReport,
  type SpackMaterialBinding,
  type SpackMaterialBlob,
  SpackMaterialBlobSchema,
  type SpackMaterialCatalogQuery,
  SpackMaterialDigestSchema,
  type SpackMaterialManifest,
  SpackMaterialManifestSchema,
  type SpackMaterialPublish,
  SpackMaterialPublishSchema,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import type { z } from "zod";
import {
  checkNamespaceAccess,
  NamespacePermissionError,
  parseNamespace,
  type RbacPrincipal,
} from "./namespace";
import { RecipeStoreError } from "./recipe-git";
import type { RecipeGitStore } from "./recipe-git-store";
import { SpackMaterialCatalogReader } from "./spack-material-catalog";
import {
  cancelMaterialInput,
  DEFAULT_MATERIAL_TIMEOUTS,
  isMissing,
  MATERIAL_MAX_BLOB_BYTES,
  MATERIAL_METADATA_BYTES,
  type MaterialMetadataReadOptions,
  materialDigest,
  readMaterialMetadata,
  SpackMaterialBlobStore,
  SpackMaterialError,
  SpackMaterialWithdrawnError,
  writeMaterialMetadata,
} from "./spack-material-storage";

export type MaterialRecipeStore = Pick<RecipeGitStore, "get" | "archive"> &
  Partial<Pick<RecipeGitStore, "getSnapshot">>;
export interface SpackMaterialRuntimePort {
  assertRuntime(): Promise<void>;
}
export type SpackMaterialLifecyclePort = Pick<
  SpackMaterialLifecycle,
  "assertAvailable" | "inspect" | "transition"
>;
export interface SpackMaterialLimits {
  maxBlobBytes: number;
  totalTimeoutMs: number;
  idleTimeoutMs: number;
}
export interface StoredSpackMaterialManifest {
  manifest: SpackMaterialManifest;
  bytes: Uint8Array;
}

export function parseMaterial<T>(schema: z.ZodType<T>, input: unknown, name: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SpackMaterialError(422, `Invalid ${name}`);
  return result.data;
}

export class SpackMaterialStore {
  readonly limits: SpackMaterialLimits;
  private readonly blobs: SpackMaterialBlobStore;
  private readonly catalog: SpackMaterialCatalogReader;
  private uploads = 0;
  private publications = 0;
  private managementReads = 0;

  constructor(
    readonly root: string,
    private readonly recipes: MaterialRecipeStore,
    limits: Partial<SpackMaterialLimits> = {},
    private readonly runtime?: SpackMaterialRuntimePort,
    private readonly lifecycle?: SpackMaterialLifecyclePort,
  ) {
    if (!isAbsolute(root)) throw new Error("SPACK_MATERIAL_STORE_DIR must be absolute");
    this.limits = {
      maxBlobBytes: MATERIAL_MAX_BLOB_BYTES,
      ...DEFAULT_MATERIAL_TIMEOUTS,
      ...limits,
    };
    if (
      Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      this.limits.maxBlobBytes > MATERIAL_MAX_BLOB_BYTES
    ) {
      throw new Error("Invalid Spack material store limits");
    }
    this.blobs = new SpackMaterialBlobStore(root);
    this.catalog = new SpackMaterialCatalogReader(root, this);
  }

  async list(query: SpackMaterialCatalogQuery, actor: RbacPrincipal, signal?: AbortSignal) {
    await this.assertRuntime();
    return this.catalog.list(query, actor, signal);
  }

  static repositoryId(repository: string): string {
    return createHash("sha256")
      .update(parseMaterial(RecipeRepositoryNameSchema, repository, "material repository"))
      .digest("hex");
  }

  async upload(
    repository: string,
    digest: string,
    input: ReadableStream<Uint8Array>,
  ): Promise<SpackMaterialBlob> {
    await this.assertRuntime(input);
    const id = SpackMaterialStore.repositoryId(repository);
    parseMaterial(SpackMaterialDigestSchema, digest, "material digest");
    const blob = await this.putBlob(input, digest);
    await this.assertRuntime(input);
    await writeMaterialMetadata(this.receiptPath(id, digest), encode(blob));
    return blob;
  }

  async publish(
    input: SpackMaterialPublish,
    actor: RbacPrincipal,
    signal?: AbortSignal,
  ): Promise<SpackMaterialBinding> {
    await this.assertRuntime();
    signal?.throwIfAborted();
    const request = this.parseRelease(input);
    const repositoryId = SpackMaterialStore.repositoryId(request.repository);
    if (this.publications >= 4) throw new SpackMaterialError(429, "Too many material publications");
    this.publications += 1;
    try {
      const report = await this.inspectReleaseLock(request, actor, signal);
      signal?.throwIfAborted();
      if (!report.valid) {
        throw new SpackMaterialError(422, "Spack lock preflight failed", report);
      }
      const recipes: SpackMaterialManifest["recipes"] = [];
      for (const selection of request.recipes) {
        signal?.throwIfAborted();
        const archive = await this.recipes.archive(selection.repositoryId, selection.commit);
        if (signal?.aborted) {
          cancelMaterialInput(archive.stream);
          signal.throwIfAborted();
        }
        const blob = await this.putBlob(archive.stream, undefined, archive.size);
        signal?.throwIfAborted();
        recipes.push({ ...selection, archive: blob });
      }
      const manifest = parseMaterial(
        SpackMaterialManifestSchema,
        { ...request, recipes },
        "material manifest",
      );
      const bytes = encode(manifest);
      const manifestDigest = materialDigest(bytes);
      await this.assertRuntime();
      await writeMaterialMetadata(this.manifestPath(repositoryId, manifestDigest), bytes, signal);
      // Re-import preserves immutable bytes and must never restore withdrawn state.
      await this.assertReleaseAvailable(repositoryId, manifestDigest);
      return { repositoryId, manifestDigest };
    } finally {
      this.publications -= 1;
    }
  }

  async preflightLock(input: SpackMaterialPublish, actor: RbacPrincipal): Promise<SpackLockReport> {
    await this.assertRuntime();
    const request = this.parseRelease(input);
    if (this.publications >= 4) throw new SpackMaterialError(429, "Too many material publications");
    this.publications += 1;
    try {
      return await this.inspectReleaseLock(request, actor);
    } finally {
      this.publications -= 1;
    }
  }

  private parseRelease(input: SpackMaterialPublish): SpackMaterialPublish {
    const request = parseMaterial(SpackMaterialPublishSchema, input, "material release");
    if (encode(request).byteLength > MATERIAL_METADATA_BYTES) {
      throw new SpackMaterialError(413, "Material metadata exceeds 2 MiB");
    }
    if (request.lockfile.size > SPACK_LOCK_MAX_BYTES) {
      throw new SpackMaterialError(413, "Spack lock exceeds 16 MiB");
    }
    return request;
  }

  private async inspectReleaseLock(
    request: SpackMaterialPublish,
    actor: RbacPrincipal,
    signal?: AbortSignal,
  ): Promise<SpackLockReport> {
    assertReadable(actor, request.repository);
    const repositoryId = SpackMaterialStore.repositoryId(request.repository);
    const references = new Map<string, SpackMaterialBlob>();
    for (const blob of [request.lockfile, ...request.sources.map((source) => source.blob)]) {
      references.set(blob.digest, blob);
    }
    for (const blob of references.values()) {
      signal?.throwIfAborted();
      await this.requireReceipt(repositoryId, blob);
    }
    // Authorize every selected recipe before returning lock diagnostics.
    for (const selection of request.recipes) {
      signal?.throwIfAborted();
      await this.checkRecipe(request.repository, selection, actor);
    }
    signal?.throwIfAborted();
    const bytes = await this.blobs.readMetadata(request.lockfile, SPACK_LOCK_MAX_BYTES);
    return inspectSpackLock(bytes, request);
  }

  async getManifest(
    id: string,
    digest: string,
    options?: MaterialMetadataReadOptions,
  ): Promise<StoredSpackMaterialManifest> {
    await this.assertRuntime();
    await this.assertReleaseAvailable(id, digest);
    return this.readManifest(id, digest, options);
  }

  private async readManifest(
    id: string,
    digest: string,
    options?: MaterialMetadataReadOptions,
  ): Promise<StoredSpackMaterialManifest> {
    const path = this.manifestPath(id, digest);
    let bytes: Buffer;
    try {
      bytes = await readMaterialMetadata(path, options);
    } catch (error) {
      if (isMissing(error)) throw new SpackMaterialError(404, "Material release not found");
      throw error;
    }
    if (materialDigest(bytes) !== digest) {
      throw new SpackMaterialError(500, "Corrupt material manifest digest");
    }
    const parsed = SpackMaterialManifestSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success || SpackMaterialStore.repositoryId(parsed.data.repository) !== id) {
      throw new SpackMaterialError(500, "Corrupt material manifest identity");
    }
    return { manifest: parsed.data, bytes: new Uint8Array(bytes) };
  }

  async manageLifecycle(
    id: string,
    digest: string,
    subject: string,
    change?: SpackMaterialLifecycleChange,
    publisherRoles?: RegistryRole[],
    signal?: AbortSignal,
  ) {
    if (!this.lifecycle || !this.recipes.getSnapshot || this.managementReads >= 2) {
      throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_UNAVAILABLE");
    }
    const binding = {
      repositoryId: parseMaterial(RecipeRepositoryIdSchema, id, "material repository id"),
      manifestDigest: parseMaterial(SpackMaterialDigestSchema, digest, "manifest digest"),
    };
    const deadline = Date.now() + 10_000;
    const checkpoint = () => {
      if (signal?.aborted || Date.now() >= deadline) {
        throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_UNAVAILABLE");
      }
    };
    this.managementReads++;
    try {
      // Immutable metadata may be loaded before taking the global DB lock. At most
      // 32 snapshots of 2 MiB each; pending disk I/O retains its admission slot.
      const { manifest } = await this.readManifest(id, digest, { checkpoint });
      const recipes = new Map<string, Awaited<ReturnType<RecipeGitStore["getSnapshot"]>>>();
      for (const selection of manifest.recipes) {
        checkpoint();
        const key = `${selection.repositoryId}/${selection.commit}`;
        if (!recipes.has(key)) {
          recipes.set(
            key,
            await this.recipes.getSnapshot(selection.repositoryId, selection.commit, checkpoint),
          );
        }
      }
      // Only in-memory policy work runs under canonical user/membership row locks.
      const authorize: Parameters<SpackMaterialLifecycle["inspect"]>[2] = async (principal) => {
        checkpoint();
        const actor = { ...principal, role: RegistryRoleSchema.parse(principal.role) };
        const namespace = parseNamespace(manifest.repository);
        checkNamespaceAccess(actor, namespace, "read", publisherRoles);
        checkNamespaceAccess(actor, namespace, "write", publisherRoles);
        for (const selection of manifest.recipes) {
          const recipe = recipes.get(`${selection.repositoryId}/${selection.commit}`);
          if (!recipe) throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_UNAVAILABLE");
          authorizeRecipe(manifest.repository, selection, actor, {
            repository: recipe.repository,
            snapshots: [recipe.snapshot],
          });
        }
        checkpoint();
      };
      checkpoint();
      const status = await (change
        ? this.lifecycle.transition(binding, subject, change, authorize)
        : this.lifecycle.inspect(binding, subject, authorize));
      return { ...status, binding, repository: manifest.repository };
    } catch (error) {
      if (error instanceof SpackMaterialLifecycleError) throw error;
      if (
        (error instanceof RecipeStoreError || error instanceof SpackMaterialError) &&
        (error.status === 403 || error.status === 404)
      ) {
        throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
      }
      throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_UNAVAILABLE");
    } finally {
      this.managementReads--;
    }
  }

  async authorizeManifest(
    manifest: SpackMaterialManifest,
    actor: RbacPrincipal,
    checkpoint?: () => void,
  ): Promise<void> {
    await this.assertRuntime();
    checkpoint?.();
    assertReadable(actor, manifest.repository);
    for (const selection of manifest.recipes) {
      await this.checkRecipe(manifest.repository, selection, actor, checkpoint);
    }
  }

  async getBlob(id: string, manifestDigest: string, digest: string, actor: RbacPrincipal) {
    await this.assertRuntime();
    parseMaterial(SpackMaterialDigestSchema, digest, "material digest");
    const { manifest } = await this.getManifest(id, manifestDigest);
    await this.authorizeManifest(manifest, actor);
    const blob = spackMaterialBlobs(manifest).find((item) => item.digest === digest);
    if (!blob) throw new SpackMaterialError(404, "Blob is not part of this release");
    return this.blobs.get(digest, blob.size);
  }

  private async assertRuntime(input?: ReadableStream<Uint8Array>): Promise<void> {
    // Fresh admission checks, not a lease or a drain of already admitted streams.
    try {
      await this.runtime?.assertRuntime();
    } catch {
      if (input) cancelMaterialInput(input);
      throw new SpackMaterialError(503, "Material repository storage is unavailable");
    }
  }

  private async assertReleaseAvailable(id: string, digest: string) {
    parseMaterial(RecipeRepositoryIdSchema, id, "material repository id");
    parseMaterial(SpackMaterialDigestSchema, digest, "manifest digest");
    try {
      await this.lifecycle?.assertAvailable({ repositoryId: id, manifestDigest: digest });
    } catch (error) {
      if (
        error instanceof SpackMaterialLifecycleError &&
        error.code === "MATERIAL_RELEASE_WITHDRAWN"
      ) {
        throw new SpackMaterialWithdrawnError();
      }
      throw new SpackMaterialError(503, "Material lifecycle is unavailable");
    }
  }

  private async checkRecipe(
    repository: string,
    selection: SpackMaterialPublish["recipes"][number],
    actor: RbacPrincipal,
    checkpoint?: () => void,
  ): Promise<RecipeRepository> {
    checkpoint?.();
    const recipe = await this.recipes.get(selection.repositoryId);
    checkpoint?.();
    authorizeRecipe(repository, selection, actor, recipe);
    return recipe;
  }

  private async putBlob(
    input: ReadableStream<Uint8Array>,
    digest?: string,
    size?: number,
  ): Promise<SpackMaterialBlob> {
    if (this.uploads >= 4 || (size !== undefined && size > this.limits.maxBlobBytes)) {
      cancelMaterialInput(input);
      throw new SpackMaterialError(
        this.uploads >= 4 ? 429 : 413,
        this.uploads >= 4 ? "Too many material uploads" : "Material exceeds the byte limit",
      );
    }
    this.uploads += 1;
    try {
      return await this.blobs.put(
        input,
        { ...this.limits, maxBytes: this.limits.maxBlobBytes },
        digest,
        size,
      );
    } finally {
      this.uploads -= 1;
      if (!input.locked) cancelMaterialInput(input);
    }
  }

  private async requireReceipt(id: string, blob: SpackMaterialBlob): Promise<void> {
    if (blob.size > this.limits.maxBlobBytes) {
      throw new SpackMaterialError(413, "Material exceeds the byte limit");
    }
    try {
      const receipt = SpackMaterialBlobSchema.parse(
        JSON.parse(
          (await readMaterialMetadata(this.receiptPath(id, blob.digest))).toString("utf8"),
        ),
      );
      if (receipt.digest !== blob.digest || receipt.size !== blob.size) {
        throw new SpackMaterialError(422, "Material receipt does not match the referenced blob");
      }
      await this.blobs.verify(blob.digest, blob.size);
    } catch (error) {
      if (isMissing(error)) {
        throw new SpackMaterialError(422, "Material blob has not been uploaded to this repository");
      }
      throw error;
    }
  }

  private receiptPath(id: string, digest: string): string {
    parseMaterial(RecipeRepositoryIdSchema, id, "material repository id");
    parseMaterial(SpackMaterialDigestSchema, digest, "material digest");
    return join(this.root, "receipts", id, `${digest.slice(7)}.json`);
  }

  private manifestPath(id: string, digest: string): string {
    parseMaterial(RecipeRepositoryIdSchema, id, "material repository id");
    parseMaterial(SpackMaterialDigestSchema, digest, "manifest digest");
    return join(this.root, "manifests", id, `${digest.slice(7)}.json`);
  }
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function authorizeRecipe(
  repository: string,
  selection: SpackMaterialPublish["recipes"][number],
  actor: RbacPrincipal,
  recipe: Pick<RecipeRepository, "repository" | "snapshots">,
) {
  assertReadable(actor, recipe.repository);
  const source = parseNamespace(recipe.repository);
  const target = parseNamespace(repository);
  if (source.kind !== "public" && (source.kind !== target.kind || source.owner !== target.owner)) {
    throw new SpackMaterialError(403, "Material release cannot broaden recipe visibility");
  }
  const snapshot = recipe.snapshots.find((item) => item.commit === selection.commit);
  if (!snapshot) throw new SpackMaterialError(404, "Recipe snapshot not found");
  if (
    snapshot.validation !== "static-only" ||
    snapshot.diagnostics.some((item) => item.severity === "error") ||
    new Set(selection.roots).size !== selection.roots.length ||
    selection.roots.some((root) => !snapshot.roots.some((item) => item.path === root))
  ) {
    throw new SpackMaterialError(422, "Recipe selection contains unverified roots or diagnostics");
  }
}

function assertReadable(actor: RbacPrincipal, repository: string): void {
  try {
    checkNamespaceAccess(actor, parseNamespace(repository), "read");
  } catch (error) {
    if (error instanceof NamespacePermissionError) {
      throw new SpackMaterialError(404, "Material release or referenced recipe not found");
    }
    throw error;
  }
}
