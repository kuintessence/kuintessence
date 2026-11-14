import {
  BriefcaseBusiness,
  ClipboardList,
  FileCheck2,
  FolderSync,
  Handshake,
  Package,
  Scale,
  Truck,
} from "lucide-react";

export const FEDERATION_SECTIONS = [
  { id: "tasks", labelKey: "federation.tasks.title", icon: ClipboardList },
  { id: "market", labelKey: "federation.market.title", icon: BriefcaseBusiness },
  { id: "agreements", labelKey: "federation.agreements.agreements", icon: Handshake },
  { id: "assets", labelKey: "federation.assets.title", icon: FolderSync },
  { id: "commercial", labelKey: "federation.commercial.title", icon: Scale },
  { id: "delivery", labelKey: "federation.delivery.title", icon: Package },
  { id: "cases", labelKey: "federation.evidence.title", icon: FileCheck2 },
  { id: "logistics", labelKey: "federation.logistics.title", icon: Truck },
] as const;

export type FederationSection = (typeof FEDERATION_SECTIONS)[number]["id"];

export function resolveFederationSection(hash: string, mediaExport = false): FederationSection {
  const value = hash.replace(/^#/, "");
  const section = FEDERATION_SECTIONS.find((item) => item.id === value);
  return section?.id ?? (mediaExport ? "delivery" : "agreements");
}

export function isFederationSettings(hash: string): boolean {
  return /^#?security\/federation-(permissions|trust|storage)$/.test(hash);
}
