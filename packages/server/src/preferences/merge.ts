import type { HardLimits, PreferenceSpec, SitePolicy, SoftWeights } from "@kuintessence/shared";

/**
 * Tightens hard limits: takes the MORE restrictive value at each field.
 * If a layer doesn't specify a limit, the previous layer's limit is preserved.
 */
function mergeHardLimits(
  base: HardLimits | undefined,
  override: HardLimits | undefined,
): HardLimits | undefined {
  if (!base) return override;
  if (!override) return base;
  const out: HardLimits = { ...base };
  for (const key of ["maxCpus", "maxMemoryMb", "maxGpus", "maxWallTimeSec"] as const) {
    const b = base[key];
    const o = override[key];
    if (o === undefined) continue;
    if (b === undefined) {
      out[key] = o;
    } else {
      // The MORE restrictive value wins (lower max = tighter)
      out[key] = Math.min(b, o);
    }
  }
  return out;
}

/**
 * Tightens site policy:
 * - allowedAgents: intersection (if base specifies whitelist, override can ONLY remove)
 * - deniedAgents: union (any deny anywhere stays denied)
 */
function mergeSitePolicy(
  base: SitePolicy | undefined,
  override: SitePolicy | undefined,
): SitePolicy | undefined {
  if (!base) return override;
  if (!override) return base;
  const out: SitePolicy = {};

  // Allow: intersection if both have allow lists; otherwise the one that exists
  if (base.allowedAgents && override.allowedAgents) {
    const set = new Set(base.allowedAgents);
    out.allowedAgents = override.allowedAgents.filter((a) => set.has(a));
  } else if (base.allowedAgents) {
    out.allowedAgents = [...base.allowedAgents];
  } else if (override.allowedAgents) {
    out.allowedAgents = [...override.allowedAgents];
  }

  // Deny: union
  const deny = new Set<string>();
  for (const a of base.deniedAgents ?? []) deny.add(a);
  for (const a of override.deniedAgents ?? []) deny.add(a);
  if (deny.size > 0) out.deniedAgents = [...deny];

  return out;
}

/**
 * Soft weights: most-specific layer overrides entirely (no merge per field).
 * If override is present at all, it replaces.
 */
function mergeSoftWeights(
  base: SoftWeights | undefined,
  override: SoftWeights | undefined,
): SoftWeights | undefined {
  return override ?? base;
}

/**
 * Cost rates merge per-cluster: most-specific layer wins for a given cluster
 * key; keys union across layers (a rate table refined by org/user).
 */
function mergeCostRates(
  base: Record<string, number> | undefined,
  override: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}

/**
 * Merge preferences from least-specific to most-specific.
 * Hard limits TIGHTEN (lower wins). Site policy TIGHTENS (allow intersect, deny union).
 * Soft weights OVERRIDE (most specific replaces). Cost rates MERGE per-cluster.
 */
export function mergePreferences(...layers: Array<PreferenceSpec | undefined>): PreferenceSpec {
  let merged: PreferenceSpec = {};
  for (const layer of layers) {
    if (!layer) continue;
    merged = {
      hardLimits: mergeHardLimits(merged.hardLimits, layer.hardLimits),
      sitePolicy: mergeSitePolicy(merged.sitePolicy, layer.sitePolicy),
      softWeights: mergeSoftWeights(merged.softWeights, layer.softWeights),
      costRates: mergeCostRates(merged.costRates, layer.costRates),
    };
  }
  return merged;
}
