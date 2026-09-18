import type { InstalledSpec, MirrorSpec, SpackPolicy } from "@kuintessence/shared";
import type { Spawner } from "../adapters/base";
import { Buildcache, type ExportOutcome, type ImportResult } from "./buildcache";
import { MANAGED_SPACK_EXECUTION_DISABLED, SpackCli } from "./cli";
import type { SpackManagedInstallation } from "./install-contract";
import { type InstallOutcome, type SoftwareOperationOutcome, SpackInstaller } from "./installer";
import type {
  PreparedSpackMaterials,
  SpackMaterialContext,
  SpackMaterialProvider,
} from "./material-client";
import { preflightSpackMaterials } from "./material-preflight";
import { type MirrorDelta, MirrorManager } from "./mirror-manager";
import { decidePolicy } from "./policy";
import type { SpackMaterialAuditor } from "./source-auditor";

export type { ExportOutcome, ImportResult } from "./buildcache";
export { Buildcache } from "./buildcache";
export type { SpackCliOptions, SpackCliResult } from "./cli";
export { SpackCli } from "./cli";
export { getInstalledList, parseSpackFindJson } from "./installed";
export type { InstallOutcome } from "./installer";
export { SpackInstaller } from "./installer";
export type {
  PreparedSpackMaterials,
  SpackMaterialContext,
  SpackMaterialPrepareInput,
  SpackMaterialProvider,
} from "./material-client";
export { configureSpackMaterialClient, SpackMaterialClient } from "./material-client";
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
  /** Required on platform Agents; standalone/embedded callers retain legacy behavior. */
  requireServerMaterials?: boolean;
  materialClient?: SpackMaterialProvider;
  materialAuditor?: SpackMaterialAuditor;
  managedInstallation?: SpackManagedInstallation;
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
  readonly requireServerMaterials: boolean;
  readonly available: boolean;
  readonly version: string | undefined;
  readonly installer: SpackInstaller | undefined;
  readonly mirrorManager: MirrorManager | undefined;
  readonly buildcache: Buildcache | undefined;
  private readonly cli: SpackCli | undefined;
  private appliedPolicyVersion: string | undefined;
  private cachedPolicy: SpackPolicy | undefined;
  private readonly materialClient: SpackMaterialProvider | undefined;
  private readonly materialAuditor: SpackMaterialAuditor | undefined;
  private readonly managedInstallation: SpackManagedInstallation | undefined;

  private constructor(args: {
    available: boolean;
    version?: string;
    cli?: SpackCli;
    installer?: SpackInstaller;
    mirrorManager?: MirrorManager;
    buildcache?: Buildcache;
    requireServerMaterials?: boolean;
    materialClient?: SpackMaterialProvider;
    materialAuditor?: SpackMaterialAuditor;
    managedInstallation?: SpackManagedInstallation;
  }) {
    this.available = args.available;
    this.version = args.version;
    this.cli = args.cli;
    this.installer = args.installer;
    this.mirrorManager = args.mirrorManager;
    this.buildcache = args.buildcache;
    this.requireServerMaterials = args.requireServerMaterials ?? false;
    this.materialClient = args.materialClient;
    this.materialAuditor = args.materialAuditor;
    this.managedInstallation = args.managedInstallation;
  }

  static async bootstrap(options: SpackManagerBootstrapOptions = {}): Promise<SpackManager> {
    if (options.enabled === false) {
      return new SpackManager({
        available: false,
        requireServerMaterials: options.requireServerMaterials,
      });
    }
    const cli = new SpackCli({
      spawner: options.spawner,
      binary: options.binary,
      requireServerMaterials: options.requireServerMaterials,
    });
    let probe: { exitCode: number; stdout: string; stderr: string };
    try {
      probe = await cli.version();
    } catch {
      // Spawner threw (e.g. ENOENT in CI). Fail soft.
      return new SpackManager({
        available: false,
        requireServerMaterials: options.requireServerMaterials,
      });
    }
    if (probe.exitCode !== 0) {
      return new SpackManager({
        available: false,
        requireServerMaterials: options.requireServerMaterials,
      });
    }
    const version = probe.stdout.trim().split(/\s+/)[0] ?? "unknown";
    return new SpackManager({
      available: true,
      version,
      cli,
      installer: new SpackInstaller(cli),
      mirrorManager: new MirrorManager(cli),
      buildcache: new Buildcache(cli),
      requireServerMaterials: options.requireServerMaterials,
      materialClient: options.materialClient,
      materialAuditor: options.materialAuditor,
      managedInstallation: options.requireServerMaterials ? options.managedInstallation : undefined,
    });
  }

  /** Refresh and return the installed-list. Throws when unavailable. */
  async installedList(): Promise<InstalledSpec[]> {
    if (!this.installer) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    const legacy = await this.installer.refreshInstalled();
    const managed = (await this.managedInstallation?.installedList()) ?? [];
    return [...new Map([...legacy, ...managed].map((entry) => [entry.hash, entry])).values()];
  }

  /** Convenience: try to install one spec under the given policy. */
  async requestInstall(spec: string, policy: SpackPolicy): Promise<InstallOutcome> {
    if (!this.installer) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    if (this.requireServerMaterials) {
      return { outcome: "rejected", reason: MANAGED_SPACK_EXECUTION_DISABLED };
    }
    return this.installer.requestInstall(spec, policy);
  }

  async runSoftwareOperation(
    action: SoftwareOperationAction,
    spec: string,
    materials?: SpackMaterialContext,
  ): Promise<SoftwareOperationOutcome> {
    if (!this.installer) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    if (this.managedInstallation && action !== "install") {
      const result = await this.managedInstallation.operation(
        action,
        spec,
        this.cachedPolicy ?? { lockEnabled: false },
      );
      if (result) return this.withLegacyInventory(result);
    }
    switch (action) {
      case "install":
        if (this.requireServerMaterials) return this.prepareManagedInstall(spec, materials);
        return this.installer.installAndRefresh(spec, this.cachedPolicy ?? { lockEnabled: false });
      case "uninstall":
        return this.withManagedInventory(
          await this.installer.uninstallAndRefresh(
            spec,
            this.cachedPolicy ?? { lockEnabled: false },
          ),
        );
      case "load":
        return this.installer.loadShell(spec, this.cachedPolicy ?? { lockEnabled: false });
      case "import_preinstalled":
        return this.withManagedInventory(await this.installer.importPreinstalled(spec));
    }
  }

  private async prepareManagedInstall(
    spec: string,
    context?: SpackMaterialContext,
  ): Promise<SoftwareOperationOutcome> {
    const policyRejection = this.policyRejectionForOperation("install", spec);
    if (policyRejection) return { outcome: "rejected", reason: policyRejection };
    if (!context?.operationId || !context.ticket || !context.manifestDigest) {
      return {
        outcome: "rejected",
        reason: "managed Spack install requires a Server material ticket and manifest digest",
      };
    }
    if (!this.materialClient || !this.version) {
      return { outcome: "rejected", reason: "managed Spack material client is not configured" };
    }
    let prepared: PreparedSpackMaterials;
    try {
      prepared = await this.materialClient.prepare({
        operationId: context.operationId,
        ticket: context.ticket,
        manifestDigest: context.manifestDigest,
        spec,
        spackVersion: this.version,
      });
    } catch (error) {
      return {
        outcome: "failed",
        exitCode: 1,
        stderr: `Spack material preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      const report = await preflightSpackMaterials(prepared, {
        operationId: context.operationId,
        ticket: context.ticket,
        manifestDigest: context.manifestDigest,
        spec,
        spackVersion: this.version,
      });
      if (!report.valid) {
        return {
          outcome: "failed",
          exitCode: 1,
          stderr: `Spack lock preflight failed: ${report.diagnostics
            .filter((item) => item.severity === "error")
            .map((item) => `${item.code}: ${item.message}`)
            .join("; ")}`,
        };
      }
    } catch (error) {
      return {
        outcome: "failed",
        exitCode: 1,
        stderr: `Spack material preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (this.materialAuditor) {
      try {
        const report = await this.materialAuditor.audit(prepared, {
          operationId: context.operationId,
          ticket: context.ticket,
          manifestDigest: context.manifestDigest,
          spec,
          spackVersion: this.version,
        });
        if (!report.passed) {
          return {
            outcome: "failed",
            exitCode: 1,
            stderr: `Spack source audit failed: ${report.issues
              .filter((issue) => issue.severity === "error")
              .map((issue) => issue.code)
              .join("; ")}`,
          };
        }
        if (this.managedInstallation) {
          return this.withLegacyInventory(
            await this.managedInstallation.install(prepared, {
              operationId: context.operationId,
              ticket: context.ticket,
              manifestDigest: context.manifestDigest,
              spec,
              spackVersion: this.version,
            }),
          );
        }
        return {
          outcome: "rejected",
          reason: MANAGED_SPACK_EXECUTION_DISABLED,
          stdout: JSON.stringify(report),
        };
      } catch {
        return {
          outcome: "failed",
          exitCode: 1,
          stderr: "Spack source audit could not complete in the configured isolated runtime",
        };
      }
    }
    return { outcome: "rejected", reason: MANAGED_SPACK_EXECUTION_DISABLED };
  }

  private async withLegacyInventory(
    result: SoftwareOperationOutcome,
  ): Promise<SoftwareOperationOutcome> {
    if (result.outcome !== "succeeded" || !this.installer) return result;
    try {
      const legacy = await this.installer.refreshInstalled();
      return {
        ...result,
        installed: [
          ...new Map([...legacy, ...result.installed].map((entry) => [entry.hash, entry])).values(),
        ],
      };
    } catch {
      return {
        outcome: "failed",
        exitCode: 1,
        stderr: "Spack operation completed but installed inventory refresh failed",
        ...(result.invalidatedHashes ? { invalidatedHashes: result.invalidatedHashes } : {}),
      };
    }
  }

  private async withManagedInventory(
    result: SoftwareOperationOutcome,
  ): Promise<SoftwareOperationOutcome> {
    if (result.outcome !== "succeeded" || !this.managedInstallation) return result;
    try {
      const managed = await this.managedInstallation.installedList();
      return {
        ...result,
        installed: [
          ...new Map(
            [...result.installed, ...managed].map((entry) => [entry.hash, entry]),
          ).values(),
        ],
      };
    } catch {
      return {
        outcome: "failed",
        exitCode: 1,
        stderr: "Spack operation completed but managed inventory refresh failed",
      };
    }
  }

  policyRejectionForOperation(action: SoftwareOperationAction, spec: string): string | null {
    if (action === "import_preinstalled") return null;
    if (this.managedInstallation && action !== "install") return null;
    const decision = decidePolicy(spec, this.cachedPolicy ?? { lockEnabled: false });
    return decision === "allow" ? null : decision.reject;
  }

  /** Convenience: reconcile mirror config push from Server. */
  async applyMirrors(desired: MirrorSpec[]): Promise<MirrorDelta> {
    if (this.requireServerMaterials) throw new Error("managed Spack upstream mirrors are disabled");
    if (!this.mirrorManager) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    return this.mirrorManager.applyMirrors(desired);
  }

  /** Convenience: import a CP-distributed buildcache batch. */
  async importBuildcache(specs: string[]): Promise<ImportResult> {
    if (this.requireServerMaterials) throw new Error(MANAGED_SPACK_EXECUTION_DISABLED);
    if (!this.buildcache) {
      throw new Error("SpackManager: spack is unavailable on this Agent");
    }
    return this.buildcache.importBuildcache(specs);
  }

  /** Convenience: push a locally-built spec to a mirror. */
  async exportBuildcache(spec: string, mirror: string): Promise<ExportOutcome> {
    if (this.requireServerMaterials) throw new Error(MANAGED_SPACK_EXECUTION_DISABLED);
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
      if (
        !this.requireServerMaterials &&
        input.mirrors &&
        input.mirrors.length > 0 &&
        this.mirrorManager
      ) {
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
