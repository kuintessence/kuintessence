/**
 * Desensitization actions — pure functions that transform a single field value.
 *
 * minimum framework. Wired into the Server decision engine + apply
 * middleware. The actions themselves live in @kuintessence/shared so that the
 * CLI and Web SPA can also reuse them in the future without a Server roundtrip.
 *
 * Action semantics (PRD F22.14):
 *   passthrough — value unchanged
 *   hash        — SHA256(value) → first 12 hex chars (deterministic, lossy)
 *   alias       — SHA256(salt + value) → first 16 hex chars (stable, reversible
 *                  via the alias_map table; drives the F22.15 export endpoint)
 *   redact      — string → "***", any other type → "[redacted]"
 *   hide        — returns the DESENSITIZE_HIDE sentinel; the apply middleware
 *                  drops the field from the output entirely
 */
import { createHash } from "node:crypto";

/**
 * Sentinel returned by `hide` so the apply layer can detect "drop this field".
 * Using a unique symbol keeps it impossible to confuse with any user payload.
 */
export const DESENSITIZE_HIDE = Symbol("desensitize:hide");

export const DESENSITIZE_ACTIONS = ["passthrough", "hash", "alias", "redact", "hide"] as const;

export type DesensitizeAction = (typeof DESENSITIZE_ACTIONS)[number];

export function isDesensitizeAction(value: unknown): value is DesensitizeAction {
  return typeof value === "string" && (DESENSITIZE_ACTIONS as readonly string[]).includes(value);
}

/** Stable string form for hashing. Preserves type/null distinction. */
function stringify(value: unknown): string {
  if (value === null) return "\0null";
  if (value === undefined) return "\0undefined";
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${typeof value}:${String(value)}`;
  }
  try {
    return `j:${JSON.stringify(value)}`;
  } catch {
    return `j:[unserializable]`;
  }
}

export function passthrough<T>(value: T): T {
  return value;
}

/**
 * Deterministic 12-hex-char SHA256 prefix.
 *
 * Collision strategy: 12 hex = 48 bits ≈ 1 in 2.8e14 pair-collision odds. For
 * the current scope (audit-log actor, sub-org leakage masking) this is
 * acceptable. Increase prefix length if a future field expects high-cardinality
 * uniqueness. Documented as a TODO above for follow-up.
 */
export function hash(value: unknown): string {
  return createHash("sha256").update(stringify(value)).digest("hex").slice(0, 12);
}

/**
 * Salted alias — opaque but reversible via the alias_map table.
 *
 * Same `(value, salt)` ALWAYS yields the same alias, so the apply middleware
 * can de-duplicate writes to the alias_map. Salt should be a per-field or
 * per-tenant stable string.
 */
export function alias(value: unknown, salt: string): string {
  if (typeof salt !== "string" || salt.length === 0) {
    throw new Error("desensitize.alias: salt must be a non-empty string");
  }
  return createHash("sha256")
    .update(`${salt}\0${stringify(value)}`)
    .digest("hex")
    .slice(0, 16);
}

export function redact(value: unknown): string {
  return typeof value === "string" ? "***" : "[redacted]";
}

export function hide(_value: unknown): typeof DESENSITIZE_HIDE {
  return DESENSITIZE_HIDE;
}

export interface ApplyActionOptions {
  /** Required only for the `alias` action. */
  salt?: string;
}

/**
 * Apply a named action to a value. The middleware uses this for each field,
 * so the dispatcher must remain a pure function.
 */
export function applyAction(
  action: DesensitizeAction,
  value: unknown,
  opts: ApplyActionOptions = {},
): unknown {
  switch (action) {
    case "passthrough":
      return passthrough(value);
    case "hash":
      return hash(value);
    case "alias":
      return alias(value, opts.salt ?? "");
    case "redact":
      return redact(value);
    case "hide":
      return hide(value);
  }
}
