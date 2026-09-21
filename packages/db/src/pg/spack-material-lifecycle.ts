import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgDb } from "./index";
import { softwareOperations, userOrgMemberships, users } from "./schema";
import {
  spackMaterialBindingRetirements,
  spackMaterialBindings,
  spackMaterialLifecycleEvents,
  spackMaterialOperationReferences,
} from "./schema-spack-materials";
import {
  assertSpackMaterialReleasesAvailable,
  readSpackMaterialLifecycle,
  releaseCondition,
  SpackMaterialLifecycleError,
} from "./spack-material-lifecycle-state";
import {
  parseSpackMaterialBindings,
  type SpackMaterialReferenceBinding,
  withSpackMaterialLifecycleTransaction,
} from "./spack-material-references";
import { assertSpackMaterialRuntime, readSpackMaterialRollout } from "./spack-material-runtime";

export { SpackMaterialLifecycleError } from "./spack-material-lifecycle-state";
export interface SpackMaterialLifecyclePrincipal {
  sub: string;
  role: string;
  orgIds: string[];
}
export interface SpackMaterialLifecycleChange {
  action: "withdraw" | "restore";
  expectedRevision: number;
  reason: string;
}
export interface SpackMaterialLifecycleStatus {
  revision: number;
  state: "available" | "withdrawn";
  history: {
    revision: number;
    state: "available" | "withdrawn";
    operatorId: string;
    reason: string;
    epoch: string;
    rolloutRevision: number;
    createdAt: string;
  }[];
  historyTruncated: boolean;
}
export interface SpackMaterialCatalogState extends SpackMaterialReferenceBinding {
  revision: number;
  state: "available" | "withdrawn";
}

type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
type Authorize = (principal: SpackMaterialLifecyclePrincipal) => Promise<void>;

export class SpackMaterialLifecycle {
  constructor(
    private readonly db: PgDb,
    private readonly epoch?: string,
  ) {}

  async assertAvailable(binding: SpackMaterialReferenceBinding): Promise<void> {
    return this.transaction(async (tx) => {
      const value = parseBinding(binding);
      await assertSpackMaterialRuntime(tx, this.epoch);
      await assertSpackMaterialReleasesAvailable(tx, [value]);
    });
  }

  async inspect(binding: SpackMaterialReferenceBinding, subject: string, authorize: Authorize) {
    return this.transaction(async (tx) => {
      const value = parseBinding(binding);
      await this.requireReady(tx);
      await authorizeCanonical(tx, subject, authorize);
      return status(tx, value);
    });
  }

  async inspectCatalog(
    bindings: SpackMaterialReferenceBinding[],
    subject: string,
    authorize: (principal: SpackMaterialLifecyclePrincipal) => Promise<readonly boolean[]>,
    checkpoint: () => void = () => {},
  ): Promise<SpackMaterialCatalogState[]> {
    if (!Array.isArray(bindings) || bindings.length > 20) {
      throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_INVALID");
    }
    const values = Array.from(bindings, parseBinding);
    if (
      new Set(values.map((value) => `${value.repositoryId}/${value.manifestDigest}`)).size !==
      values.length
    ) {
      throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_INVALID");
    }
    return this.transaction(async (tx) => {
      checkpoint();
      await this.requireReady(tx);
      checkpoint();
      let visible: readonly boolean[] = [];
      await authorizeCanonical(tx, subject, async (principal) => {
        const mask = await authorize(principal);
        if (
          !Array.isArray(mask) ||
          mask.length !== values.length ||
          Array.from(mask).some((value) => typeof value !== "boolean")
        ) {
          throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
        }
        visible = [...mask];
      });
      checkpoint();
      await tx.select({ id: spackMaterialLifecycleEvents.id }).from(spackMaterialLifecycleEvents).limit(0);
      checkpoint();
      const result: SpackMaterialCatalogState[] = [];
      for (const [index, binding] of values.entries()) {
        checkpoint();
        if (!visible[index]) continue;
        const current = await readSpackMaterialLifecycle(tx, binding);
        checkpoint();
        result.push({
          ...binding,
          revision: current?.revision ?? 0,
          state: current?.state === "withdrawn" ? "withdrawn" : "available",
        });
      }
      return result;
    });
  }

  async transition(
    binding: SpackMaterialReferenceBinding,
    subject: string,
    input: SpackMaterialLifecycleChange,
    authorize: Authorize,
  ) {
    // Copy all caller-controlled data before waiting for a lock.
    const value = parseBinding(binding);
    const change = parseChange(input);
    return this.transaction(async (tx) => {
      const rollout = await this.requireReady(tx);
      await authorizeCanonical(tx, subject, authorize);
      const current = await readSpackMaterialLifecycle(tx, value);
      const state = change.action === "withdraw" ? "withdrawn" : "available";
      if (
        (current?.revision ?? 0) !== change.expectedRevision ||
        (current?.state ?? "available") === state
      ) {
        throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_CONFLICT");
      }
      if (change.action === "withdraw") await requireUnreferenced(tx, value);
      await tx.insert(spackMaterialLifecycleEvents).values({
        ...value,
        revision: change.expectedRevision + 1,
        state,
        operatorId: subject,
        reason: change.reason,
        epoch: rollout.epoch,
        rolloutRevision: rollout.revision,
      });
      return status(tx, value);
    });
  }

  private async requireReady(tx: Transaction) {
    await assertSpackMaterialRuntime(tx, this.epoch);
    const rollout = await readSpackMaterialRollout(tx);
    if (!rollout || rollout.phase !== "ready" || rollout.epoch !== this.epoch) {
      throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_UNAVAILABLE");
    }
    return rollout;
  }

  private async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await withSpackMaterialLifecycleTransaction(this.db, async (tx) => {
        await tx.execute(sql`set local statement_timeout = '10s'`);
        return work(tx);
      });
    } catch (error) {
      if (error instanceof SpackMaterialLifecycleError) throw error;
      throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_UNAVAILABLE");
    }
  }
}

async function authorizeCanonical(tx: Transaction, subject: string, authorize: Authorize) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(subject)) {
    throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
  }
  const [actor] = await tx
    .select({ sub: users.id, role: users.role, suspended: users.suspended })
    .from(users)
    .where(eq(users.id, subject))
    .for("share");
  if (!actor || actor.suspended) {
    throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
  }
  const memberships = await tx
    .select({ orgId: userOrgMemberships.orgId })
    .from(userOrgMemberships)
    .where(eq(userOrgMemberships.userId, subject))
    .for("share");
  try {
    await authorize({
      sub: actor.sub,
      role: actor.role,
      orgIds: memberships.map((membership) => membership.orgId),
    });
  } catch (error) {
    if (error instanceof SpackMaterialLifecycleError) throw error;
    throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
  }
}

async function requireUnreferenced(tx: Transaction, binding: SpackMaterialReferenceBinding) {
  // Status updates and deletions do not take the lifecycle advisory lock.
  await tx.execute(sql`lock table ${softwareOperations} in share mode`);
  const [configured] = await tx
    .select({ id: spackMaterialBindings.id })
    .from(spackMaterialBindings)
    .leftJoin(
      spackMaterialBindingRetirements,
      eq(spackMaterialBindingRetirements.bindingId, spackMaterialBindings.id),
    )
    .where(
      and(
        eq(spackMaterialBindings.repositoryId, binding.repositoryId),
        eq(spackMaterialBindings.manifestDigest, binding.manifestDigest),
        isNull(spackMaterialBindingRetirements.bindingId),
      ),
    )
    .limit(1);
  const references = spackMaterialOperationReferences;
  const [active] = await tx
    .select({ id: references.operationId })
    .from(references)
    .leftJoin(softwareOperations, eq(softwareOperations.id, references.operationId))
    .where(
      and(
        eq(references.repositoryId, binding.repositoryId),
        eq(references.manifestDigest, binding.manifestDigest),
        sql`(${softwareOperations.id} is null or ${softwareOperations.status} is null
          or ${softwareOperations.status} not in ('succeeded', 'failed', 'rejected'))`,
      ),
    )
    .limit(1);
  if (configured || active) {
    throw new SpackMaterialLifecycleError("MATERIAL_RELEASE_REFERENCED");
  }
}

async function status(
  tx: Transaction,
  binding: SpackMaterialReferenceBinding,
): Promise<SpackMaterialLifecycleStatus> {
  const rows = await tx
    .select()
    .from(spackMaterialLifecycleEvents)
    .where(releaseCondition(binding))
    .orderBy(desc(spackMaterialLifecycleEvents.revision))
    .limit(101);
  const history = rows.slice(0, 100).map((row): SpackMaterialLifecycleStatus["history"][number] => {
    if (row.state !== "available" && row.state !== "withdrawn") {
      throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_UNAVAILABLE");
    }
    return {
      revision: row.revision,
      state: row.state,
      operatorId: row.operatorId,
      reason: row.reason,
      epoch: row.epoch,
      rolloutRevision: row.rolloutRevision,
      createdAt: row.createdAt.toISOString(),
    };
  });
  return {
    revision: history[0]?.revision ?? 0,
    state: history[0]?.state ?? "available",
    history,
    historyTruncated: rows.length > 100,
  };
}

function parseBinding(input: SpackMaterialReferenceBinding): SpackMaterialReferenceBinding {
  try {
    const [value] = parseSpackMaterialBindings({ release: input });
    if (!value) throw new Error("Missing binding");
    return { repositoryId: value.repositoryId, manifestDigest: value.manifestDigest };
  } catch {
    throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_INVALID");
  }
}

function parseChange(input: SpackMaterialLifecycleChange): SpackMaterialLifecycleChange {
  if (
    !input ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== 3 ||
    !Object.hasOwn(input, "action") ||
    !Object.hasOwn(input, "expectedRevision") ||
    !Object.hasOwn(input, "reason") ||
    (input.action !== "withdraw" && input.action !== "restore") ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= 2_147_483_647 ||
    typeof input.reason !== "string" ||
    input.reason.length === 0 ||
    input.reason.length > 1000 ||
    input.reason.trim() !== input.reason ||
    [...input.reason].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_INVALID");
  }
  return { action: input.action, expectedRevision: input.expectedRevision, reason: input.reason };
}
