import { type PgDb, softwarePolicies } from "@kuintessence/db";
import { and, eq } from "drizzle-orm";

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

/**
 * CRUD for the `software_policies` table. Per-agent scope is the only
 * variant in v1; global / org scope rows are tolerated by the schema for
 * future extension but the push path treats agent scope as
 * authoritative.
 *
 * Version stamping uses millisecond-precision `Date.now()` so an
 * upsert always produces a strictly increasing version under reasonable
 * traffic. The agent uses string equality for the idempotency check so
 * "increasing" isn't a hard requirement — uniqueness per upsert is.
 */
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

  async upsertForAgent(agentId: string, bundle: PolicyBundle): Promise<StoredPolicy> {
    const version = `v${Date.now()}`;
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
