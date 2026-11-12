import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SpackAuditProcess } from "./audit-process";
import { SpackInstallStore } from "./install-store";
import { confirmSlurmSpackWorkerStopped } from "./slurm-process";

/** Run on the original login host, after the former Agent has stopped. */
export async function recoverSlurmSpackInstallation(options: {
  storeRoot: string;
  cacheDir: string;
  recordId: string;
  operationId: string;
  binDir?: string;
  transport?: SpackAuditProcess;
}): Promise<void> {
  const runs = join(await realpath(options.cacheDir), "installs");
  const store = new SpackInstallStore(options.storeRoot);
  await store.reconcileWorker({
    recordId: options.recordId,
    operationId: options.operationId,
    confirmStopped: async (stagingPath, record) => {
      if (
        !/^run-[A-Za-z0-9]+$/.test(stagingPath.slice(runs.length + 1)) ||
        !stagingPath.startsWith(`${runs}/`) ||
        (await realpath(stagingPath)) !== stagingPath
      ) {
        throw new Error("Spack recovery staging path does not belong to the configured cache");
      }
      return await confirmSlurmSpackWorkerStopped(
        stagingPath,
        {
          manifestDigest: record.manifestDigest,
          siteProfileDigest: record.siteProfileDigest,
          storePath: store.path(record.id),
          ...(record.state === "verifying" ? { action: "verify" as const } : {}),
        },
        options.transport,
        options.binDir,
      );
    },
  });
}

if (import.meta.main) {
  const [storeRoot, cacheDir, recordId, operationId, binDir, ...extra] = Bun.argv.slice(2);
  if (!storeRoot || !cacheDir || !recordId || !operationId || extra.length) {
    console.error(
      "Usage: bun run packages/agent/src/spack/recover-slurm-worker.ts STORE_ROOT CACHE_DIR RECORD_UUID ORIGINAL_OPERATION_UUID [SLURM_BIN_DIR]",
    );
    process.exitCode = 1;
  } else {
    try {
      await recoverSlurmSpackInstallation({ storeRoot, cacheDir, recordId, operationId, binDir });
      console.log(
        "Worker reconciled. Partial release remains failed and unpublished. Retry the identical install to independently verify reusable dependencies; readiness still requires full verification.",
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Spack recovery failed");
      process.exitCode = 1;
    }
  }
}
