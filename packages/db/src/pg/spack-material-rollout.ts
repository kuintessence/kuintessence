import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgDb } from "./index";
import { softwareOperations, users } from "./schema";
import {
  spackMaterialBindingRetirements,
  spackMaterialBindings,
  spackMaterialOperationReferences,
  spackMaterialRollouts,
  spackMaterialVisibilityEvents,
} from "./schema-spack-materials";
import { retireSpackMaterialBindings } from "./spack-material-binding-retirement";
import {
  parseSpackMaterialBindings,
  withSpackMaterialLifecycleTransaction,
} from "./spack-material-references";
import {
  parseSpackMaterialEpoch,
  parseSpackMaterialRolloutCommand,
} from "./spack-material-rollout-input";
import {
  assertSpackMaterialRuntime,
  isSpackMaterialPaused,
  isSpackMaterialPolicyPhase,
  readSpackMaterialRollout,
} from "./spack-material-runtime";

type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
const INVENTORY_PAGE_SIZE = 1_000;

export class SpackMaterialRollout {
  constructor(private readonly db: PgDb) {}

  async assertRuntime(epoch?: string): Promise<void> {
    try {
      await assertSpackMaterialRuntime(
        this.db,
        epoch === undefined ? undefined : parseSpackMaterialEpoch(epoch),
      );
    } catch {
      throw rolloutError();
    }
  }

  /** Offline DB-operator API only. Do not expose as an unauthenticated HTTP handler. */
  async execute(input: unknown) {
    try {
      const command = parseSpackMaterialRolloutCommand(input);
      const reconciled =
        command.action === "reconcile" || command.action === "retire"
          ? command.bindings.flatMap((bindings) => parseSpackMaterialBindings(bindings))
          : [];
      if (reconciled.length > 10_000) throw rolloutError();
      if (command.action === "retire" && (reconciled.length === 0 || reconciled.length > 1000)) {
        throw rolloutError();
      }
      return await withSpackMaterialLifecycleTransaction(this.db, async (tx) => {
        await tx.execute(sql`set local statement_timeout = '30s'`);
        const current = await readSpackMaterialRollout(tx);
        if (command.action === "inspect") return status(tx, current);
        const activating = command.action === "activate" || command.action === "activate-policy";
        const policyEnabled =
          command.action === "activate-policy" ||
          (current !== undefined && isSpackMaterialPolicyPhase(current.phase));
        await requireOperator(tx, command.operatorId);
        if ((current?.revision ?? 0) !== command.expectedRevision) throw rolloutError();
        if (
          command.action !== "pause" &&
          (!current || !isSpackMaterialPaused(current.phase) || current.epoch !== command.epoch)
        ) {
          throw rolloutError();
        }
        if (command.action === "reconcile" && reconciled.length > 0) {
          await tx
            .insert(spackMaterialBindings)
            .values(reconciled)
            .onConflictDoNothing({
              target: [
                spackMaterialBindings.spec,
                spackMaterialBindings.repositoryId,
                spackMaterialBindings.manifestDigest,
              ],
            });
        }
        if (activating || command.action === "retire") {
          // Operation creation/status writes do not take our advisory lock.
          await tx.execute(sql`lock table ${softwareOperations} in share mode`);
        }
        let inventory = await inventorySnapshot(tx);
        if (
          (command.action === "activate" ||
            command.action === "activate-policy" ||
            command.action === "retire") &&
          (current?.action !== "reconcile" ||
            command.inventoryDigest !== current.inventoryDigest ||
            command.inventoryDigest !== inventory.inventoryDigest ||
            inventory.activeInstallCount !== 0 ||
            inventory.orphanedOperationCount !== 0)
        ) {
          throw rolloutError();
        }
        if (policyEnabled) {
          // Do not activate a policy-aware epoch without its migrated journal.
          await tx.select().from(spackMaterialVisibilityEvents).limit(0);
        }
        if (command.action === "retire") {
          await retireSpackMaterialBindings(tx, reconciled, {
            epoch: command.epoch,
            revision: command.expectedRevision + 1,
            operatorId: command.operatorId,
            reason: command.reason,
            evidence: command.evidence,
          });
          inventory = await inventorySnapshot(tx);
        }
        const [next] = await tx
          .insert(spackMaterialRollouts)
          .values({
            revision: command.expectedRevision + 1,
            epoch: command.action === "pause" ? randomUUID() : command.epoch,
            phase: policyEnabled
              ? activating
                ? "policy-ready"
                : "policy-paused"
              : activating
                ? "ready"
                : "paused",
            action: command.action,
            operatorId: command.operatorId,
            inventoryDigest: inventory.inventoryDigest,
            evidence:
              command.action === "activate" ||
              command.action === "activate-policy" ||
              command.action === "retire"
                ? command.evidence
                : null,
          })
          .returning();
        if (!next) throw rolloutError();
        return { ...publicState(next), ...inventory };
      });
    } catch {
      throw rolloutError();
    }
  }
}

async function requireOperator(tx: Transaction, operatorId: string): Promise<void> {
  const [actor] = await tx
    .select({ role: users.role, suspended: users.suspended })
    .from(users)
    .where(eq(users.id, operatorId))
    .for("share");
  if (
    !actor ||
    actor.suspended ||
    (actor.role !== "super_admin" && actor.role !== "platform_admin")
  ) {
    throw rolloutError();
  }
}

type RolloutRow = typeof spackMaterialRollouts.$inferSelect;

function publicState(row?: RolloutRow) {
  return {
    revision: row?.revision ?? 0,
    epoch: row?.epoch ?? null,
    phase: row?.phase ?? "observe",
    action: row?.action ?? null,
  };
}

async function status(tx: Transaction, row?: RolloutRow) {
  return { ...publicState(row), ...(await inventorySnapshot(tx)) };
}

async function inventorySnapshot(tx: Transaction) {
  // Keyset pages bound memory, not the lifetime size of the append-only ledger.
  const hash = createHash("sha256").update('{"bindings":[');
  let bindingCount = 0;
  let operationReferenceCount = 0;
  let lastBinding: { spec: string; repositoryId: string; manifestDigest: string } | undefined;
  while (true) {
    const bindings = await tx
      .select({
        spec: spackMaterialBindings.spec,
        repositoryId: spackMaterialBindings.repositoryId,
        manifestDigest: spackMaterialBindings.manifestDigest,
      })
      .from(spackMaterialBindings)
      .where(
        lastBinding
          ? sql`(${spackMaterialBindings.spec}, ${spackMaterialBindings.repositoryId},
              ${spackMaterialBindings.manifestDigest}) >
              (${lastBinding.spec}, ${lastBinding.repositoryId}, ${lastBinding.manifestDigest})`
          : undefined,
      )
      .orderBy(
        spackMaterialBindings.spec,
        spackMaterialBindings.repositoryId,
        spackMaterialBindings.manifestDigest,
      )
      .limit(INVENTORY_PAGE_SIZE);
    for (const binding of bindings) {
      if (bindingCount++ > 0) hash.update(",");
      hash.update(JSON.stringify(binding));
    }
    if (bindings.length < INVENTORY_PAGE_SIZE) break;
    lastBinding = bindings.at(-1);
  }
  hash.update('],"references":[');
  let lastOperationId: string | undefined;
  while (true) {
    const references = await tx
      .select({
        operationId: spackMaterialOperationReferences.operationId,
        agentId: spackMaterialOperationReferences.agentId,
        requestedBy: spackMaterialOperationReferences.requestedBy,
        spec: spackMaterialOperationReferences.spec,
        repositoryId: spackMaterialOperationReferences.repositoryId,
        manifestDigest: spackMaterialOperationReferences.manifestDigest,
      })
      .from(spackMaterialOperationReferences)
      .where(
        lastOperationId
          ? sql`${spackMaterialOperationReferences.operationId} > ${lastOperationId}::uuid`
          : undefined,
      )
      .orderBy(spackMaterialOperationReferences.operationId)
      .limit(INVENTORY_PAGE_SIZE);
    for (const reference of references) {
      if (operationReferenceCount++ > 0) hash.update(",");
      hash.update(JSON.stringify(reference));
    }
    if (references.length < INVENTORY_PAGE_SIZE) break;
    lastOperationId = references.at(-1)?.operationId;
  }
  hash.update('],"retirements":[');
  let retiredBindingCount = 0;
  let lastRetiredBindingId: string | undefined;
  while (true) {
    const retirements = await tx
      .select({
        bindingId: spackMaterialBindingRetirements.bindingId,
        epoch: spackMaterialBindingRetirements.epoch,
        revision: spackMaterialBindingRetirements.revision,
        operatorId: spackMaterialBindingRetirements.operatorId,
        reason: spackMaterialBindingRetirements.reason,
        evidence: spackMaterialBindingRetirements.evidence,
      })
      .from(spackMaterialBindingRetirements)
      .where(
        lastRetiredBindingId
          ? sql`${spackMaterialBindingRetirements.bindingId} > ${lastRetiredBindingId}::uuid`
          : undefined,
      )
      .orderBy(spackMaterialBindingRetirements.bindingId)
      .limit(INVENTORY_PAGE_SIZE);
    for (const retirement of retirements) {
      if (retiredBindingCount++ > 0) hash.update(",");
      hash.update(JSON.stringify(retirement));
    }
    if (retirements.length < INVENTORY_PAGE_SIZE) break;
    lastRetiredBindingId = retirements.at(-1)?.bindingId;
  }
  hash.update("]}");
  const [counts] = await tx
    .select({
      activeInstallCount: sql`(
      select count(*) from ${softwareOperations}
      where ${softwareOperations.action} = 'install'
        and (${softwareOperations.status} is null
          or ${softwareOperations.status} not in ('succeeded', 'failed', 'rejected'))
    )`.mapWith(Number),
      orphanedOperationCount: sql`(
      select count(*) from ${spackMaterialOperationReferences}
      left join ${softwareOperations}
        on ${softwareOperations.id} = ${spackMaterialOperationReferences.operationId}
      where ${softwareOperations.id} is null
    )`.mapWith(Number),
    })
    .from(sql`(select 1) as singleton`);
  if (!counts || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw rolloutError();
  }
  return {
    inventoryDigest: `sha256:${hash.digest("hex")}`,
    bindingCount,
    retiredBindingCount,
    operationReferenceCount,
    ...counts,
  };
}

function rolloutError() {
  return Object.assign(
    new Error("Spack material rollout is unavailable or the request is invalid"),
    { code: "SPACK_MATERIAL_ROLLOUT_ERROR" as const },
  );
}
