import type { softwarePolicies, softwarePolicyOverlays } from "@kuintessence/db";
import type { InstallMode, MirrorInput, PolicyOverlayInput } from "../services/cp-console";

type OverlayRow = typeof softwarePolicyOverlays.$inferSelect;
type LegacyPolicyRow = typeof softwarePolicies.$inferSelect;
export function mergePolicyInputs(
  provider: OverlayRow | undefined,
  cluster: OverlayRow | undefined,
  agent: OverlayRow | undefined,
  legacy: LegacyPolicyRow | undefined,
): PolicyOverlayInput {
  const base = defaultPolicyInput();
  return {
    installMode: normalizeInstallMode(
      agent?.installMode ?? cluster?.installMode ?? provider?.installMode ?? base.installMode,
    ),
    allowList: uniqueSorted([
      ...(provider?.allowList ?? []),
      ...(cluster?.allowList ?? []),
      ...(legacy?.allowList ?? []),
      ...(agent?.allowList ?? []),
    ]),
    denyList: uniqueSorted([
      ...(provider?.denyList ?? []),
      ...(cluster?.denyList ?? []),
      ...(legacy?.denyList ?? []),
      ...(agent?.denyList ?? []),
    ]),
    lockEnabled:
      (provider?.lockEnabled ?? false) ||
      (cluster?.lockEnabled ?? false) ||
      (legacy?.lockEnabled ?? false) ||
      (agent?.lockEnabled ?? false),
    trustedPublicAutoInstall:
      agent?.trustedPublicAutoInstall ??
      cluster?.trustedPublicAutoInstall ??
      provider?.trustedPublicAutoInstall ??
      false,
    usecaseDefaultAllow:
      agent?.usecaseDefaultAllow ??
      cluster?.usecaseDefaultAllow ??
      provider?.usecaseDefaultAllow ??
      true,
    usecaseAllowList: uniqueSorted([
      ...(provider?.usecaseAllowList ?? []),
      ...(cluster?.usecaseAllowList ?? []),
      ...(agent?.usecaseAllowList ?? []),
    ]),
    usecaseDenyList: uniqueSorted([
      ...(provider?.usecaseDenyList ?? []),
      ...(cluster?.usecaseDenyList ?? []),
      ...(agent?.usecaseDenyList ?? []),
    ]),
    mirrors: uniqueMirrors([
      ...(agent?.mirrors ?? []),
      ...(legacy?.mirrors ?? []),
      ...(cluster?.mirrors ?? []),
      ...(provider?.mirrors ?? []),
    ]),
    preinstallList: uniqueSorted([
      ...(agent?.preinstallList ?? []),
      ...(legacy?.preinstallList ?? []),
      ...(cluster?.preinstallList ?? []),
      ...(provider?.preinstallList ?? []),
    ]),
  };
}

export function defaultPolicyInput(): PolicyOverlayInput {
  return {
    installMode: "explicit-install-grant",
    allowList: [],
    denyList: [],
    lockEnabled: false,
    trustedPublicAutoInstall: false,
    usecaseDefaultAllow: true,
    usecaseAllowList: [],
    usecaseDenyList: [],
    mirrors: [],
    preinstallList: [],
  };
}

export function normalizeInstallMode(value: string): InstallMode {
  if (
    value === "preinstalled-only" ||
    value === "trusted-public-auto-install" ||
    value === "explicit-install-grant"
  ) {
    return value;
  }
  return "explicit-install-grant";
}

export function uniqueSorted(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

export function uniqueMirrors(mirrors: MirrorInput[]): MirrorInput[] {
  const byName = new Map<string, MirrorInput>();
  for (const mirror of mirrors) {
    const name = mirror.name.trim();
    const url = mirror.url.trim();
    if (!name || !url || byName.has(name)) continue;
    byName.set(name, {
      name,
      url,
      ...(mirror.priority != null ? { priority: mirror.priority } : {}),
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
