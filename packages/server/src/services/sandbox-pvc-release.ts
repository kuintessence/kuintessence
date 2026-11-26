import { type jobs, type PgTransaction, sandboxPvcReleases } from "@kuintessence/db";
import { SandboxSignedManifestSchema } from "@kuintessence/shared";
export async function enqueueTerminalSandboxPvc(
  tx: PgTransaction,
  job: Pick<typeof jobs.$inferSelect, "id" | "agentId" | "sandboxExecution">,
) {
  if (!job.agentId || !job.sandboxExecution) return;
  const manifest = SandboxSignedManifestSchema.safeParse(job.sandboxExecution);
  if (
    manifest.success &&
    manifest.data.runtime.kind === "OCI" &&
    manifest.data.mounts.some((mount) => mount.mode === "WriteOnly" || !mount.inlineContentBase64)
  )
    await tx
      .insert(sandboxPvcReleases)
      .values({ jobId: job.id, agentId: job.agentId })
      .onConflictDoNothing();
}
