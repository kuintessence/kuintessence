import { and, eq, sql } from "drizzle-orm";
import type { PgDb } from "./index";
import { softwareOperations } from "./schema";
import { spackMaterialBindings, spackMaterialOperationReferences } from "./schema-spack-materials";
import { assertSpackMaterialBindingsActive } from "./spack-material-binding-retirement";
import {
  assertSpackMaterialReleasesAvailable,
  SpackMaterialLifecycleError,
} from "./spack-material-lifecycle-state";
import { assertSpackMaterialRuntime } from "./spack-material-runtime";
import { assertSpackMaterialOperationVisibility } from "./spack-material-visibility-state";

export interface SpackMaterialReferenceBinding {
  repositoryId: string;
  manifestDigest: string;
}

export interface SpackMaterialOperationReferenceInput extends SpackMaterialReferenceBinding {
  operationId: string;
  agentId: string;
  requestedBy: string;
  spec: string;
}

export interface SpackMaterialReleaseReferences {
  bindingCount: number;
  activeOperationCount: number;
  orphanedOperationCount: number;
}

type LifecycleTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

/**
 * All future material lifecycle mutations must reuse this transaction boundary.
 * Do not check references outside it and then withdraw or mutate a release.
 */
export async function withSpackMaterialLifecycleTransaction<T>(
  db: PgDb,
  work: (tx: LifecycleTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('kuintessence:spack-material-lifecycle'))`,
      );
      return work(tx);
    });
  } catch (error) {
    if (error instanceof SpackMaterialLifecycleError) throw error;
    throw referenceError();
  }
}

export class SpackMaterialReferences {
  constructor(
    private readonly db: PgDb,
    private readonly epoch?: string,
  ) {}

  async registerBindings(bindings: Record<string, SpackMaterialReferenceBinding>): Promise<void> {
    try {
      // Validate and copy the entire batch before any asynchronous work or writes.
      const rows = parseSpackMaterialBindings(bindings);
      await withSpackMaterialLifecycleTransaction(this.db, async (tx) => {
        await assertSpackMaterialRuntime(tx, this.epoch);
        await assertSpackMaterialBindingsActive(tx, rows);
        await assertSpackMaterialReleasesAvailable(tx, rows);
        // Empty configurations must still fail when reference tables/columns are missing.
        await tx.select().from(spackMaterialBindings).limit(0);
        await tx.select().from(spackMaterialOperationReferences).limit(0);
        if (rows.length === 0) return;
        await tx
          .insert(spackMaterialBindings)
          .values(rows)
          .onConflictDoNothing({
            target: [
              spackMaterialBindings.spec,
              spackMaterialBindings.repositoryId,
              spackMaterialBindings.manifestDigest,
            ],
          });
      });
    } catch {
      throw referenceError();
    }
  }

  async acquireOperation(input: SpackMaterialOperationReferenceInput): Promise<void> {
    try {
      const value = parseOperation(input);
      await withSpackMaterialLifecycleTransaction(this.db, async (tx) => {
        await assertSpackMaterialRuntime(tx, this.epoch);
        await assertSpackMaterialBindingsActive(tx, [value]);
        await assertSpackMaterialReleasesAvailable(tx, [value]);
        const [operation] = await tx
          .select({
            agentId: softwareOperations.agentId,
            requestedBy: softwareOperations.requestedBy,
            spec: softwareOperations.spec,
            action: softwareOperations.action,
            status: softwareOperations.status,
          })
          .from(softwareOperations)
          .where(eq(softwareOperations.id, value.operationId))
          // Operation updates/deletes do not take the lifecycle lock.
          .for("share");
        if (
          !operation ||
          operation.agentId !== value.agentId ||
          operation.requestedBy !== value.requestedBy ||
          operation.spec !== value.spec ||
          operation.action !== "install" ||
          (operation.status !== "queued" && operation.status !== "running")
        ) {
          throw referenceError();
        }

        await assertSpackMaterialOperationVisibility(tx, value, value.requestedBy);
        const [existing] = await tx
          .select()
          .from(spackMaterialOperationReferences)
          .where(eq(spackMaterialOperationReferences.operationId, value.operationId));
        if (existing) {
          if (
            existing.agentId !== value.agentId ||
            existing.requestedBy !== value.requestedBy ||
            existing.spec !== value.spec ||
            existing.repositoryId !== value.repositoryId ||
            existing.manifestDigest !== value.manifestDigest
          ) {
            throw referenceError();
          }
          return;
        }
        // No UPDATE/upsert: retries and old tickets must retain the first binding.
        await tx.insert(spackMaterialOperationReferences).values(value);
      });
    } catch {
      throw referenceError();
    }
  }

  /**
   * Diagnostic snapshot only. Zero is NOT proof of completeness or permission to
   * withdraw a release. Never use this API for a future check-then-withdraw flow.
   */
  async listReleaseReferences(
    binding: SpackMaterialReferenceBinding,
  ): Promise<SpackMaterialReleaseReferences> {
    try {
      const value = parseBinding(binding);
      const references = spackMaterialOperationReferences;
      // One statement keeps all three counts on the same MVCC snapshot.
      const [result] = await this.db
        .select({
          bindingCount: sql`(
            select count(*) from ${spackMaterialBindings}
            where ${spackMaterialBindings.repositoryId} = ${value.repositoryId}
              and ${spackMaterialBindings.manifestDigest} = ${value.manifestDigest}
          )`.mapWith(Number),
          activeOperationCount: sql`count(*) filter (
            where ${softwareOperations.id} is not null
              and (${softwareOperations.status} is null
                or ${softwareOperations.status} not in ('succeeded', 'failed', 'rejected'))
          )`.mapWith(Number),
          orphanedOperationCount: sql`count(*) filter (
            where ${softwareOperations.id} is null
          )`.mapWith(Number),
        })
        .from(references)
        .leftJoin(softwareOperations, eq(softwareOperations.id, references.operationId))
        .where(
          and(
            eq(references.repositoryId, value.repositoryId),
            eq(references.manifestDigest, value.manifestDigest),
          ),
        );
      if (
        !result ||
        Object.values(result).some((count) => !Number.isSafeInteger(count) || count < 0)
      ) {
        throw referenceError();
      }
      return result;
    } catch {
      throw referenceError();
    }
  }
}

export function parseSpackMaterialBindings(bindings: unknown) {
  const entries = Object.entries(record(bindings));
  if (entries.length > 10_000) throw referenceError();
  return entries.map(([spec, binding]) => ({
    spec: boundedString(spec, 500),
    ...parseBinding(binding),
  }));
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw referenceError();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string" || (keys && !keys.includes(key))) ||
    (keys && ownKeys.length !== keys.length)
  ) {
    throw referenceError();
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value
  ) {
    throw referenceError();
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) throw referenceError();
  }
  return value;
}

function parseBinding(value: unknown): SpackMaterialReferenceBinding {
  const binding = record(value, ["repositoryId", "manifestDigest"]);
  const repositoryId = boundedString(binding.repositoryId, 64);
  const manifestDigest = boundedString(binding.manifestDigest, 71);
  if (!/^[a-f0-9]{64}$/.test(repositoryId) || !/^sha256:[a-f0-9]{64}$/.test(manifestDigest)) {
    throw referenceError();
  }
  return { repositoryId, manifestDigest };
}

function parseOperation(value: unknown): SpackMaterialOperationReferenceInput {
  const input = record(value, [
    "operationId",
    "agentId",
    "requestedBy",
    "spec",
    "repositoryId",
    "manifestDigest",
  ]);
  const operationId = boundedString(input.operationId, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(operationId)) {
    throw referenceError();
  }
  return {
    operationId: operationId.toLowerCase(),
    agentId: boundedString(input.agentId, 255),
    requestedBy: boundedString(input.requestedBy, 255),
    spec: boundedString(input.spec, 500),
    ...parseBinding({ repositoryId: input.repositoryId, manifestDigest: input.manifestDigest }),
  };
}

function referenceError() {
  // Never attach a database error as a cause or expose its SQL/parameters.
  return Object.assign(new Error("Spack material reference operation failed"), {
    code: "SPACK_MATERIAL_REFERENCE_ERROR" as const,
  });
}
