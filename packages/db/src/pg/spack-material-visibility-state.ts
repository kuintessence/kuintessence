import { and, desc, eq } from "drizzle-orm";
import type { PgDb } from "./index";
import { spackMaterialVisibilityEvents } from "./schema-spack-materials";
import { SpackMaterialLifecycleError } from "./spack-material-lifecycle-state";
import {
  authorizeSpackMaterialPrincipal,
  type SpackMaterialLifecyclePrincipal,
} from "./spack-material-principal";
import type { SpackMaterialReferenceBinding } from "./spack-material-references";
import { readSpackMaterialRollout } from "./spack-material-runtime";
import { parseSpackMaterialVisibilityPolicy } from "./spack-material-visibility-input";

type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
type ReadConnection = Pick<PgDb, "select">;
type Code =
  | "MATERIAL_VISIBILITY_UNAVAILABLE"
  | "MATERIAL_VISIBILITY_FORBIDDEN"
  | "MATERIAL_VISIBILITY_CONFLICT"
  | "MATERIAL_VISIBILITY_INVALID"
  | "MATERIAL_VISIBILITY_DENIED";

export class SpackMaterialVisibilityError extends SpackMaterialLifecycleError {
  constructor(code: Code) {
    super(code);
    this.name = "SpackMaterialVisibilityError";
  }
}

export function visibilityCondition(binding: SpackMaterialReferenceBinding) {
  return and(
    eq(spackMaterialVisibilityEvents.repositoryId, binding.repositoryId),
    eq(spackMaterialVisibilityEvents.manifestDigest, binding.manifestDigest),
  );
}

export function validateVisibilityRow(row: typeof spackMaterialVisibilityEvents.$inferSelect) {
  try {
    const policy = parseSpackMaterialVisibilityPolicy(row.policy);
    const canonicalLists =
      policy.mode !== "allowlist" ||
      (row.policy.mode === "allowlist" &&
        JSON.stringify(policy.userIds) === JSON.stringify(row.policy.userIds) &&
        JSON.stringify(policy.orgIds) === JSON.stringify(row.policy.orgIds));
    if (
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !Number.isSafeInteger(row.rolloutRevision) ||
      row.rolloutRevision < 1 ||
      row.reason.length === 0 ||
      row.reason.length > 1000 ||
      row.reason.trim() !== row.reason ||
      [...row.reason].some((character) => character.charCodeAt(0) < 32 || character === "\x7f") ||
      !Number.isFinite(row.createdAt.getTime()) ||
      !canonicalLists
    ) {
      throw new Error("Invalid visibility audit");
    }
    return { ...row, policy };
  } catch {
    throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
  }
}

export async function readSpackMaterialVisibility(
  db: ReadConnection,
  binding: SpackMaterialReferenceBinding,
) {
  const [row] = await db
    .select()
    .from(spackMaterialVisibilityEvents)
    .where(visibilityCondition(binding))
    .orderBy(desc(spackMaterialVisibilityEvents.revision))
    .limit(1);
  return row ? validateVisibilityRow(row) : undefined;
}

export async function assertVisibilityForPrincipal(
  db: ReadConnection,
  binding: SpackMaterialReferenceBinding,
  principal: SpackMaterialLifecyclePrincipal,
) {
  const current = await readSpackMaterialVisibility(db, binding);
  const policy = current?.policy;
  if (
    policy?.mode === "allowlist" &&
    !policy.userIds.includes(principal.sub) &&
    !policy.orgIds.some((orgId) => principal.orgIds.includes(orgId))
  ) {
    throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_DENIED");
  }
}

/** Caller already holds the lifecycle lock and has checked runtime and operation identity. */
export async function assertSpackMaterialOperationVisibility(
  tx: Transaction,
  binding: SpackMaterialReferenceBinding,
  subject: string,
) {
  const rollout = await readSpackMaterialRollout(tx);
  if (rollout?.phase !== "policy-ready") return;
  await authorizeSpackMaterialPrincipal(tx, subject, async (principal) => {
    await assertVisibilityForPrincipal(tx, binding, principal);
  });
}
