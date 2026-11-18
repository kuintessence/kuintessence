import {
  agents,
  auditLog,
  computeCenters,
  computeClusterAgents,
  computeClusters,
  orgs,
  type PgDb,
  schedulingPreferences,
} from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  type PreferenceSpec,
  PreferenceSpecSchema,
} from "@kuintessence/shared";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { mergePreferences } from "./merge";

const CLUSTER_RATE_NAME = "cluster-cost-rates";
export const ClusterRateSpec = z.record(z.string().uuid(), z.number().nonnegative());
type ClusterRates = z.infer<typeof ClusterRateSpec>;

function rateScope(orgId: string | null) {
  return and(
    eq(schedulingPreferences.name, CLUSTER_RATE_NAME),
    orgId
      ? and(eq(schedulingPreferences.scope, "org"), eq(schedulingPreferences.scopeId, orgId))
      : and(eq(schedulingPreferences.scope, "global"), isNull(schedulingPreferences.scopeId)),
  );
}

function clusterDirectory(db: Pick<PgDb, "select">, orgId: string | null) {
  return db
    .select({
      id: computeClusters.id,
      clusterName: sql<string>`${computeClusters.metadata}->>'name'`,
      zoneName: sql<string>`${computeCenters.metadata}->>'name'`,
      organizationName: orgs.name,
    })
    .from(computeClusters)
    .innerJoin(computeCenters, eq(computeCenters.id, computeClusters.centerId))
    .innerJoin(orgs, eq(orgs.id, computeCenters.orgId))
    .where(orgId ? eq(computeCenters.orgId, orgId) : undefined)
    .orderBy(
      orgs.name,
      sql`${computeCenters.metadata}->>'name'`,
      sql`${computeClusters.metadata}->>'name'`,
      computeClusters.id,
    );
}

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
          and(
            eq(schedulingPreferences.scope, "global"),
            isNull(schedulingPreferences.scopeId),
            ne(schedulingPreferences.name, CLUSTER_RATE_NAME),
          ),
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
        and(
          eq(schedulingPreferences.scope, scope),
          eq(schedulingPreferences.scopeId, scopeId),
          ne(schedulingPreferences.name, CLUSTER_RATE_NAME),
        ),
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
      .where(
        and(
          eq(schedulingPreferences.scope, "global"),
          isNull(schedulingPreferences.scopeId),
          ne(schedulingPreferences.name, CLUSTER_RATE_NAME),
        ),
      )
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
        and(
          eq(schedulingPreferences.scope, scope),
          eq(schedulingPreferences.scopeId, scopeId),
          ne(schedulingPreferences.name, CLUSTER_RATE_NAME),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return PreferenceSpecSchema.parse(row.spec);
  }

  async readClusterRates(orgId: string | null) {
    const [clusters, [config], legacy] = await Promise.all([
      clusterDirectory(this.db, orgId),
      this.db
        .select({ spec: schedulingPreferences.spec })
        .from(schedulingPreferences)
        .where(rateScope(orgId))
        .limit(1),
      orgId ? this.loadScoped("org", orgId) : this.loadGlobal(),
    ]);
    return {
      clusters,
      rates: config ? ClusterRateSpec.parse(config.spec) : {},
      legacyRates: legacy?.costRates ?? {},
    };
  }

  async saveClusterRates(orgId: string | null, rates: ClusterRates, actor: string) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE ${schedulingPreferences} IN EXCLUSIVE MODE`);
      const ids = Object.keys(rates);
      if (ids.length) {
        const clusters = await tx
          .select({ id: computeClusters.id })
          .from(computeClusters)
          .innerJoin(computeCenters, eq(computeCenters.id, computeClusters.centerId))
          .where(
            and(
              inArray(computeClusters.id, ids),
              orgId ? eq(computeCenters.orgId, orgId) : undefined,
            ),
          )
          .for("share");
        if (clusters.length !== ids.length)
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Select clusters within the pricing scope",
            400,
          );
      }
      const [existing] = await tx
        .select()
        .from(schedulingPreferences)
        .where(rateScope(orgId))
        .limit(1);
      if (existing) {
        await tx
          .update(schedulingPreferences)
          .set({ spec: rates, updatedAt: new Date() })
          .where(eq(schedulingPreferences.id, existing.id));
      } else {
        await tx.insert(schedulingPreferences).values({
          scope: orgId ? "org" : "global",
          scopeId: orgId,
          name: CLUSTER_RATE_NAME,
          spec: rates,
        });
      }
      await tx.insert(auditLog).values({
        actor,
        orgId,
        action: "preferences.cluster_cost_rates.update",
        target: orgId ?? "global",
        diff: { before: existing?.spec ?? null, after: rates },
      });
    });
  }

  async resolveAgentCostRates(
    agentIds: string[],
    legacyRates: ClusterRates = {},
  ): Promise<Record<string, number>> {
    if (!agentIds.length) return {};
    const bound = await this.db
      .select({
        agentId: agents.agentId,
        legacyClusterId: agents.clusterId,
        legacyName: agents.siteName,
        clusterId: computeClusterAgents.clusterId,
        providerOrgId: computeCenters.orgId,
      })
      .from(agents)
      .leftJoin(computeClusterAgents, eq(agents.agentId, computeClusterAgents.agentId))
      .leftJoin(computeClusters, eq(computeClusters.id, computeClusterAgents.clusterId))
      .leftJoin(computeCenters, eq(computeCenters.id, computeClusters.centerId))
      .where(inArray(agents.agentId, agentIds));
    const providers = [
      ...new Set(bound.flatMap((row) => (row.providerOrgId ? [row.providerOrgId] : []))),
    ];
    const configs = providers.length
      ? await this.db
          .select()
          .from(schedulingPreferences)
          .where(
            and(
              eq(schedulingPreferences.name, CLUSTER_RATE_NAME),
              or(
                rateScope(null),
                and(
                  eq(schedulingPreferences.scope, "org"),
                  inArray(schedulingPreferences.scopeId, providers),
                ),
              ),
            ),
          )
      : [];
    const rates = new Map(configs.map((row) => [row.scopeId, ClusterRateSpec.parse(row.spec)]));
    const result: Array<[string, number]> = [];
    for (const row of bound) {
      const legacyKey = row.legacyClusterId ?? row.legacyName;
      const configured =
        row.clusterId && row.providerOrgId
          ? (rates.get(row.providerOrgId)?.[row.clusterId] ?? rates.get(null)?.[row.clusterId])
          : undefined;
      const rate =
        configured ?? (Object.hasOwn(legacyRates, legacyKey) ? legacyRates[legacyKey] : undefined);
      if (rate !== undefined) result.push([row.agentId, rate]);
    }
    return Object.fromEntries(result);
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
