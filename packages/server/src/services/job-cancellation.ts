import {
  jobCancellations,
  type jobs,
  type PgDb,
  type PgTransaction,
  softwareOperations,
} from "@kuintessence/db";
import { eq, sql } from "drizzle-orm";

export async function enqueueJobCancellation(
  db: PgDb | PgTransaction,
  input: {
    agentId: string;
    jobId: string;
    revokedEpoch: number;
    requiresInstallationStop?: boolean;
  },
) {
  if (!Number.isSafeInteger(input.revokedEpoch) || input.revokedEpoch < 0)
    throw new Error("Invalid cancellation epoch");
  const requiresStop = input.requiresInstallationStop ?? false;
  await db
    .insert(jobCancellations)
    .values(input)
    .onConflictDoUpdate({
      target: [jobCancellations.jobId, jobCancellations.agentId],
      set: {
        revokedEpoch: sql`greatest(${jobCancellations.revokedEpoch}, ${input.revokedEpoch})`,
        requiresInstallationStop: sql`${jobCancellations.requiresInstallationStop} or ${requiresStop}`,
        acknowledgedAt: sql`case when ${jobCancellations.revokedEpoch} >= ${input.revokedEpoch}
        and (${jobCancellations.requiresInstallationStop} or not ${requiresStop})
        then ${jobCancellations.acknowledgedAt} else null end`,
      },
    });
}

/** Caller holds the Job row lock; install creation also requires that lock and pending status. */
export async function persistJobCancellations(
  tx: PgTransaction,
  job: Pick<typeof jobs.$inferSelect, "id" | "agentId" | "status" | "revokedEpoch">,
  includeCompute = true,
) {
  const installers = await tx
    .selectDistinct({ agentId: softwareOperations.agentId })
    .from(softwareOperations)
    .where(eq(softwareOperations.federationJobId, job.id));
  const targets = new Map(installers.map(({ agentId }) => [agentId, true]));
  if (
    includeCompute &&
    job.agentId &&
    job.status !== "completed" &&
    job.status !== "failed" &&
    !targets.has(job.agentId)
  )
    targets.set(job.agentId, false);
  for (const [agentId, requiresInstallationStop] of targets)
    await enqueueJobCancellation(tx, {
      jobId: job.id,
      agentId,
      revokedEpoch: job.revokedEpoch,
      requiresInstallationStop,
    });
}
