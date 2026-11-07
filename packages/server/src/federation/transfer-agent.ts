import {
  federationInputAttempts,
  federationResultAttempts,
  type PgTransaction,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

/** Acquisition and renewal must serialize against the same Agent slot. */
export async function lockFederationTransferSlot(tx: PgTransaction, agentId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`federation-transfer-agent:${agentId}`}, 0))`,
  );
}

/** Both transfer directions share one Agent disk/stream slot across Server processes. */
export async function lockFederationTransferAgent(tx: PgTransaction, agentId: string, now: Date) {
  await lockFederationTransferSlot(tx, agentId);
  for (const attempts of [federationInputAttempts, federationResultAttempts]) {
    const [held] = await tx
      .select({ generation: attempts.generation })
      .from(attempts)
      .where(
        and(
          eq(attempts.agentId, agentId),
          inArray(attempts.state, [
            "preparing",
            "copying",
            "assembling",
            "verifying",
            "cleanup_pending",
          ]),
          gte(attempts.leaseUntil, now),
        ),
      )
      .limit(1);
    if (held) throw new FederationError("OPERATION_CONFLICT");
  }
}
