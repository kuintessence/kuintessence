import { desc, sql } from "drizzle-orm";
import type { PgDb } from "./index";
import { spackMaterialVisibilityEvents } from "./schema-spack-materials";
import {
  assertSpackMaterialReleasesAvailable,
  SpackMaterialLifecycleError,
} from "./spack-material-lifecycle-state";
import {
  authorizeSpackMaterialPrincipal,
  type SpackMaterialLifecyclePrincipal,
} from "./spack-material-principal";
import {
  parseSpackMaterialBindings,
  type SpackMaterialReferenceBinding,
  withSpackMaterialLifecycleTransaction,
} from "./spack-material-references";
import { assertSpackMaterialRuntime, readSpackMaterialRollout } from "./spack-material-runtime";
import {
  parseSpackMaterialVisibilityChange,
  type SpackMaterialVisibilityChange,
  type SpackMaterialVisibilityPolicy,
} from "./spack-material-visibility-input";
import {
  assertVisibilityForPrincipal,
  readSpackMaterialVisibility,
  SpackMaterialVisibilityError,
  validateVisibilityRow,
  visibilityCondition,
} from "./spack-material-visibility-state";

export type {
  SpackMaterialVisibilityChange,
  SpackMaterialVisibilityPolicy,
} from "./spack-material-visibility-input";
export { SpackMaterialVisibilityError } from "./spack-material-visibility-state";

export interface SpackMaterialVisibilityStatus {
  revision: number;
  policy: SpackMaterialVisibilityPolicy;
  history: {
    revision: number;
    policy: SpackMaterialVisibilityPolicy;
    operatorId: string;
    reason: string;
    epoch: string;
    rolloutRevision: number;
    createdAt: string;
  }[];
  historyTruncated: boolean;
}

type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
type Authorize = (principal: SpackMaterialLifecyclePrincipal) => Promise<void>;

export class SpackMaterialVisibility {
  constructor(
    private readonly db: PgDb,
    private readonly epoch?: string,
  ) {}

  async assertReadable(
    binding: SpackMaterialReferenceBinding,
    subject: string,
    authorize: Authorize,
    checkpoint: () => void = () => {},
  ): Promise<void> {
    const value = parseBinding(binding);
    return this.transaction(async (tx) => {
      checkpoint();
      await assertSpackMaterialRuntime(tx, this.epoch);
      await assertSpackMaterialReleasesAvailable(tx, [value]);
      await authorizeSpackMaterialPrincipal(tx, subject, async (principal) => {
        checkpoint();
        await authorize(principal);
        const rollout = await readSpackMaterialRollout(tx);
        if (rollout?.phase === "policy-ready") {
          await assertVisibilityForPrincipal(tx, value, principal);
        }
      });
      checkpoint();
    }, true);
  }

  async inspect(
    binding: SpackMaterialReferenceBinding,
    subject: string,
    authorize: Authorize,
  ): Promise<SpackMaterialVisibilityStatus> {
    const value = parseBinding(binding);
    return this.transaction(async (tx) => {
      await this.requireEnabled(tx);
      await authorizeSpackMaterialPrincipal(tx, subject, authorize);
      return status(tx, value);
    });
  }

  async transition(
    binding: SpackMaterialReferenceBinding,
    subject: string,
    input: SpackMaterialVisibilityChange,
    authorize: Authorize,
  ): Promise<SpackMaterialVisibilityStatus> {
    const value = parseBinding(binding);
    let change: SpackMaterialVisibilityChange;
    try {
      change = parseSpackMaterialVisibilityChange(input);
    } catch {
      throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_INVALID");
    }
    return this.transaction(async (tx) => {
      const rollout = await this.requireEnabled(tx);
      await authorizeSpackMaterialPrincipal(tx, subject, authorize);
      const current = await readSpackMaterialVisibility(tx, value);
      if (
        (current?.revision ?? 0) !== change.expectedRevision ||
        JSON.stringify(current?.policy ?? { mode: "inherit" }) === JSON.stringify(change.policy)
      ) {
        throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_CONFLICT");
      }
      await tx.insert(spackMaterialVisibilityEvents).values({
        ...value,
        revision: change.expectedRevision + 1,
        policy: change.policy,
        operatorId: subject,
        reason: change.reason,
        epoch: rollout.epoch,
        rolloutRevision: rollout.revision,
      });
      return status(tx, value);
    });
  }

  private async requireEnabled(tx: Transaction) {
    await assertSpackMaterialRuntime(tx, this.epoch);
    const rollout = await readSpackMaterialRollout(tx);
    if (!rollout || rollout.phase !== "policy-ready" || rollout.epoch !== this.epoch) {
      throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
    }
    return rollout;
  }

  private async transaction<T>(work: (tx: Transaction) => Promise<T>, reading = false): Promise<T> {
    try {
      return await withSpackMaterialLifecycleTransaction(this.db, async (tx) => {
        await tx.execute(sql`set local statement_timeout = '10s'`);
        return work(tx);
      });
    } catch (error) {
      if (error instanceof SpackMaterialVisibilityError) throw error;
      if (error instanceof SpackMaterialLifecycleError) {
        if (error.code === "MATERIAL_RELEASE_WITHDRAWN" && reading) {
          throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_DENIED");
        }
        if (error.code === "MATERIAL_LIFECYCLE_FORBIDDEN") {
          throw new SpackMaterialVisibilityError(
            reading ? "MATERIAL_VISIBILITY_DENIED" : "MATERIAL_VISIBILITY_FORBIDDEN",
          );
        }
      }
      throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
    }
  }
}

function parseBinding(input: SpackMaterialReferenceBinding): SpackMaterialReferenceBinding {
  try {
    const [value] = parseSpackMaterialBindings({ release: input });
    if (!value) throw new Error("Missing binding");
    return { repositoryId: value.repositoryId, manifestDigest: value.manifestDigest };
  } catch {
    throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_INVALID");
  }
}

async function status(
  tx: Transaction,
  binding: SpackMaterialReferenceBinding,
): Promise<SpackMaterialVisibilityStatus> {
  const rows = await tx
    .select()
    .from(spackMaterialVisibilityEvents)
    .where(visibilityCondition(binding))
    .orderBy(desc(spackMaterialVisibilityEvents.revision))
    .limit(101);
  const checked = rows.map(validateVisibilityRow);
  const revision = checked[0]?.revision ?? 0;
  if (
    checked.length !== Math.min(revision, 101) ||
    checked.some((row, index) => row.revision !== revision - index)
  ) {
    throw new SpackMaterialVisibilityError("MATERIAL_VISIBILITY_UNAVAILABLE");
  }
  return {
    revision,
    policy: checked[0]?.policy ?? { mode: "inherit" },
    history: checked.slice(0, 100).map((row) => ({
      revision: row.revision,
      policy: row.policy,
      operatorId: row.operatorId,
      reason: row.reason,
      epoch: row.epoch,
      rolloutRevision: row.rolloutRevision,
      createdAt: row.createdAt.toISOString(),
    })),
    historyTruncated: revision > 100,
  };
}
