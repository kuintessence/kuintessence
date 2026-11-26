import { authzOutbox, type PgDb } from "@kuintessence/db";
import type { AuthzTuple } from "./service";

export async function insertAuthzOutboxRows(
  db: Pick<PgDb, "insert">,
  tuples: AuthzTuple[],
): Promise<void> {
  if (tuples.length === 0) return;
  await db.insert(authzOutbox).values(
    tuples.map((tuple) => ({
      operation: tuple.operation,
      resourceType: tuple.resource.type,
      resourceId: tuple.resource.id,
      relation: tuple.relation,
      subjectType: tuple.subject.type,
      subjectId: tuple.subject.id,
      subjectRelation: tuple.subject.relation ?? null,
      payload: tuple.payload ?? {},
    })),
  );
}
