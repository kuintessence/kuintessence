import { createLogger } from "@kuintessence/shared";
import { realSpawner, type SchedulerAdapter, type Spawner } from "./base";
import { K8sAdapter, type K8sAdapterDeps } from "./k8s";
import { PbsProAdapter, type PbsProAdapterDeps } from "./pbs-pro";
import { SlurmAdapter, type SlurmAdapterDeps } from "./slurm";
import { TorqueAdapter, type TorqueAdapterDeps } from "./torque";

const logger = createLogger("adapter-detect");

export interface DetectOptions {
  spawner?: Spawner;
  /** Force a specific adapter type (skip auto-detect). */
  forceType?: "slurm" | "pbs-pro" | "torque" | "kubernetes";
  /** Force a specific version string when forceType is set. */
  forceVersion?: string;
  /**
   * Extra deps forwarded verbatim to SlurmAdapter when it is constructed.
   */
  slurmDeps?: Omit<SlurmAdapterDeps, "spawner">;
  pbsProDeps?: Omit<PbsProAdapterDeps, "spawner">;
  torqueDeps?: Omit<TorqueAdapterDeps, "spawner">;
  k8sDeps?: Omit<K8sAdapterDeps, "spawner">;
}

/**
 * Detect the local scheduler and return a matching adapter.
 *
 * Detection order: Slurm -> PBS Pro -> Torque -> Kubernetes
 *
 * The first scheduler whose CLI is reachable wins. Callers can skip
 * detection entirely by passing `forceType`.
 */
export async function detectScheduler(options: DetectOptions = {}): Promise<SchedulerAdapter> {
  const spawner = options.spawner ?? realSpawner;
  const slurmDeps = options.slurmDeps ?? {};
  const pbsProDeps = options.pbsProDeps ?? {};
  const torqueDeps = options.torqueDeps ?? {};

  // ── Forced override ──────────────────────────────────────────────────────
  if (options.forceType) {
    const v = options.forceVersion ?? "0.0.0";
    switch (options.forceType) {
      case "slurm":
        return new SlurmAdapter(v, { spawner, ...slurmDeps });
      case "pbs-pro":
        return new PbsProAdapter(v, { spawner, ...pbsProDeps });
      case "torque":
        return new TorqueAdapter(v, { spawner, ...torqueDeps });
      case "kubernetes":
        return new K8sAdapter(v, { spawner, ...options.k8sDeps });
    }
  }

  // ── Slurm ────────────────────────────────────────────────────────────────
  try {
    const r = await spawner.run(["sbatch", "--version"]);
    if (r.exitCode === 0) {
      const version = r.stdout.trim().replace(/^slurm(?:-wlm)?\s+/i, "");
      logger.info({ version }, "Detected Slurm");
      return new SlurmAdapter(version, { spawner, ...slurmDeps });
    }
  } catch {
    // sbatch not on PATH — continue
  }

  // ── PBS Pro / Torque ─────────────────────────────────────────────────────
  // Both use qsub. Distinguish by the --version output:
  //   PBS Pro: "pbs_version = X.Y.Z"
  //   Torque:  "Version: X.Y.Z" or just "X.Y.Z"
  try {
    const r = await spawner.run(["qsub", "--version"]);
    if (r.exitCode === 0) {
      const out = r.stdout.toLowerCase();
      const versionMatch = r.stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
      const version = versionMatch?.[1] ?? "0.0";

      if (out.includes("pbs_version") || out.includes("pbspro")) {
        logger.info({ version }, "Detected PBS Pro");
        return new PbsProAdapter(version, { spawner, ...pbsProDeps });
      }
      // Torque: "Version: X" line, or just a version number
      logger.info({ version }, "Detected Torque");
      return new TorqueAdapter(version, { spawner, ...torqueDeps });
    }
  } catch {
    // qsub not on PATH — continue
  }

  // ── Kubernetes ───────────────────────────────────────────────────────────
  try {
    const r = await spawner.run(["kubectl", "version", "--client", "-o", "json"]);
    if (r.exitCode === 0) {
      let version = "0.0";
      try {
        const v = JSON.parse(r.stdout) as {
          clientVersion?: { gitVersion?: string };
        };
        version = v.clientVersion?.gitVersion ?? "0.0";
      } catch {
        // non-JSON kubectl output — use default version string
      }
      logger.info({ version }, "Detected Kubernetes");
      return new K8sAdapter(version, { spawner, ...options.k8sDeps });
    }
  } catch {
    // kubectl not on PATH — continue
  }

  throw new Error(
    "No supported scheduler detected. Install Slurm (sbatch), PBS Pro/Torque (qsub), or Kubernetes (kubectl).",
  );
}
