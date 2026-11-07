import { federationCancellations, type PgDb, type PgTransaction } from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";

/** Final callers hold the agreement lock against recording a cancellation. */
export async function assertFederationNotCancelled(
  db: PgDb | PgTransaction,
  request: { senderSiteId: string; recipientSiteId: string; operationId: string },
) {
  const [cancelled] = await db
    .select({ id: federationCancellations.operationId })
    .from(federationCancellations)
    .where(
      and(
        eq(federationCancellations.localSiteId, request.recipientSiteId),
        eq(federationCancellations.senderSiteId, request.senderSiteId),
        eq(federationCancellations.operationId, request.operationId),
      ),
    );
  if (cancelled) throw new FederationError("CANCELLATION_REQUESTED");
}
