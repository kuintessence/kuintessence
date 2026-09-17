import { agentInstalledSoftware, type PgDb } from "@kuintessence/db";
import type { InstalledSpec } from "@kuintessence/shared";
import { eq, sql } from "drizzle-orm";

export interface InstalledRow {
  agentId: string;
  name: string;
  version: string;
  hash: string;
  compiler: string | null;
  spec: string;
  reportedAt: Date;
}

/**
 * per-agent installed Spack spec ledger. Server heartbeat-ingest
 * does a delete-stale + upsert pass on every refresh so a single
 * `replaceForAgent` is enough; callers don't need to compute deltas.
 *
 * The unique index on (agent_id, hash) is the final guard. Replacement is
 * serialized per agent inside Postgres so concurrent heartbeats cannot
 * interleave delete/insert cycles for the same ledger.
 *
 * For very large installed lists this is technically an O(n) DELETE +
 * O(n) INSERT round-trip per heartbeat. The dispatcher path can swap to
 * the `installed_software_report` proto variant (which we DELIVER but
 * do not yet ROUTE here) when the per-heartbeat list grows beyond the
 * Heartbeat budget; the registry contract is identical.
 */
export class InstalledRegistry {
  constructor(private readonly db: PgDb) {}

  async listForAgent(agentId: string): Promise<InstalledRow[]> {
    const rows = await this.db
      .select()
      .from(agentInstalledSoftware)
      .where(eq(agentInstalledSoftware.agentId, agentId));
    return rows.map((r) => ({
      agentId: r.agentId,
      name: r.name,
      version: r.version,
      hash: r.hash,
      compiler: r.compiler,
      spec: r.spec,
      reportedAt: r.reportedAt,
    }));
  }

  async replaceForAgent(agentId: string, specs: InstalledSpec[]): Promise<void> {
    const uniqueSpecs = [...new Map(specs.map((s) => [s.hash, s])).values()];
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agentId}, 0))`);
      await tx.delete(agentInstalledSoftware).where(eq(agentInstalledSoftware.agentId, agentId));
      if (uniqueSpecs.length === 0) return;
      await tx.insert(agentInstalledSoftware).values(
        uniqueSpecs.map((s) => ({
          agentId,
          name: s.name,
          version: s.version,
          compiler: s.compiler ?? null,
          hash: s.hash,
          spec: s.spec,
        })),
      );
    });
  }
}
