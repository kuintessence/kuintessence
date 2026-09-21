import { desc } from "drizzle-orm";
import type { PgDb } from "./index";
import { spackMaterialRollouts } from "./schema-spack-materials";
import { parseSpackMaterialEpoch } from "./spack-material-rollout-input";

type ReadConnection = Pick<PgDb, "select">;

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
      (row.phase !== "paused" && row.phase !== "ready") ||
      (row.phase === "ready" && (row.action !== "activate" || !row.evidence)))
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
  if (!row || row.phase !== "ready" || row.epoch !== expectedEpoch) {
    throw new Error("Spack material runtime is fenced");
  }
}
