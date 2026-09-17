export type SoftwareSection = "templates" | "usecases" | "spack" | "scripts";

export const SOFTWARE_SECTION_HASH: Record<SoftwareSection, string> = {
  templates: "workflow-templates",
  usecases: "usecases",
  spack: "spack",
  scripts: "scripts",
};

export function softwareSectionFromHash(hash: string): SoftwareSection {
  const value = hash.replace(/^#/, "").trim().toLowerCase();
  if (value === "software-usecases" || value === "usecases") return "usecases";
  if (value === "software-catalog" || value === "catalog" || value === "spack") return "spack";
  if (value === "data-processing-scripts" || value === "scripts") return "scripts";
  return "templates";
}

export function resolveSoftwareSection(pathname: string, hash: string): SoftwareSection | null {
  if (pathname === "/software" || pathname === "/software/") {
    return softwareSectionFromHash(hash);
  }
  if (pathname.startsWith("/software/workflow-templates/")) return "templates";
  if (pathname.startsWith("/software/usecases/")) return "usecases";
  if (pathname === "/software/spack" || pathname.startsWith("/software/spack/")) return "spack";
  if (pathname === "/software/scripts" || pathname.startsWith("/software/scripts/")) {
    return "scripts";
  }
  return null;
}

export function softwareCatalogDestination(section: SoftwareSection): {
  to: "/software";
  hash: string;
} {
  return { to: "/software", hash: SOFTWARE_SECTION_HASH[section] };
}
