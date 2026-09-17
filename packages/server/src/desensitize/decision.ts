/**
 * desensitization decision engine.
 *
 * Responsibility: given a (config, fieldPath, providerId?, clusterId?) input,
 * resolve to the single action that the apply middleware should run.
 *
 * Design:
 *
 *   Layer ladder (low → high priority): global → provider → cluster
 *   Hard-limit semantic: a higher-priority rule may only TIGHTEN. Loosening
 *   (e.g. cluster wants `passthrough` while global says `hide`) is silently
 *   discarded — see ACTION_STRICTNESS for the partial order.
 *
 *   `globalEnabled = false` short-circuits everything to `passthrough` so the
 *   default deployment posture remains "no desensitization at all". This is
 *   PRD F22.14: "全局开关默认关闭".
 *
 * Out of scope (TODO):
 *   - viewer-role-based exemption (e.g. always-passthrough for super_admin):
 *     route handlers can compose this on top by inspecting role first.
 *   - per-resource owner exemption (e.g. show your own job command unredacted).
 *     Route handlers do this by passing through to bypass for owner.
 */
import type { DesensitizeAction } from "@kuintessence/shared";
import { isDesensitizeAction } from "@kuintessence/shared";

export interface FieldRule {
  field: string;
  action: DesensitizeAction;
}

export interface ProviderRule {
  providerId: string;
  fields: FieldRule[];
}

export interface ClusterRule {
  clusterId: string;
  fields: FieldRule[];
}

export interface DesensitizeConfig {
  globalEnabled: boolean;
  providers: ProviderRule[];
  clusters: ClusterRule[];
  fields: FieldRule[];
}

export interface DecisionInput {
  fieldPath: string;
  providerId?: string;
  clusterId?: string;
}

export interface ResolveInput extends DecisionInput {
  viewerRole: string;
  viewerOrgId: string | null;
  resourceOwnerId: string | null;
}

/**
 * Strictness ladder. A higher number means the action reveals less.
 *
 *   passthrough — reveals everything
 *   hash        — reveals shape but not value (lossy)
 *   alias       — reveals nothing but is reversible by admin
 *   redact      — reveals nothing, irreversible
 *   hide        — field absent entirely
 *
 * Used to enforce the "tighten-only" invariant: when comparing parent vs
 * child rules, the framework keeps whichever is stricter.
 */
const ACTION_STRICTNESS: Record<DesensitizeAction, number> = {
  passthrough: 0,
  hash: 1,
  alias: 2,
  redact: 3,
  hide: 4,
};

function pickStricter(a: DesensitizeAction, b: DesensitizeAction): DesensitizeAction {
  return ACTION_STRICTNESS[a] >= ACTION_STRICTNESS[b] ? a : b;
}

function lookupField(rules: readonly FieldRule[], field: string): DesensitizeAction | null {
  for (const r of rules) {
    if (r.field === field && isDesensitizeAction(r.action)) {
      return r.action;
    }
  }
  return null;
}

/**
 * Resolve the per-field action under the (global, provider, cluster) ladder.
 *
 * Returns "passthrough" when:
 *   - globalEnabled is false, OR
 *   - no rule at any layer matches the fieldPath.
 */
export function decideAction(config: DesensitizeConfig, input: DecisionInput): DesensitizeAction {
  if (!config.globalEnabled) return "passthrough";

  const globalAction = lookupField(config.fields, input.fieldPath);

  let providerAction: DesensitizeAction | null = null;
  if (input.providerId) {
    const provider = config.providers.find((p) => p.providerId === input.providerId);
    if (provider) {
      providerAction = lookupField(provider.fields, input.fieldPath);
    }
  }

  let clusterAction: DesensitizeAction | null = null;
  if (input.clusterId) {
    const cluster = config.clusters.find((c) => c.clusterId === input.clusterId);
    if (cluster) {
      clusterAction = lookupField(cluster.fields, input.fieldPath);
    }
  }

  // Compose: take the strictest action seen across layers that has a rule.
  // Layers without a rule contribute nothing (NOT passthrough — otherwise
  // an empty cluster would always win as the loosest rule).
  let resolved: DesensitizeAction | null = null;
  for (const candidate of [globalAction, providerAction, clusterAction]) {
    if (candidate === null) continue;
    resolved = resolved === null ? candidate : pickStricter(resolved, candidate);
  }

  return resolved ?? "passthrough";
}

/**
 * Higher-level resolver that takes viewer context (role, org, owner) into
 * account. Viewer context flows through but does not trigger any automatic
 * exemption. Routes that want
 * "owner sees own command in cleartext" semantics call this with their own
 * pre-check before invoking the apply middleware.
 */
export function resolveActionForField(
  config: DesensitizeConfig,
  input: ResolveInput,
): DesensitizeAction {
  return decideAction(config, {
    fieldPath: input.fieldPath,
    providerId: input.providerId,
    clusterId: input.clusterId,
  });
}

/**
 * Default empty config for tests and the "off" deployment posture. Used by
 * the apply middleware as the baseline when no rules are loaded.
 */
export const DEFAULT_DESENSITIZE_CONFIG: DesensitizeConfig = {
  globalEnabled: false,
  providers: [],
  clusters: [],
  fields: [],
};
