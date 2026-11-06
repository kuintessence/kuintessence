import {
  federationWorkflowBindings,
  type PgDb,
  type PgTransaction,
  workflowRuns,
} from "@kuintessence/db";
import { extractRunGraph, WorkflowPlacementConfigSchema } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { and, eq, type SQL } from "drizzle-orm";
import { stringify } from "yaml";
import { parseWorkflowYaml } from "../workflow/parser";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { federationMaterialDigest } from "./assets";
import type { FederationDispatchAuthorization } from "./dispatch-authorization";
import type { FederationExecutionPreparation, FederationPreparationService } from "./preparation";

export function federationExecutionSnapshot(prepared: FederationExecutionPreparation) {
  // Projection removes foreign IDs with undefined; persist only its JSON meaning.
  const snapshot: typeof federationWorkflowBindings.$inferInsert.snapshot = JSON.parse(
    JSON.stringify({
      request: prepared.request,
      requestDigest: prepared.saved.reservation.requestDigest,
      identity: prepared.identity,
      ...prepared.projection,
      ...prepared.material,
      mappings: prepared.mappings,
      executionTargets: prepared.saved.agreement.terms.executionTargets ?? [],
    }),
  );
  return snapshot;
}

/** Creates a held run and immutable receiver projection, never queues or dispatches it. */
export class FederationExecutionBindingService {
  constructor(
    private readonly db: PgDb,
    private readonly preparation: FederationPreparationService,
  ) {}

  async stage(reservationId: string) {
    const prior = await readBinding(
      this.db,
      eq(federationWorkflowBindings.reservationId, reservationId),
    );
    if (prior) return prior;
    const prepared = await this.preparation.executionSnapshot(reservationId);
    const snapshot = federationExecutionSnapshot(prepared);
    const snapshotDigest = federationMaterialDigest(snapshot);
    return this.db.transaction(async (tx) => {
      await this.preparation.lockExecutionSnapshot(tx, prepared);
      const existing = await readBinding(
        tx,
        eq(federationWorkflowBindings.reservationId, reservationId),
      );
      if (existing) {
        if (existing.snapshotDigest !== snapshotDigest)
          throw new FederationError("OPERATION_CONFLICT");
        return existing;
      }
      const workflowRunId = await new WorkflowRunRegistry(this.db).createRun(
        snapshot.workflow.name,
        snapshot.identity.userId,
        extractRunGraph(snapshot.workflow),
        {
          executionModel: "durable-v2",
          federationReservationId: reservationId,
          yaml: stringify(snapshot.workflow),
          role: "user",
          orgId: snapshot.identity.orgId,
          placementConfig: WorkflowPlacementConfigSchema.parse({}),
        },
        null,
        tx,
      );
      const [binding] = await tx
        .insert(federationWorkflowBindings)
        .values({ reservationId, workflowRunId, snapshot, snapshotDigest })
        .returning();
      if (!binding) throw new Error("Federation workflow binding was not saved");
      return binding;
    });
  }
}

async function readBinding(db: PgDb | PgTransaction, condition: SQL) {
  const [saved] = await db
    .select({ binding: federationWorkflowBindings, run: workflowRuns })
    .from(federationWorkflowBindings)
    .innerJoin(workflowRuns, eq(workflowRuns.id, federationWorkflowBindings.workflowRunId))
    .where(condition);
  if (!saved) return null;
  const { binding, run } = saved;
  const { snapshot } = binding;
  if (
    federationMaterialDigest(snapshot) !== binding.snapshotDigest ||
    run.input?.federationReservationId !== binding.reservationId ||
    run.input.executionModel !== "durable-v2" ||
    run.input.role !== "user" ||
    run.input.orgId !== snapshot.identity.orgId ||
    run.submittedBy !== snapshot.identity.userId ||
    federationMaterialDigest(JSON.parse(JSON.stringify(parseWorkflowYaml(run.input.yaml)))) !==
      federationMaterialDigest(snapshot.workflow)
  )
    throw new FederationError("OPERATION_CONFLICT");
  return binding;
}

/** Normal runs have no binding; a lost or mismatched federation marker is never ignored. */
export async function loadFederationWorkflowBinding(db: PgDb | PgTransaction, runId: string) {
  const binding = await readBinding(db, eq(federationWorkflowBindings.workflowRunId, runId));
  if (binding) return binding;
  const [run] = await db
    .select({ input: workflowRuns.input })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId));
  if (run?.input?.federationReservationId) throw new FederationError("OPERATION_CONFLICT");
  return null;
}

/** Queue only the original held run; per-Job authorization remains mandatory at dispatch. */
export async function queueFederationWorkflow(
  db: PgDb,
  authorization: Pick<FederationDispatchAuthorization, "prepare">,
  runId: string,
): Promise<boolean> {
  const authorize = await authorization.prepare(runId);
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .for("update");
    if (!run || run.status !== "submitted") return false;
    await authorize(tx);
    const now = new Date();
    const queued = await tx
      .update(workflowRuns)
      .set({ status: "queued", queuedAt: now, updatedAt: now })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "submitted")))
      .returning({ id: workflowRuns.id });
    return queued.length === 1;
  });
}
