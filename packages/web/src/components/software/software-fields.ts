import type { SpackCatalogSourceFilter } from "../../lib/software-client";

export function parseTagInput(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function sourceLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  source: SpackCatalogSourceFilter,
): string {
  const keys: Record<SpackCatalogSourceFilter, string> = {
    all: "software.manage.sourceAll",
    upstream: "software.manage.sourceUpstream",
    official: "software.manage.sourceOfficial",
    vendor: "software.manage.sourceVendor",
  };
  return t(keys[source]);
}
