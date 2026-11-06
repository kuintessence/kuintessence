import {
  federationWorkflowBindings,
  type PgDb,
  type PgTransaction,
  workflowRuns,
} from "@kuintessence/db";
import { extractRunGraph, WorkflowPlacementConfigSchema } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import { stringify } from "yaml";
import { parseWorkflowYaml } from "../workflow/parser";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { federationMaterialDigest } from "./assets";
import type { FederationPreparationService } from "./preparation";

/** Creates a held run and immutable receiver projection, never queues or dispatches it. */
export class FederationExecutionBindingService {
  constructor(
    private readonly db: PgDb,
    private readonly preparation: FederationPreparationService,
  ) {}

  async stage(reservationId: string) {
    const prior = await this.find(this.db, reservationId);
    if (prior) return prior;
    const prepared = await this.preparation.executionSnapshot(reservationId);
    // Projection deliberately removes foreign IDs with undefined; store only its JSON meaning.
    const snapshot: typeof federationWorkflowBindings.$inferInsert.snapshot = JSON.parse(
      JSON.stringify({
        request: prepared.request,
        requestDigest: prepared.saved.reservation.requestDigest,
        identity: prepared.identity,
        ...prepared.projection,
        ...prepared.material,
        mappings: prepared.mappings,
      }),
    );
    const snapshotDigest = federationMaterialDigest(snapshot);
    return this.db.transaction(async (tx) => {
      await this.preparation.lockExecutionSnapshot(tx, prepared);
      const existing = await this.find(tx, reservationId);
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

  private async find(db: PgDb | PgTransaction, reservationId: string) {
    const [saved] = await db
      .select({ binding: federationWorkflowBindings, run: workflowRuns })
      .from(federationWorkflowBindings)
      .innerJoin(workflowRuns, eq(workflowRuns.id, federationWorkflowBindings.workflowRunId))
      .where(eq(federationWorkflowBindings.reservationId, reservationId));
    if (!saved) return null;
    const { binding, run } = saved;
    const { snapshot } = binding;
    if (
      federationMaterialDigest(snapshot) !== binding.snapshotDigest ||
      run.input?.federationReservationId !== reservationId ||
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
}
