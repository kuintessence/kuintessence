import type { SpackCatalogPackage } from "../../lib/software-client";

export const SPACK_CATALOG_PAGE_SIZE = 24;

export function catalogPackageKey(pkg: SpackCatalogPackage): string {
  return pkg.id ?? `catalog:${pkg.source}:${pkg.name}`;
}
