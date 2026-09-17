/**
 * apply middleware.
 *
 * Walks a JSON response body and replaces field values according to the
 * decision engine's per-field action. Default OFF: when
 * `config.globalEnabled === false`, the body is returned unchanged.
 *
 * Recursion contract:
 *   - object → walk each top-level key (only top-level: nested objects are
 *     left alone unless explicitly listed via dotted paths in a future
 *     extension).
 *   - array  → recursively walk each element.
 *   - primitives → returned untouched.
 *
 * Hide semantics: when an action returns the DESENSITIZE_HIDE sentinel, the
 * key is removed from the output object (not set to undefined). For arrays
 * this means hidden elements remain at their index (a future extension may
 * compact arrays — left as TODO).
 *
 * Alias semantics: when an action produces an alias, the middleware writes
 * an (alias_id, salt, original) row via the injected `recordAlias` callback
 * so the F22.15 export endpoint can resolve it later. The callback is async
 * but errors are swallowed (recording is best-effort; we never block the
 * response body on a slow DB write).
 */
import { applyAction, DESENSITIZE_HIDE, type DesensitizeAction } from "@kuintessence/shared";
import { type DesensitizeConfig, decideAction } from "../desensitize/decision";

export type RecordAliasFn = (
  aliasId: string,
  salt: string,
  originalValue: string,
) => Promise<void> | void;

export interface ApplyContext {
  /** Tag describing the resource being serialized, e.g. "audit-log-entry", "job". */
  resourceType: string;
  viewerRole: string;
  viewerOrgId: string | null;
  resourceOwnerId: string | null;
  /** Salt used by the `alias` action. Stable per-deployment for now. */
  aliasSalt: string;
  /** Persistence sink for new aliases. The route handler injects a closure that writes to PG. */
  recordAlias: RecordAliasFn;
  /** Optional placement scope hints used by the decision engine. */
  providerId?: string;
  clusterId?: string;
}

/** True for plain objects (excludes null and arrays). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Apply a single field's action and return the new value. Records alias mappings as a side effect.
 */
async function applyOne(
  action: DesensitizeAction,
  value: unknown,
  ctx: ApplyContext,
): Promise<unknown> {
  if (action === "passthrough") return value;
  const out = applyAction(action, value, { salt: ctx.aliasSalt });
  if (action === "alias" && typeof out === "string") {
    // Best-effort persistence. Errors are intentionally swallowed because a
    // failed alias write must NOT block the API response — the export
    // endpoint will simply miss this row and operators can re-run on stale.
    try {
      await ctx.recordAlias(out, ctx.aliasSalt, String(value));
    } catch {
      /* swallow */
    }
  }
  return out;
}

/**
 * Walk a single record (plain object) and apply per-field actions.
 * Returns a new object — never mutates the input.
 */
async function applyToRecord(
  config: DesensitizeConfig,
  record: Record<string, unknown>,
  ctx: ApplyContext,
): Promise<Record<string, unknown>> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const action = decideAction(config, {
      fieldPath: key,
      providerId: ctx.providerId,
      clusterId: ctx.clusterId,
    });
    const replaced = await applyOne(action, value, ctx);
    if (replaced === DESENSITIZE_HIDE) continue;
    next[key] = replaced;
  }
  return next;
}

/**
 * Top-level apply. Handles plain objects, arrays of records, the {entries:[…]}
 * envelope used by the audit-log route, and pass-through for primitives.
 */
export async function applyDesensitizationToBody<T>(
  config: DesensitizeConfig,
  body: T,
  ctx: ApplyContext,
): Promise<T> {
  if (!config.globalEnabled) return body;

  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const item of body) {
      if (isPlainObject(item)) {
        out.push(await applyToRecord(config, item, ctx));
      } else {
        out.push(item);
      }
    }
    return out as unknown as T;
  }

  if (isPlainObject(body)) {
    // The envelope shape `{entries: [...]}` is treated as a thin wrapper so
    // the audit-log route can return its native shape and still get every
    // entry walked. Other top-level keys are passed through the per-field
    // resolver as usual.
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) {
          if (isPlainObject(item)) {
            out.push(await applyToRecord(config, item, ctx));
          } else {
            out.push(item);
          }
        }
        next[key] = out;
        continue;
      }
      const action = decideAction(config, {
        fieldPath: key,
        providerId: ctx.providerId,
        clusterId: ctx.clusterId,
      });
      const replaced = await applyOne(action, value, ctx);
      if (replaced === DESENSITIZE_HIDE) continue;
      next[key] = replaced;
    }
    return next as unknown as T;
  }

  return body;
}
