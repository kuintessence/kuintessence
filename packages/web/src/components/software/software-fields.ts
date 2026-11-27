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

export function suggestNextTemplateVersion(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version.trim());
  if (!match) return "";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger) || patch >= Number.MAX_SAFE_INTEGER) {
    return "";
  }
  return `${major}.${minor}.${patch + 1}`;
}
