/**
 * desensitize config loader.
 *
 * Reads rows from `desensitize_config` and groups them into the in-memory
 * DesensitizeConfig shape consumed by the decision engine.
 *
 * Convention: `globalEnabled` is encoded as a row with
 *   `scope='global', field_path='__enabled__'` (the action is irrelevant —
 *   any non-passthrough means "the master switch is on"). This keeps a single
 *   table for all config without introducing a separate flags table.
 */
import { desensitizeConfig as cfgTable, type PgDb } from "@kuintessence/db";
import { type DesensitizeAction, isDesensitizeAction } from "@kuintessence/shared";
import type { ClusterRule, DesensitizeConfig, ProviderRule } from "./decision";

const ENABLED_SENTINEL = "__enabled__";

export async function loadDesensitizeConfig(db: PgDb): Promise<DesensitizeConfig> {
  const rows = await db.select().from(cfgTable);

  let globalEnabled = false;
  const fields: Array<{ field: string; action: DesensitizeAction }> = [];
  const providersMap = new Map<string, ProviderRule>();
  const clustersMap = new Map<string, ClusterRule>();

  for (const row of rows) {
    if (!isDesensitizeAction(row.action)) continue;

    if (row.scope === "global" && row.fieldPath === ENABLED_SENTINEL) {
      globalEnabled = true;
      continue;
    }

    if (row.scope === "global") {
      fields.push({ field: row.fieldPath, action: row.action });
      continue;
    }

    if (row.scope === "provider" && row.scopeId) {
      const id = row.scopeId;
      const existing = providersMap.get(id) ?? { providerId: id, fields: [] };
      existing.fields.push({ field: row.fieldPath, action: row.action });
      providersMap.set(id, existing);
      continue;
    }

    if (row.scope === "cluster" && row.scopeId) {
      const id = row.scopeId;
      const existing = clustersMap.get(id) ?? { clusterId: id, fields: [] };
      existing.fields.push({ field: row.fieldPath, action: row.action });
      clustersMap.set(id, existing);
    }
  }

  return {
    globalEnabled,
    fields,
    providers: Array.from(providersMap.values()),
    clusters: Array.from(clustersMap.values()),
  };
}
