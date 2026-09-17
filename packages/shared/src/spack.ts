import { z } from "zod";

/**
 * Shared Spack input/output contracts between Server and Agent.
 *
 * The Agent owns the local Spack instance and reports its installed list to
 * the Server. The Server drives policy (allow/deny lists, lock state, mirror config)
 * by pushing a `SpackPolicy` to each Agent. The Agent is the policy enforcer
 * of last resort: even if the Server is unreachable, a previously cached policy
 * decides whether a `spack install` request proceeds.
 *
 * This file defines the input contract for Server software policies.
 * Keep it conservative — every field added here is also a Server commitment.
 */

/**
 * One Spack spec entry as parsed from `spack find --json`.
 *
 * Spack's JSON output is significantly richer than this; we project only the
 * fields the platform actually reasons about. Unknown fields are dropped.
 *
 * The `spec` string is the canonical `name@version[%compiler]+variant…`
 * form that user-facing UI and policy patterns match against.
 */
export const InstalledSpecSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  hash: z.string().min(1),
  compiler: z.string().optional(),
  arch: z.string().optional(),
  spec: z.string().min(1),
});
export type InstalledSpec = z.infer<typeof InstalledSpecSchema>;

/**
 * A glob pattern matched against a package name or `name@version` head.
 * Supports `*` wildcards.
 *
 * Examples:
 *   "gromacs"             — any version of gromacs
 *   "gromacs@*"           — any version of gromacs
 *   "gromacs@2024.*"      — any 2024.x release
 *   "openmpi@4.1.5"       — exact match
 *   "*@*"                 — wildcard all (legal but typically used in deny)
 */
export const SpecPatternSchema = z.string().min(1);
export type SpecPattern = z.infer<typeof SpecPatternSchema>;

/**
 * CP-driven software governance policy. See PRD F19.
 *
 * Semantics:
 *  - `lockEnabled=true`: only specs that match `allowList` may install.
 *    `denyList` still applies as an override-rejection.
 *  - `lockEnabled=false`: install is allowed unless the spec matches
 *    `denyList`, OR `allowList` is non-empty AND the spec is not in it.
 *  - Lists undefined / empty → no constraint from that side.
 */
export const SpackPolicySchema = z.object({
  lockEnabled: z.boolean().default(false),
  allowList: z.array(SpecPatternSchema).optional(),
  denyList: z.array(SpecPatternSchema).optional(),
});
export type SpackPolicy = z.infer<typeof SpackPolicySchema>;

/**
 * One Spack mirror entry as the Server pushes it to the Agent. The Agent will
 * idempotently apply `spack mirror add <name> <url>` for each new entry.
 *
 * `priority` is currently advisory; Spack itself has no priority field on
 * `mirror add`, but we retain it so Server UI can render an ordered list
 * deterministically.
 */
export const MirrorSpecSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  priority: z.number().int().nonnegative().optional(),
});
export type MirrorSpec = z.infer<typeof MirrorSpecSchema>;

/** Result of a policy decision for a single spec install request. */
export type PolicyDecision = "allow" | { reject: string };

/**
 * Reduce a Spack spec to its `name@version` head for policy matching.
 * Variants, compilers, dependency constraints, and whitespace tails are not
 * part of the CP allow/deny contract.
 */
function specHead(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  let cut = trimmed.length;
  for (const sep of [" ", "\t", "+", "~", "%", "^"]) {
    const i = trimmed.indexOf(sep);
    if (i !== -1 && i < cut) cut = i;
  }
  return trimmed.slice(0, cut);
}

function packageName(raw: string): string {
  const head = specHead(raw);
  const at = head.indexOf("@");
  return at === -1 ? head : head.slice(0, at);
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesSpecPattern(spec: string, pattern: SpecPattern): boolean {
  if (!spec || !pattern) return false;
  const head = specHead(spec);
  if (!head) return false;
  const regex = patternToRegex(pattern.trim());
  return regex.test(head) || regex.test(packageName(head));
}

function anyPatternMatch(spec: string, patterns: readonly SpecPattern[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => matchesSpecPattern(spec, pattern));
}

export function decideSpackPolicy(spec: string, policy: SpackPolicy): PolicyDecision {
  if (!spec || spec.trim().length === 0) {
    return { reject: "spec is empty" };
  }
  if (anyPatternMatch(spec, policy.denyList)) {
    return { reject: `spec '${specHead(spec)}' matches denyList` };
  }
  if (policy.lockEnabled) {
    if (!policy.allowList || policy.allowList.length === 0) {
      return { reject: "install lock enabled and no allowList configured" };
    }
    if (!anyPatternMatch(spec, policy.allowList)) {
      return { reject: `spec '${specHead(spec)}' not in allowList while lock enabled` };
    }
    return "allow";
  }
  if (policy.allowList && policy.allowList.length > 0) {
    if (!anyPatternMatch(spec, policy.allowList)) {
      return { reject: `spec '${specHead(spec)}' not in allowList` };
    }
  }
  return "allow";
}
