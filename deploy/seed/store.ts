import { and, eq, or, sql } from "drizzle-orm";
import { createPgDb, type PgDb } from "../../packages/db/src/pg";
import {
  auditLog,
  orgs,
  userOrgMemberships,
  users,
  workflowTemplates,
} from "../../packages/db/src/pg/schema";
import {
  checkpoints,
  type SeedMode,
  type SeedOrganization,
  type SeedTemplate,
  type SeedUser,
} from "./catalog";
import type { SeedStore, SeedTransaction } from "./seed";

type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
const actor = "deployment-seed";
const action = "deployment.seed.completed";

class PgSeedTransaction implements SeedTransaction {
  constructor(private readonly tx: Transaction) {}

  async lock(): Promise<void> {
    await this.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('kuintessence:deployment-seed:v1', 0))`,
    );
  }

  async completed(mode: SeedMode): Promise<boolean> {
    const [row] = await this.tx
      .select()
      .from(auditLog)
      .where(eq(auditLog.id, checkpoints[mode]));
    if (!row) return false;
    if (row.actor !== actor || row.action !== action || row.target !== `seed:v1:${mode}`) {
      throw new Error("Seed checkpoint identity conflict");
    }
    return true;
  }

  async complete(mode: SeedMode): Promise<void> {
    await this.tx.insert(auditLog).values({
      id: checkpoints[mode],
      actor,
      action,
      target: `seed:v1:${mode}`,
    });
  }

  async organization(value: SeedOrganization): Promise<string> {
    const rows = await this.tx
      .select({ id: orgs.id })
      .from(orgs)
      .where(or(eq(orgs.id, value.id), eq(orgs.name, value.name)));
    if (rows.length > 1) throw new Error("Ambiguous seed organization");
    if (rows[0]) return rows[0].id;
    const [created] = await this.tx.insert(orgs).values(value).returning({ id: orgs.id });
    if (!created) throw new Error("Seed organization insert returned no row");
    return created.id;
  }

  async user(value: SeedUser, orgId: string): Promise<{ id: string; role: string }> {
    const rows = await this.tx
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(or(eq(users.id, value.id), eq(users.email, value.email)));
    if (rows.length > 1) throw new Error("Ambiguous seed user");
    if (rows[0]) return rows[0];
    const [created] = await this.tx
      .insert(users)
      .values({ ...value, orgId })
      .onConflictDoNothing()
      .returning({ id: users.id, role: users.role });
    if (created) return created;
    // An external login can race the seed despite its seed-specific advisory lock.
    const [existing] = await this.tx
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.email, value.email));
    if (!existing) throw new Error("Seed user identity conflict");
    return existing;
  }

  async membership(userId: string, orgId: string, role: "admin" | "member"): Promise<void> {
    await this.tx
      .insert(userOrgMemberships)
      .values({ userId, orgId, role })
      .onConflictDoNothing();
  }

  async template(value: SeedTemplate): Promise<void> {
    // Coordinate with WorkflowTemplateService's name/version lock as well.
    await this.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-template:${value.name}:${value.version}`}, 0))`,
    );
    const [existing] = await this.tx
      .select({ id: workflowTemplates.id })
      .from(workflowTemplates)
      .where(
        or(
          eq(workflowTemplates.id, value.id),
          and(
            eq(workflowTemplates.name, value.name),
            eq(workflowTemplates.version, value.version),
          ),
        ),
      )
      .limit(1);
    if (!existing) await this.tx.insert(workflowTemplates).values(value);
  }
}

export function createSeedStore(db: Pick<PgDb, "transaction">): SeedStore {
  return {
    transaction: (callback) => db.transaction((tx) => callback(new PgSeedTransaction(tx))),
  };
}

export function connectSeedStore(connectionString: string): SeedStore & {
  close(): Promise<void>;
} {
  const db = createPgDb(connectionString);
  return {
    ...createSeedStore(db),
    close: () => db.$client.end({ timeout: 5 }),
  };
}
