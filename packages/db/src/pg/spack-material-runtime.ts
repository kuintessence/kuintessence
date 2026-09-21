import { desc } from "drizzle-orm";
import type { PgDb } from "./index";
import { spackMaterialRollouts } from "./schema-spack-materials";
import { parseSpackMaterialEpoch } from "./spack-material-rollout-input";

type ReadConnection = Pick<PgDb, "select">;

export function isSpackMaterialReady(phase: string): boolean {
  return phase === "ready" || phase === "policy-ready";
}

export function isSpackMaterialPaused(phase: string): boolean {
  return phase === "paused" || phase === "policy-paused";
}

export function isSpackMaterialPolicyPhase(phase: string): boolean {
  return phase === "policy-ready" || phase === "policy-paused";
}

export async function readSpackMaterialRollout(db: ReadConnection) {
  const [row] = await db
    .select()
    .from(spackMaterialRollouts)
    .orderBy(desc(spackMaterialRollouts.revision))
    .limit(1);
  if (
    row &&
    (!Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      (!isSpackMaterialPaused(row.phase) && !isSpackMaterialReady(row.phase)) ||
      (row.phase === "ready" && (row.action !== "activate" || !row.evidence)) ||
      (row.phase === "policy-ready" &&
        ((row.action !== "activate" && row.action !== "activate-policy") ||
          !row.evidence ||
          row.evidence.legacyProcessesStoppedAndDrained !== true ||
          row.evidence.legacyAccessRevoked !== true ||
          row.evidence.legacyInventoryComplete !== true)))
  ) {
    throw new Error("Invalid Spack material rollout state");
  }
  return row;
}

/** Fresh admission check, not cancellation of previously admitted streams or jobs. */
export async function assertSpackMaterialRuntime(db: ReadConnection, epoch?: string) {
  const expectedEpoch = epoch === undefined ? undefined : parseSpackMaterialEpoch(epoch);
  const row = await readSpackMaterialRollout(db);
  if (!row && expectedEpoch === undefined) return;
  if (!row || !isSpackMaterialReady(row.phase) || row.epoch !== expectedEpoch) {
    throw new Error("Spack material runtime is fenced");
  }
}
