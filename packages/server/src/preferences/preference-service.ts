import { auditLog, type PgDb, schedulingPreferences } from "@kuintessence/db";
import { type PreferenceSpec, PreferenceSpecSchema } from "@kuintessence/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { mergePreferences } from "./merge";

/**
 * Loads and merges scheduling preferences for a given (orgId, userId).
 * Layers in order: global -> org -> user. Most specific wins for soft weights;
 * hard limits and site policy tighten only.
 */
export class PreferenceService {
  constructor(private db: PgDb) {}

  async upsertGlobal(spec: PreferenceSpec, actorUserId?: string): Promise<void> {
    PreferenceSpecSchema.parse(spec);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE ${schedulingPreferences} IN EXCLUSIVE MODE`);
      const [existing] = await tx
        .select()
        .from(schedulingPreferences)
        .where(
          and(eq(schedulingPreferences.scope, "global"), isNull(schedulingPreferences.scopeId)),
        )
        .limit(1);
      const before = existing ? PreferenceSpecSchema.parse(existing.spec) : null;
      if (existing) {
        await tx
          .update(schedulingPreferences)
          .set({ spec: spec as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(schedulingPreferences.id, existing.id));
      } else {
        await tx.insert(schedulingPreferences).values({
          scope: "global",
          scopeId: null,
          name: "default",
          spec: spec as Record<string, unknown>,
        });
      }
      if (actorUserId) {
        await tx.insert(auditLog).values({
          actor: actorUserId,
          orgId: null,
          action: "preferences.global.update",
          target: "scheduling_preferences:global",
          diff: { before, after: spec },
        });
      }
    });
  }

  async upsertScoped(scope: "org" | "user", scopeId: string, spec: PreferenceSpec): Promise<void> {
    PreferenceSpecSchema.parse(spec);
    const existing = await this.db
      .select()
      .from(schedulingPreferences)
      .where(
        and(eq(schedulingPreferences.scope, scope), eq(schedulingPreferences.scopeId, scopeId)),
      )
      .limit(1);
    if (existing.length > 0 && existing[0]) {
      await this.db
        .update(schedulingPreferences)
        .set({ spec: spec as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(schedulingPreferences.id, existing[0].id));
    } else {
      await this.db.insert(schedulingPreferences).values({
        scope,
        scopeId,
        name: "default",
        spec: spec as Record<string, unknown>,
      });
    }
  }

  async loadGlobal(): Promise<PreferenceSpec | undefined> {
    const rows = await this.db
      .select()
      .from(schedulingPreferences)
      .where(and(eq(schedulingPreferences.scope, "global"), isNull(schedulingPreferences.scopeId)))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return PreferenceSpecSchema.parse(row.spec);
  }

  async loadScoped(scope: "org" | "user", scopeId: string): Promise<PreferenceSpec | undefined> {
    const rows = await this.db
      .select()
      .from(schedulingPreferences)
      .where(
        and(eq(schedulingPreferences.scope, scope), eq(schedulingPreferences.scopeId, scopeId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return PreferenceSpecSchema.parse(row.spec);
  }

  /**
   * Resolve effective preferences for a user. Layers global -> org -> user.
   */
  async resolveEffective(orgId: string | null, userId: string): Promise<PreferenceSpec> {
    const global = await this.loadGlobal();
    const org = orgId ? await this.loadScoped("org", orgId) : undefined;
    const user = await this.loadScoped("user", userId);
    return mergePreferences(global, org, user);
  }
}
