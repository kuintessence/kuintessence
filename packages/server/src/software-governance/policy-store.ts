import { createHash, randomUUID } from "node:crypto";
import { agents, type PgDb, softwarePolicies, softwarePolicyOverlays } from "@kuintessence/db";
import { and, eq, or, sql } from "drizzle-orm";

import { mergePolicyInputs } from "./effective-policy";

/**
 * software governance policy bundle as the Server stores and
 * pushes it. Mirrors the proto SoftwarePolicyUpdate field layout one-to-one,
 * minus the `policyVersion` (which the store stamps on save).
 */
export interface PolicyBundle {
  allowList: string[];
  denyList: string[];
  lockEnabled: boolean;
  mirrors: Array<{ name: string; url: string; priority?: number }>;
  preinstallList: string[];
}

/** Persisted policy row, including version + scope metadata. */
export interface StoredPolicy extends PolicyBundle {
  agentId: string;
  scope: string;
  version: string;
  updatedAt: Date;
}

export class PolicyStore {
  constructor(private readonly db: PgDb) {}

  async getForAgent(agentId: string): Promise<StoredPolicy | null> {
    const [row] = await this.db
      .select()
      .from(softwarePolicies)
      .where(and(eq(softwarePolicies.scope, "agent"), eq(softwarePolicies.agentId, agentId)))
      .limit(1);
    if (!row) return null;
    return this.rowToBundle(row);
  }

  /** Read the current provider, cluster and Agent layers in one database snapshot. */
  async effectiveForAgent(agentId: string): Promise<(PolicyBundle & { version: string }) | null> {
    const overlay = softwarePolicyOverlays;
    const rows = await this.db
      .select({ explicit: softwarePolicies, overlay })
      .from(agents)
      .leftJoin(
        softwarePolicies,
        and(eq(softwarePolicies.agentId, agents.agentId), eq(softwarePolicies.scope, "agent")),
      )
      .leftJoin(
        overlay,
        and(
          sql`${overlay.providerOrgId} is not distinct from ${agents.providerOrgId}`,
          or(
            eq(overlay.scope, "provider"),
            and(
              eq(overlay.scope, "cluster"),
              eq(overlay.clusterId, sql`coalesce(${agents.clusterId},${agents.siteName})`),
            ),
            and(eq(overlay.scope, "agent"), eq(overlay.agentId, agents.agentId)),
          ),
        ),
      )
      .where(eq(agents.agentId, agentId));
    const explicit = rows[0]?.explicit;
    const layers = rows.flatMap((row) => (row.overlay ? [row.overlay] : []));
    if (!layers.length) return explicit ? this.rowToBundle(explicit) : null;
    const layer = (scope: string) => layers.find((row) => row.scope === scope);
    const { allowList, denyList, lockEnabled, mirrors, preinstallList } = mergePolicyInputs(
      layer("provider"),
      layer("cluster"),
      layer("agent"),
      explicit ?? undefined,
    );
    const bundle = { allowList, denyList, lockEnabled, mirrors, preinstallList };
    return {
      ...bundle,
      version: createHash("sha256").update(JSON.stringify(bundle)).digest("hex"),
    };
  }

  async upsertForAgent(agentId: string, bundle: PolicyBundle): Promise<StoredPolicy> {
    const version = `v${randomUUID()}`;
    const values = {
      agentId,
      scope: "agent",
      allowList: bundle.allowList,
      denyList: bundle.denyList,
      lockEnabled: bundle.lockEnabled,
      mirrors: bundle.mirrors,
      preinstallList: bundle.preinstallList,
      version,
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .insert(softwarePolicies)
      .values(values)
      .onConflictDoUpdate({
        // Unique index on (scope, agent_id) — see schema.ts.
        target: [softwarePolicies.scope, softwarePolicies.agentId],
        set: {
          allowList: bundle.allowList,
          denyList: bundle.denyList,
          lockEnabled: bundle.lockEnabled,
          mirrors: bundle.mirrors,
          preinstallList: bundle.preinstallList,
          version,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) {
      throw new Error("upsertForAgent: returned no rows");
    }
    return this.rowToBundle(row);
  }

  async listAll(): Promise<StoredPolicy[]> {
    const rows = await this.db.select().from(softwarePolicies);
    return rows.map((r) => this.rowToBundle(r));
  }

  private rowToBundle(row: typeof softwarePolicies.$inferSelect): StoredPolicy {
    return {
      agentId: row.agentId ?? "",
      scope: row.scope,
      allowList: row.allowList,
      denyList: row.denyList,
      lockEnabled: row.lockEnabled,
      mirrors: row.mirrors,
      preinstallList: row.preinstallList,
      version: row.version,
      updatedAt: row.updatedAt,
    };
  }
}
