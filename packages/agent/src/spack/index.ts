import type { InstalledSpec, MirrorSpec, SpackPolicy } from "@kuintessence/shared";
import type { Spawner } from "../adapters/base";
import { Buildcache, type ExportOutcome, type ImportResult } from "./buildcache";
import { SpackCli } from "./cli";
import { type InstallOutcome, type SoftwareOperationOutcome, SpackInstaller } from "./installer";
import { type MirrorDelta, MirrorManager } from "./mirror-manager";
import { decidePolicy } from "./policy";

export type { ExportOutcome, ImportResult } from "./buildcache";
export { Buildcache } from "./buildcache";
export type { SpackCliOptions, SpackCliResult } from "./cli";
export { SpackCli } from "./cli";
export { getInstalledList, parseSpackFindJson } from "./installed";
export type { InstallOutcome } from "./installer";
export { SpackInstaller } from "./installer";
export type { MirrorDelta } from "./mirror-manager";
export { MirrorManager, parseMirrorList } from "./mirror-manager";
export { decidePolicy, matchesPattern } from "./policy";

export interface SpackManagerBootstrapOptions {
  /** Spawner abstraction. Tests inject a mock; production uses `realSpawner`. */
  spawner?: Spawner;
  /** Path to the spack binary. Defaults to `spack` (must be on PATH). */
  binary?: string;
  /**
   * Master switch. When `false` (default in config), bootstrap returns an
   * unavailable manager without ever shelling out. Lets the Agent run in
   * Spack-less environments (CI, k8s, edge) without spurious "spack not
   * found" log spam.
   */
  enabled?: boolean;
}

/**
 * Top-level orchestrator that composes CLI / installer / mirror manager /
 * buildcache. The Agent bootstrap path will eventually do:
 *
 *   const spack = await SpackManager.bootstrap(config);
 *   if (spack.available) {
 *     const installed = await spack.installedList();
 *     await streamClient.reportInstalledSoftware(installed);
 *   }
 *
 * but that wiring is deferred to a follow-up commit (depends on a new proto
 * field for the heartbeat). See TODO in `packages/agent/src/index.ts`.
 *
 * `available` reflects whether `spack --version` succeeded at boot time.
 * On `available=false`, the submodules are deliberately undefined so a
 * caller cannot accidentally invoke a missing CLI.
 */
/**
 * Server-pushed policy bundle. Mirrors the proto `SoftwarePolicyUpdate` shape;
 * the agent stores the latest applied version so a re-pushed identical
 * policy is a no-op (idempotency by `policyVersion` string compare).
 */
export interface PolicyApplyInput {
  policyVersion: string;
  lockEnabled: boolean;
  allowList?: string[];
  denyList?: string[];
  mirrors?: MirrorSpec[];
  preinstallList?: string[];
}

/** Outcome of `applyPolicy`. Mirrors proto `SoftwarePolicyAck`. */
export interface PolicyApplyAck {
  policyVersion: string;
  applied: boolean;
  error?: string;
}

export type SoftwareOperationAction = "install" | "uninstall" | "load" | "import_preinstalled";

export class SpackManager {
  readonly available: boolean;
  readonly version: string | undefined;
  readonly installer: SpackInstaller | undefined;
  readonly mirrorManager: MirrorManager | undefined;
  readonly buildcache: Buildcache | undefined;
  private readonly cli: SpackCli | undefined;
  private appliedPolicyVersion: string | undefined;
  private cachedPolicy: SpackPolicy | undefined;

  private constructor(args: {
    available: boolean;
    version?: string;
    cli?: SpackCli;
    installer?: SpackInstaller;
    mirrorManager?: MirrorManager;
    buildcache?: Buildcache;
  }) {
    this.available = args.available;
    this.version = args.version;
    this.cli = args.cli;
    this.installer = args.installer;
    this.mirrorManager = args.mirrorManager;
    this.buildcache = args.buildcache;
  }

  static async bootstrap(options: SpackManagerBootstrapOptions = {}): Promise<SpackManager> {
    if (options.enabled === false) {
      return new SpackManager({ available: false });
    }
    const cli = new SpackCli({ spawner: options.spawner, binary: options.binary });
    let probe: { exitCode: number; stdout: string; stderr: string };
    try {
      probe = await cli.version();
    } catch {
      // Spawner threw (e.g. ENOENT in CI). Fail soft.
      return new SpackManager({ available: false });
    }
    if (probe.exitCode !== 0) {
      return new SpackManager({ available: false });
    }
    const version = probe.stdout.trim().split(/\s+/)[0] ?? "unknown";
    return new SpackManager({
      available: true,
      version,
      cli,
      installer: new SpackInstaller(cli),
      mirrorManager: new MirrorManager(cli),
      buildcache: new Buildcache(cli),
    });
  }

  /** Refresh and return the installed-list. Throws when unavailable. */
  async installedList(): Promise<InstalledSpec[]> {
    if (!this.installer) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    return this.installer.refreshInstalled();
  }

  /** Convenience: try to install one spec under the given policy. */
  async requestInstall(spec: string, policy: SpackPolicy): Promise<InstallOutcome> {
    if (!this.installer) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    return this.installer.requestInstall(spec, policy);
  }

  async runSoftwareOperation(
    action: SoftwareOperationAction,
    spec: string,
  ): Promise<SoftwareOperationOutcome> {
    if (!this.installer) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    switch (action) {
      case "install":
        return this.installer.installAndRefresh(spec, this.cachedPolicy ?? { lockEnabled: false });
      case "uninstall":
        return this.installer.uninstallAndRefresh(
          spec,
          this.cachedPolicy ?? { lockEnabled: false },
        );
      case "load":
        return this.installer.loadShell(spec, this.cachedPolicy ?? { lockEnabled: false });
      case "import_preinstalled":
        return this.installer.importPreinstalled(spec);
    }
  }

  policyRejectionForOperation(action: SoftwareOperationAction, spec: string): string | null {
    if (action === "import_preinstalled") return null;
    const decision = decidePolicy(spec, this.cachedPolicy ?? { lockEnabled: false });
    return decision === "allow" ? null : decision.reject;
  }

  /** Convenience: reconcile mirror config push from Server. */
  async applyMirrors(desired: MirrorSpec[]): Promise<MirrorDelta> {
    if (!this.mirrorManager) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    return this.mirrorManager.applyMirrors(desired);
  }

  /** Convenience: import a CP-distributed buildcache batch. */
  async importBuildcache(specs: string[]): Promise<ImportResult> {
    if (!this.buildcache) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    return this.buildcache.importBuildcache(specs);
  }

  /** Convenience: push a locally-built spec to a mirror. */
  async exportBuildcache(spec: string, mirror: string): Promise<ExportOutcome> {
    if (!this.buildcache) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    return this.buildcache.exportBuildcache(spec, mirror);
  }

  /**
   * Apply a Server-pushed software policy. Idempotent on `policyVersion` so
   * a Server re-broadcast of the same version (multi-Server deployment, agent
   * reconnect) skips the work and just acks the identical version.
   *
   * Order:
   *  1. If policyVersion equals the last applied version → ack "applied"
   *     immediately. This is the primary anti-stomp guard described in the
   *     C2 plan: even if the Server forgets we already applied, our local
   *     ledger keeps the apply count to one-per-version.
   *  2. If a mirrors list is provided, reconcile via `applyMirrors`.
   *  3. Cache the (lockEnabled, allow/deny) bundle so future
   *     `requestInstall` calls can reach for it via `currentPolicy()`.
   *  4. Stamp `appliedPolicyVersion` and return `applied=true`.
   *
   * On `available=false` we ack `applied=false` with an explanatory error
   * — the Server records the gap and operators can reconcile manually.
   */
  async applyPolicy(input: PolicyApplyInput): Promise<PolicyApplyAck> {
    if (!this.available) {
      return {
        policyVersion: input.policyVersion,
        applied: false,
        error: "spack is unavailable on this Agent",
      };
    }
    if (this.appliedPolicyVersion === input.policyVersion) {
      return { policyVersion: input.policyVersion, applied: true };
    }
    try {
      if (input.mirrors && input.mirrors.length > 0 && this.mirrorManager) {
        await this.mirrorManager.applyMirrors(input.mirrors);
      }
      this.cachedPolicy = {
        lockEnabled: input.lockEnabled,
        allowList: input.allowList,
        denyList: input.denyList,
      };
      this.appliedPolicyVersion = input.policyVersion;
      return { policyVersion: input.policyVersion, applied: true };
    } catch (err) {
      return {
        policyVersion: input.policyVersion,
        applied: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Last-applied policy bundle (read-only snapshot). Undefined before first apply. */
  currentPolicy(): SpackPolicy | undefined {
    return this.cachedPolicy;
  }

  /** Last-applied policy version string (read-only). Undefined before first apply. */
  currentPolicyVersion(): string | undefined {
    return this.appliedPolicyVersion;
  }
}
