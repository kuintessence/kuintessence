import { federationWorkflowBindings, type PgDb, type PgTransaction } from "@kuintessence/db";
import { WorkflowExecutionInterrupted } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { federationExecutionSnapshot, loadFederationWorkflowBinding } from "./execution-binding";
import type { FederationPreparationService } from "./preparation";

/** Reauthorize every delivery; the returned check holds local revocations through channel enqueue. */
export class FederationDispatchAuthorization {
  constructor(
    private readonly db: PgDb,
    private readonly preparation: FederationPreparationService,
  ) {}

  async prepare(runId: string): Promise<(tx: PgTransaction) => Promise<void>> {
    const binding = await loadFederationWorkflowBinding(this.db, runId);
    if (!binding)
      throw new WorkflowExecutionInterrupted("Federation dispatch lacks its saved binding", {
        retryable: false,
      });
    // External software authorization happens outside the final delivery transaction.
    const current = await this.preparation.executionSnapshot(binding.reservationId);
    if (federationMaterialDigest(federationExecutionSnapshot(current)) !== binding.snapshotDigest)
      throw new FederationError("OPERATION_CONFLICT");
    return async (tx) => {
      await tx
        .select({ id: federationWorkflowBindings.reservationId })
        .from(federationWorkflowBindings)
        .where(eq(federationWorkflowBindings.workflowRunId, runId))
        .for("share");
      const saved = await loadFederationWorkflowBinding(tx, runId);
      if (
        !saved ||
        saved.reservationId !== binding.reservationId ||
        saved.snapshotDigest !== binding.snapshotDigest
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.preparation.lockExecutionSnapshot(tx, current);
    };
  }
}
