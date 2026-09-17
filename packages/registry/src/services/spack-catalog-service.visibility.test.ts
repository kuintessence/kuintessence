import { describe, expect, test } from "bun:test";
import type { RbacPrincipal } from "./namespace";
import { isCatalogPackageVisible, type SpackCatalogPackage } from "./spack-catalog-service";

const orgAdminA: RbacPrincipal = {
  sub: "org-admin-a",
  role: "org_admin",
  orgIds: ["org-a"],
};
const orgAdminB: RbacPrincipal = {
  sub: "org-admin-b",
  role: "org_admin",
  orgIds: ["org-b"],
};
const platformAdmin: RbacPrincipal = {
  sub: "platform-admin",
  role: "platform_admin",
  orgIds: [],
};

function pkg(source: SpackCatalogPackage["source"], ownerOrgId?: string): SpackCatalogPackage {
  return {
    name: `${source}-pkg`,
    source,
    tags: [],
    ...(ownerOrgId ? { ownerOrgId } : {}),
  };
}

describe("Spack catalog package visibility", () => {
  test("keeps upstream and official catalog packages public", () => {
    expect(isCatalogPackageVisible(pkg("upstream"), null)).toBe(true);
    expect(isCatalogPackageVisible(pkg("official"), null)).toBe(true);
  });

  test("scopes vendor packages to platform admins or the owning organization", () => {
    const vendor = pkg("vendor", "org-a");

    expect(isCatalogPackageVisible(vendor, null)).toBe(false);
    expect(isCatalogPackageVisible(vendor, orgAdminA)).toBe(true);
    expect(isCatalogPackageVisible(vendor, orgAdminB)).toBe(false);
    expect(isCatalogPackageVisible(vendor, platformAdmin)).toBe(true);
  });
});
