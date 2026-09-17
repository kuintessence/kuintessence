import { type ResolvedPackage, usecase } from "@kuintessence/shared";
import { parse } from "yaml";

/**
 * Server-free package source for the embedded workflow runner. Mirrors the
 * Server's `PackageStore` + `createPackageResolver` (db-package-store) but backed
 * by an in-memory catalog loaded from a local YAML file instead of Postgres.
 *
 * The catalog maps `usecaseVersionId` → a stored package spec validated by the
 * SAME `usecase.UsecasePackageSchema` the Server uses, so local and Server catalogs
 * are interchangeable. A parsed package is structurally a {@link ResolvedPackage}
 * and feeds `createUsecaseExecutor` directly — single executor implementation.
 */
export class LocalPackageStore {
  private constructor(private readonly packages: Map<string, ResolvedPackage>) {}

  /** Validate a catalog of `usecaseVersionId` → package spec via the shared schema. */
  static fromEntries(entries: Record<string, unknown>): LocalPackageStore {
    const packages = new Map<string, ResolvedPackage>();
    for (const [id, spec] of Object.entries(entries)) {
      packages.set(id, usecase.UsecasePackageSchema.parse(spec));
    }
    return new LocalPackageStore(packages);
  }

  /** Parse a YAML catalog (top-level map of `usecaseVersionId` → package spec). */
  static fromYaml(text: string): LocalPackageStore {
    const parsed: unknown = parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("local package catalog must be a map of usecaseVersionId -> package spec");
    }
    return LocalPackageStore.fromEntries(parsed as Record<string, unknown>);
  }

  /** Resolve a node's usecase package; matches `UsecaseExecutorDeps.resolvePackage`. */
  async resolvePackage(
    usecaseVersionId: string,
    _softwareVersionId: string,
  ): Promise<ResolvedPackage> {
    const pkg = this.packages.get(usecaseVersionId);
    if (!pkg) {
      throw new Error(`no local package for usecase ${usecaseVersionId}`);
    }
    return pkg;
  }
}
