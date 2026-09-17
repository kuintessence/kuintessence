import { z } from "zod";

/**
 * Preference scope: global applies to everyone, org applies to one organization,
 * user applies to one user.
 */
export const PreferenceScopeEnum = z.enum(["global", "org", "user"]);

/**
 * Hard limits: enforced as upper bounds. Lower layers MAY tighten (reduce) but never raise.
 */
export const HardLimitsSchema = z.object({
  maxCpus: z.number().int().positive().optional(),
  maxMemoryMb: z.number().int().positive().optional(),
  maxGpus: z.number().int().nonnegative().optional(),
  maxWallTimeSec: z.number().int().positive().optional(),
});

/**
 * Site policy: lists of agent IDs that are allowed/denied.
 * Lower layers tighten (intersect allow / union deny).
 */
export const SitePolicySchema = z.object({
  allowedAgents: z.array(z.string()).optional(),
  deniedAgents: z.array(z.string()).optional(),
});

/**
 * Soft scoring weights for scheduler ranking. 0 disables a factor.
 * Lower layers OVERRIDE (no merge) — most-specific wins.
 */
export const SoftWeightsSchema = z.object({
  loadWeight: z.number().nonnegative().default(1.0),
  costWeight: z.number().nonnegative().default(1.0),
  localityWeight: z.number().nonnegative().default(1.0),
  queueWaitWeight: z.number().nonnegative().default(1.0),
});

export const PreferenceSpecSchema = z.object({
  hardLimits: HardLimitsSchema.optional(),
  sitePolicy: SitePolicySchema.optional(),
  softWeights: SoftWeightsSchema.optional(),
  /**
   * Per-cluster price (cost per CPU-hour), indexed by clusterName. Feeds the
   * cost scorer. Lower layers MERGE per-cluster (most-specific wins per key),
   * so a global rate table can be partially overridden by an org/user.
   */
  costRates: z.record(z.string(), z.number().nonnegative()).optional(),
});

export type PreferenceScope = z.infer<typeof PreferenceScopeEnum>;
export type HardLimits = z.infer<typeof HardLimitsSchema>;
export type SitePolicy = z.infer<typeof SitePolicySchema>;
export type SoftWeights = z.infer<typeof SoftWeightsSchema>;
export type PreferenceSpec = z.infer<typeof PreferenceSpecSchema>;
export type CostRates = z.infer<typeof PreferenceSpecSchema>["costRates"];
