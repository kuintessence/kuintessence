import {
  auditLog,
  federationCompletionClaims as claims,
  type PgDb,
  type PgTransaction,
  federationCompletionPools as pools,
} from "@kuintessence/db";
import {
  type FederationDelegation,
  FederationDelegationSchema,
  FederationError,
} from "@kuintessence/shared/federation";
import type { MarketProposalInput } from "@kuintessence/shared/federation/market";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import type { FederationStorageGuard } from "./storage-capacity";

type Guard = Pick<FederationStorageGuard, "assertAdmission"> &
  Partial<Pick<FederationStorageGuard, "inspect">>;
const Bytes = z.string().regex(/^[1-9][0-9]{0,29}$/);
export const CompletionPoolInput = z
  .strictObject({
    reserveId: z.uuid(),
    capacityBytes: Bytes,
    taskBytes: Bytes,
    marketBytes: Bytes,
  })
  .refine(
    (v) =>
      BigInt(v.taskBytes) <= BigInt(v.capacityBytes) &&
      BigInt(v.marketBytes) <= BigInt(v.capacityBytes),
  );
type Pool = typeof pools.$inferSelect;
type Intent = Pick<typeof claims.$inferInsert, "kind" | "intentId" | "digest">;

// Do not wait while holding agreement/workflow locks: other acceptance paths take them in different orders.
async function lock(tx: PgTransaction, siteId: string, shared = false) {
  const [row] = await tx.execute<{ acquired: boolean }>(sql`
    SELECT ${shared ? sql`pg_try_advisory_xact_lock_shared` : sql`pg_try_advisory_xact_lock`}(hashtextextended(${`federation-completion:${siteId}`}, 0)) AS acquired
  `);
  if (!row?.acquired) throw new FederationError("STORAGE_PRESSURE");
}

async function readPool(tx: PgDb | PgTransaction, siteId: string) {
  const [pool] = await tx.select().from(pools).where(eq(pools.localSiteId, siteId));
  return pool;
}

async function usage(tx: PgDb | PgTransaction, siteId: string) {
  const [row] = await tx
    .select({
      allocatedBytes: sql<string>`coalesce(sum(${claims.allocatedBytes}), 0)::text`,
      obligations: sql<number>`count(*)::integer`,
    })
    .from(claims)
    .where(eq(claims.localSiteId, siteId));
  if (!row) throw new Error("Missing completion allocation aggregate");
  return row;
}

async function backing(pool: Pick<Pool, "reserveId" | "capacityBytes">, guard?: Guard) {
  const volumes = await guard?.inspect?.();
  if (
    !volumes?.some(
      (v) =>
        v.component === "postgres-data" &&
        v.state === "healthy" &&
        "completionReserve" in v &&
        v.completionReserve?.reserveId === pool.reserveId &&
        v.completionReserve.state === "armed" &&
        v.completionReserve.allocatedBytes !== null &&
        BigInt(v.completionReserve.allocatedBytes) >= BigInt(pool.capacityBytes),
    )
  )
    throw new FederationError("STORAGE_PRESSURE");
}

function taskIntent(request: FederationDelegation): Intent {
  return {
    kind: "task",
    intentId: `${request.agreementRevisionId}:${request.taskId}:${request.attempt}`,
    digest: federationMaterialDigest(request),
  };
}

async function hasClaim(tx: PgTransaction, siteId: string, intent: Intent) {
  const [prior] = await tx
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.localSiteId, siteId),
        eq(claims.kind, intent.kind),
        eq(claims.intentId, intent.intentId),
      ),
    );
  if (prior && prior.digest !== intent.digest) throw new FederationError("OPERATION_CONFLICT");
  return !!prior;
}

async function insert(tx: PgTransaction, pool: Pool, intent: Intent) {
  if (await hasClaim(tx, pool.localSiteId, intent)) return;
  await tx.insert(claims).values({
    ...intent,
    localSiteId: pool.localSiteId,
    allocatedBytes: intent.kind === "task" ? pool.taskBytes : pool.marketBytes,
  });
}

async function allocate(tx: PgTransaction, siteId: string, intent: Intent, guard?: Guard) {
  // Accepted work does not compete with new admissions for the pool lock.
  if (await hasClaim(tx, siteId, intent)) return;
  let pool = await readPool(tx, siteId);
  if (!pool) {
    // Concurrent legacy admissions coexist, but enabling a policy cannot miss their commits.
    await lock(tx, siteId, true);
    pool = await readPool(tx, siteId);
    if (!pool) return;
  }
  await lock(tx, siteId);
  pool = await readPool(tx, siteId);
  if (!pool) throw new FederationError("STORAGE_PRESSURE");
  if (await hasClaim(tx, siteId, intent)) return;
  await backing(pool, guard);
  const held = await usage(tx, siteId);
  const amount = intent.kind === "task" ? pool.taskBytes : pool.marketBytes;
  if (BigInt(held.allocatedBytes) + BigInt(amount) > BigInt(pool.capacityBytes))
    throw new FederationError("STORAGE_PRESSURE");
  await insert(tx, pool, intent);
}

/** This does not authorize execution; callers must validate the durable business intent themselves. */
export async function allocateTaskCompletion(
  tx: PgTransaction,
  siteId: string,
  request: FederationDelegation,
  guard?: Guard,
) {
  if (siteId !== request.senderSiteId && siteId !== request.recipientSiteId)
    throw new FederationError("POLICY_DENIED");
  await allocate(tx, siteId, taskIntent(request), guard);
}

/** Manual public market obligations are separate from private, already-budgeted automatic handoffs. */
export async function allocateMarketCompletion(
  tx: PgTransaction,
  siteId: string,
  input: MarketProposalInput,
  guard?: Guard,
) {
  if (input.operation === "cancel-open-demand") return;
  const intentId =
    input.operation === "publish-demand" ? input.demand.demandId : input.claim.claimId;
  await allocate(
    tx,
    siteId,
    { kind: "market", intentId, digest: federationMaterialDigest(input) },
    guard,
  );
}

/** Read-only preflight before material capture or a remote market query; never commits an allocation. */
export async function assertTaskCompletionRoom(tx: PgTransaction, siteId: string, guard?: Guard) {
  const pool = await readPool(tx, siteId);
  if (!pool) return;
  await backing(pool, guard);
  const held = await usage(tx, siteId);
  if (BigInt(held.allocatedBytes) + BigInt(pool.taskBytes) > BigInt(pool.capacityBytes))
    throw new FederationError("STORAGE_PRESSURE");
}

export class FederationCompletionCapacity {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly guard?: Guard,
  ) {}

  async inspect() {
    const [row] = await this.db.execute<{
      policy: (Omit<Pool, "updatedAt"> & { updatedAt: string }) | null;
      allocatedBytes: string;
      obligations: number;
    }>(sql`
      SELECT (SELECT json_build_object('localSiteId', local_site_id, 'reserveId', reserve_id,
        'capacityBytes', capacity_bytes::text, 'taskBytes', task_bytes::text, 'marketBytes', market_bytes::text,
        'updatedAt', updated_at) FROM federation_completion_pools WHERE local_site_id = ${this.siteId}) AS policy,
        coalesce(sum(allocated_bytes), 0)::text AS "allocatedBytes", count(*)::integer AS obligations
      FROM federation_completion_claims WHERE local_site_id = ${this.siteId}
    `);
    if (!row) throw new Error("Missing completion pool snapshot");
    return {
      ...row,
      overcommitted: !!row.policy && BigInt(row.allocatedBytes) > BigInt(row.policy.capacityBytes),
    };
  }

  async configure(raw: z.input<typeof CompletionPoolInput>, actor: string) {
    const value = CompletionPoolInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await lock(tx, this.siteId);
      await backing(value, this.guard);
      const prior = await readPool(tx, this.siteId);
      // Moving an allocated pool to a different filesystem needs an explicit migration protocol.
      if (prior && prior.reserveId !== value.reserveId)
        throw new FederationError("OPERATION_CONFLICT");
      const [pool] = await tx
        .insert(pools)
        .values({ localSiteId: this.siteId, ...value })
        .onConflictDoUpdate({ target: pools.localSiteId, set: { ...value, updatedAt: new Date() } })
        .returning();
      if (!pool) throw new Error("Missing completion pool");
      if (!prior) await this.bootstrap(tx, pool);
      await tx.insert(auditLog).values({
        actor,
        action: "federation.storage.completion.configure",
        target: this.siteId,
        diff: { before: prior ?? null, after: pool },
      });
      return { policy: pool, ...(await usage(tx, this.siteId)) };
    });
  }

  private async bootstrap(tx: PgTransaction, pool: Pool) {
    // Existing accepted obligations are conservatively retained, including settled historical work.
    // shortcut: no automatic release until settlement, evidence and transfer cleanup have one proven terminal predicate.
    const tables = [
      sql`SELECT request AS body FROM federation_outbound WHERE local_site_id = ${this.siteId}`,
      sql`SELECT request AS body FROM workflow_execution_delegations WHERE local_site_id = ${this.siteId}`,
      sql`SELECT payload->'request' AS body FROM federation_reservation_proposals WHERE local_site_id = ${this.siteId}`,
      sql`SELECT payload->'proposal'->'request' AS body FROM federation_market_requests WHERE local_site_id = ${this.siteId}`,
      sql`SELECT payload->'request' AS body FROM federation_commercial_execution_approvals WHERE local_site_id = ${this.siteId} AND payload->>'kind' = 'commercial-reservation'`,
      sql`SELECT r.request_jws AS body FROM federation_reservations r JOIN federation_agreements a ON a.revision_id = r.agreement_revision_id WHERE a.target_site_id = ${this.siteId}`,
    ];
    for (const query of tables) {
      // Cursors avoid accumulating all historic requests in Server memory during first activation.
      await tx.execute(sql`DECLARE completion_bootstrap NO SCROLL CURSOR FOR ${query}`);
      try {
        for (;;) {
          const rows = await tx.execute<{ body: unknown }>(
            sql`FETCH FORWARD 128 FROM completion_bootstrap`,
          );
          if (!rows.length) break;
          for (const { body } of rows) {
            const payload =
              typeof body === "string"
                ? JSON.parse(Buffer.from(body.split(".")[1] ?? "", "base64url").toString("utf8"))
                : body;
            await insert(tx, pool, taskIntent(FederationDelegationSchema.parse(payload)));
          }
        }
      } finally {
        await tx.execute(sql`CLOSE completion_bootstrap`);
      }
    }
    await tx.execute(sql`
      INSERT INTO federation_completion_claims (local_site_id, kind, intent_id, digest, allocated_bytes)
      SELECT m.local_site_id, 'market', m.id::text, m.digest, ${pool.marketBytes}::numeric
      FROM federation_market_submissions m
      WHERE m.local_site_id = ${this.siteId} AND m.input->>'operation' IN ('publish-demand', 'claim-demand')
        AND NOT EXISTS (SELECT 1 FROM federation_market_requests r WHERE r.local_site_id = m.local_site_id AND r.market_submission_id = m.id)
    `);
  }
}
