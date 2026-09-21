import {
  SPACK_LOCK_MAX_BYTES,
  type SpackMaterialPublish,
  type SpackUpstreamImport,
  type SpackUpstreamImportResult,
  SpackUpstreamImportSchema,
} from "@kuintessence/shared";
import {
  assertPublisherRole,
  checkNamespaceAccess,
  NamespacePermissionError,
  parseNamespace,
  type RbacPrincipal,
  type RegistryRole,
} from "./namespace";
import { RecipeStoreError } from "./recipe-git";
import type { RecipeGitStore } from "./recipe-git-store";
import { SpackMaterialError } from "./spack-material-storage";
import type { SpackMaterialStore } from "./spack-material-store";
import { SpackUpstreamError } from "./spack-upstream-policy";

export interface SpackUpstreamDownloadPort {
  // Implementations stage and verify all bytes before invoking consume.
  withDownload<T>(
    input: { url: string; digest: string; size: number },
    signal: AbortSignal,
    consume: (stream: ReadableStream<Uint8Array>) => Promise<T>,
  ): Promise<T>;
}

export interface SpackUpstreamImportOptions {
  downloader: SpackUpstreamDownloadPort;
  recipeStore?: Pick<RecipeGitStore, "get" | "importBundle" | "limits">;
  materialStore?: Pick<SpackMaterialStore, "upload" | "publish" | "limits">;
  publisherRoles?: RegistryRole[];
  maxConcurrentImports?: number;
  totalTimeoutMs?: number;
}

export class SpackUpstreamImportError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 408 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpackUpstreamImportError";
  }
}

export function unavailableSpackUpstreamImport(): SpackUpstreamImportError {
  return new SpackUpstreamImportError(
    503,
    "UPSTREAM_IMPORT_UNAVAILABLE",
    "Spack upstream import is not configured",
  );
}

export class SpackUpstreamImportService {
  private activeImports = 0;
  private readonly maxConcurrentImports: number;
  private readonly totalTimeoutMs: number;

  constructor(private readonly options: SpackUpstreamImportOptions) {
    this.maxConcurrentImports = options.maxConcurrentImports ?? 2;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 30 * 60_000;
    if (
      !Number.isSafeInteger(this.maxConcurrentImports) ||
      this.maxConcurrentImports < 1 ||
      this.maxConcurrentImports > 4
    ) {
      throw new Error("Invalid upstream import concurrency limit");
    }
    if (
      !Number.isSafeInteger(this.totalTimeoutMs) ||
      this.totalTimeoutMs < 1 ||
      this.totalTimeoutMs > 30 * 60_000
    ) {
      throw new Error("Invalid upstream import total timeout");
    }
  }

  async import(
    input: SpackUpstreamImport,
    actor: RbacPrincipal,
    callerSignal: AbortSignal,
  ): Promise<SpackUpstreamImportResult> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.totalTimeoutMs);
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    let finalMutationStarted = false;
    let finalMutationCompleted = false;
    let acquired = false;
    try {
      signal.throwIfAborted();
      const parsed = SpackUpstreamImportSchema.safeParse(input);
      if (!parsed.success) {
        throw new SpackMaterialError(422, "Invalid upstream import");
      }
      const request = parsed.data;
      const repository =
        request.kind === "recipe" ? request.repository : request.release.repository;
      assertPublisherRole(actor, this.options.publisherRoles);
      checkNamespaceAccess(actor, parseNamespace(repository), "read", this.options.publisherRoles);
      checkNamespaceAccess(actor, parseNamespace(repository), "write", this.options.publisherRoles);
      const recipes = this.options.recipeStore;
      const materials = this.options.materialStore;
      if (!recipes || (request.kind === "material" && !materials)) {
        throw unavailableSpackUpstreamImport();
      }
      if (this.activeImports >= this.maxConcurrentImports) {
        throw new SpackMaterialError(429, "Too many upstream imports");
      }
      this.activeImports += 1;
      acquired = true;
      if (request.kind === "recipe") {
        if (request.size > recipes.limits.maxBundleBytes) {
          throw new SpackMaterialError(413, "Recipe bundle exceeds the byte limit");
        }
        const result = await this.options.downloader.withDownload(
          { url: request.url, digest: request.digest, size: request.size },
          signal,
          async (stream) => {
            signal.throwIfAborted();
            // Staging is cancellable; a started snapshot commit must finish before cancellation.
            finalMutationStarted = true;
            const imported = await recipes.importBundle(
              request.repository,
              stream,
              actor.sub,
              signal,
            );
            finalMutationCompleted = true;
            signal.throwIfAborted();
            return imported;
          },
        );
        signal.throwIfAborted();
        return { kind: "recipe", repository: result };
      }
      if (!materials) throw unavailableSpackUpstreamImport();
      if (
        request.release.lockfile.size > SPACK_LOCK_MAX_BYTES ||
        request.files.some((file) => file.blob.size > materials.limits.maxBlobBytes)
      ) {
        throw new SpackMaterialError(413, "Material exceeds the byte limit");
      }
      await this.authorizeRecipes(request.release, actor, signal);
      for (const file of request.files) {
        signal.throwIfAborted();
        await this.options.downloader.withDownload(
          { url: file.url, ...file.blob },
          signal,
          async (stream) => {
            signal.throwIfAborted();
            const uploaded = await materials.upload(repository, file.blob.digest, stream);
            signal.throwIfAborted();
            if (uploaded.digest !== file.blob.digest || uploaded.size !== file.blob.size) {
              throw new SpackMaterialError(422, "Upstream file binding mismatch");
            }
          },
        );
        signal.throwIfAborted();
      }
      // publish revalidates receipts, bytes, recipe visibility and the actual lockfile.
      signal.throwIfAborted();
      finalMutationStarted = true;
      const binding = await materials.publish(request.release, actor, signal);
      finalMutationCompleted = true;
      signal.throwIfAborted();
      return { kind: "material", binding };
    } catch (error) {
      if (finalMutationCompleted || (signal.aborted && finalMutationStarted)) {
        throw new SpackUpstreamImportError(
          409,
          "UPSTREAM_IMPORT_RESULT_UNKNOWN",
          "Import outcome is unknown; inspect repository state before retrying",
        );
      }
      if (signal.aborted) {
        throw new SpackUpstreamImportError(
          408,
          deadline.signal.aborted ? "UPSTREAM_IMPORT_TIMEOUT" : "UPSTREAM_IMPORT_CANCELLED",
          deadline.signal.aborted
            ? "Import exceeded its total time budget; uploaded blobs may remain"
            : "Import was cancelled before final publication; uploaded blobs may remain",
        );
      }
      throw sanitizeSpackUpstreamError(error);
    } finally {
      clearTimeout(timer);
      if (acquired) this.activeImports -= 1;
    }
  }

  private async authorizeRecipes(
    release: SpackMaterialPublish,
    actor: RbacPrincipal,
    signal: AbortSignal,
  ): Promise<void> {
    const recipes = this.options.recipeStore;
    if (!recipes) throw unavailableSpackUpstreamImport();
    const target = parseNamespace(release.repository);
    for (const selection of release.recipes) {
      signal.throwIfAborted();
      const recipe = await recipes.get(selection.repositoryId);
      signal.throwIfAborted();
      try {
        checkNamespaceAccess(actor, parseNamespace(recipe.repository), "read");
      } catch (error) {
        if (!(error instanceof NamespacePermissionError)) throw error;
        throw new SpackMaterialError(404, "Referenced recipe not found");
      }
      const source = parseNamespace(recipe.repository);
      if (
        source.kind !== "public" &&
        (source.kind !== target.kind || source.owner !== target.owner)
      ) {
        throw new SpackMaterialError(403, "Cannot broaden recipe visibility");
      }
      const snapshot = recipe.snapshots.find((item) => item.commit === selection.commit);
      if (!snapshot) throw new SpackMaterialError(404, "Recipe snapshot not found");
      if (
        snapshot.validation !== "static-only" ||
        snapshot.diagnostics.some((item) => item.severity === "error") ||
        new Set(selection.roots).size !== selection.roots.length ||
        selection.roots.some((root) => !snapshot.roots.some((item) => item.path === root))
      ) {
        throw new SpackMaterialError(422, "Invalid recipe selection");
      }
    }
  }
}

export function sanitizeSpackUpstreamError(error: unknown): SpackUpstreamImportError {
  if (error instanceof SpackUpstreamImportError) return error;
  if (error instanceof SpackUpstreamError) {
    return new SpackUpstreamImportError(error.status, error.code, error.message);
  }
  if (error instanceof NamespacePermissionError) {
    return new SpackUpstreamImportError(403, "FORBIDDEN", "Upstream import is not permitted");
  }
  if (error instanceof SpackMaterialError || error instanceof RecipeStoreError) {
    const errors = {
      400: ["VALIDATION_ERROR", "Invalid upstream import body"],
      403: ["FORBIDDEN", "Upstream import is not permitted"],
      404: ["NOT_FOUND", "Referenced recipe or material not found"],
      408: ["UPLOAD_TIMEOUT", "Upstream import timed out"],
      409: ["RECIPE_CONFLICT", "Recipe repository conflict"],
      413: ["PAYLOAD_TOO_LARGE", "Upstream import exceeds the byte limit"],
      415: ["UNSUPPORTED_MEDIA_TYPE", "Expected application/json"],
      422: ["VALIDATION_ERROR", "Upstream import validation failed"],
      429: ["RATE_LIMITED", "Too many upstream imports"],
      500: ["INTERNAL_ERROR", "Upstream import storage failed"],
      503: ["UPSTREAM_IMPORT_UNAVAILABLE", "Spack upstream import is unavailable"],
    } as const;
    const [code, message] = errors[error.status];
    return new SpackUpstreamImportError(error.status, code, message);
  }
  return new SpackUpstreamImportError(
    502,
    "UPSTREAM_IMPORT_FAILED",
    "Spack upstream import failed",
  );
}
