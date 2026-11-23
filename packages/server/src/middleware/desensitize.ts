/** Apply configured field actions to a JSON response before serialization. */
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
  if (typeof v !== "object" || v === null) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
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

async function walk(
  config: DesensitizeConfig,
  value: unknown,
  ctx: ApplyContext,
  parent: string,
): Promise<unknown> {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) result.push(await walk(config, item, ctx, parent));
    return result;
  }
  if (!isPlainObject(value)) return value;
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    const fieldPath = parent ? `${parent}.${key}` : key;
    const action = decideAction(config, {
      fieldPath,
      providerId: ctx.providerId,
      clusterId: ctx.clusterId,
    });
    const replacement =
      action === "passthrough"
        ? await walk(config, item, ctx, fieldPath)
        : await applyOne(action, item, ctx);
    if (replacement !== DESENSITIZE_HIDE) entries.push([key, replacement]);
  }
  return Object.fromEntries(entries);
}

export async function applyDesensitizationToBody<T>(
  config: DesensitizeConfig,
  body: T,
  ctx: ApplyContext,
): Promise<T> {
  if (!config.globalEnabled) return body;
  return (await walk(config, body, ctx, "")) as T;
}
