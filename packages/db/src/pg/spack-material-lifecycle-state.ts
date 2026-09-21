import { and, desc, eq, or, sql } from "drizzle-orm";
import type { PgDb } from "./index";
import { spackMaterialLifecycleEvents } from "./schema-spack-materials";
import type { SpackMaterialReferenceBinding } from "./spack-material-references";

type ReadConnection = Pick<PgDb, "select">;
type LifecycleCode =
  | "MATERIAL_LIFECYCLE_UNAVAILABLE"
  | "MATERIAL_LIFECYCLE_FORBIDDEN"
  | "MATERIAL_LIFECYCLE_CONFLICT"
  | "MATERIAL_LIFECYCLE_INVALID"
  | "MATERIAL_RELEASE_REFERENCED"
  | "MATERIAL_RELEASE_WITHDRAWN"
  | "MATERIAL_VISIBILITY_UNAVAILABLE"
  | "MATERIAL_VISIBILITY_FORBIDDEN"
  | "MATERIAL_VISIBILITY_CONFLICT"
  | "MATERIAL_VISIBILITY_INVALID"
  | "MATERIAL_VISIBILITY_DENIED";

const ERRORS = {
  MATERIAL_LIFECYCLE_UNAVAILABLE: [503, "Material lifecycle is unavailable"],
  MATERIAL_LIFECYCLE_FORBIDDEN: [403, "Material lifecycle management is not permitted"],
  MATERIAL_LIFECYCLE_CONFLICT: [409, "Material lifecycle revision or transition conflicts"],
  MATERIAL_LIFECYCLE_INVALID: [422, "Invalid material lifecycle request"],
  MATERIAL_RELEASE_REFERENCED: [409, "Material release still has protected references"],
  MATERIAL_RELEASE_WITHDRAWN: [404, "Material release not found"],
  MATERIAL_VISIBILITY_UNAVAILABLE: [503, "Material visibility policy is unavailable"],
  MATERIAL_VISIBILITY_FORBIDDEN: [403, "Material visibility management is not permitted"],
  MATERIAL_VISIBILITY_CONFLICT: [409, "Material visibility revision or policy conflicts"],
  MATERIAL_VISIBILITY_INVALID: [422, "Invalid material visibility request"],
  MATERIAL_VISIBILITY_DENIED: [404, "Material release not found"],
} as const;

/** Only bounded public errors may cross the transaction boundary. Never include SQL causes. */
export class SpackMaterialLifecycleError extends Error {
  readonly status: 403 | 404 | 409 | 422 | 503;

  constructor(readonly code: LifecycleCode) {
    super(ERRORS[code][1]);
    this.name = "SpackMaterialLifecycleError";
    this.status = ERRORS[code][0];
  }
}

export function releaseCondition(binding: SpackMaterialReferenceBinding) {
  return and(
    eq(spackMaterialLifecycleEvents.repositoryId, binding.repositoryId),
    eq(spackMaterialLifecycleEvents.manifestDigest, binding.manifestDigest),
  );
}

export async function readSpackMaterialLifecycle(
  db: ReadConnection,
  binding: SpackMaterialReferenceBinding,
) {
  const [row] = await db
    .select()
    .from(spackMaterialLifecycleEvents)
    .where(releaseCondition(binding))
    .orderBy(desc(spackMaterialLifecycleEvents.revision))
    .limit(1);
  if (
    row &&
    (!Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      (row.state !== "available" && row.state !== "withdrawn"))
  ) {
    throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_UNAVAILABLE");
  }
  return row;
}

/** Caller holds the lifecycle transaction lock; even empty registration checks storage. */
export async function assertSpackMaterialReleasesAvailable(
  db: ReadConnection,
  bindings: SpackMaterialReferenceBinding[],
) {
  const events = spackMaterialLifecycleEvents;
  await db.select().from(events).limit(0);
  for (let offset = 0; offset < bindings.length; offset += 250) {
    const [withdrawn] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          or(...bindings.slice(offset, offset + 250).map(releaseCondition)),
          eq(events.state, "withdrawn"),
          sql`not exists (
            select 1 from ${events} as newer
            where newer.repository_id = ${events.repositoryId}
              and newer.manifest_digest = ${events.manifestDigest}
              and newer.revision > ${events.revision}
          )`,
        ),
      )
      .limit(1);
    if (withdrawn) throw new SpackMaterialLifecycleError("MATERIAL_RELEASE_WITHDRAWN");
  }
}
