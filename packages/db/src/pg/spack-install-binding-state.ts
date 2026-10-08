import { and, desc, eq } from "drizzle-orm";
import type { PgDb } from "./index";
import { spackInstallBindingEvents } from "./schema-spack-materials";
import { SpackMaterialLifecycleError } from "./spack-material-lifecycle-state";

export interface SpackInstallBindingQuery {
  scope: string;
  spec: string;
}

export function installBindingCondition(query: SpackInstallBindingQuery) {
  return and(
    eq(spackInstallBindingEvents.scope, query.scope),
    eq(spackInstallBindingEvents.spec, query.spec),
  );
}

export async function readSpackInstallBinding(
  db: Pick<PgDb, "select">,
  query: SpackInstallBindingQuery,
) {
  const [row] = await db
    .select()
    .from(spackInstallBindingEvents)
    .where(installBindingCondition(query))
    .orderBy(desc(spackInstallBindingEvents.revision))
    .limit(1);
  return row ? installBindingEvent(row) : undefined;
}

export function installBindingEvent(row: typeof spackInstallBindingEvents.$inferSelect) {
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    (row.state !== "enabled" && row.state !== "disabled") ||
    (row.source !== "config" && row.source !== "web") ||
    (row.state === "enabled" && (!row.repositoryId || !row.manifestDigest)) ||
    (row.state === "disabled" && (row.repositoryId !== null || row.manifestDigest !== null))
  ) {
    throw new SpackMaterialLifecycleError("INSTALL_BINDING_UNAVAILABLE");
  }
  return {
    revision: row.revision,
    state: row.state,
    binding:
      row.repositoryId && row.manifestDigest
        ? { repositoryId: row.repositoryId, manifestDigest: row.manifestDigest }
        : null,
    source: row.source,
    operatorId: row.operatorId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}
