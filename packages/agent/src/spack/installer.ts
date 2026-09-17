import type { InstalledSpec, SpackPolicy } from "@kuintessence/shared";
import type { SpackCli } from "./cli";
import { getInstalledList, parseSpackFindJson } from "./installed";
import { decidePolicy } from "./policy";

/**
 * Outcome of a `requestInstall` call. Discriminated union so callers can
 * pattern-match on `outcome` without losing context fields.
 */
export type InstallOutcome =
  | { outcome: "rejected"; reason: string }
  | { outcome: "installed"; stdout: string }
  | { outcome: "failed"; exitCode: number; stderr: string };

export type SoftwareOperationOutcome =
  | { outcome: "rejected"; reason: string }
  | { outcome: "succeeded"; stdout: string; installed: InstalledSpec[] }
  | { outcome: "failed"; exitCode: number; stderr: string };

/**
 * Orchestrator that combines the policy decision engine with the Spack CLI.
 *
 * The cache is in-memory only by design. Server-side software governance receives
 * the authoritative installed ledger from explicit operation refreshes.
 */
export class SpackInstaller {
  private installedCache: InstalledSpec[] | undefined;

  constructor(private readonly cli: SpackCli) {}

  async requestInstall(spec: string, policy: SpackPolicy): Promise<InstallOutcome> {
    const decision = decidePolicy(spec, policy);
    if (decision !== "allow") {
      return { outcome: "rejected", reason: decision.reject };
    }
    const result = await this.cli.install(spec);
    if (result.exitCode !== 0) {
      return { outcome: "failed", exitCode: result.exitCode, stderr: failureOutput(result) };
    }
    // Best-effort cache refresh. Failure here doesn't roll back the
    // install; surface it via cachedInstalled returning the previous value
    // (or undefined on a cold-start failure).
    try {
      this.installedCache = await getInstalledList(this.cli);
    } catch {
      // Swallow — the install succeeded, the next refreshInstalled() call
      // can retry. We deliberately don't log here; caller wraps with logger.
    }
    return { outcome: "installed", stdout: result.stdout };
  }

  async installAndRefresh(spec: string, policy: SpackPolicy): Promise<SoftwareOperationOutcome> {
    const decision = decidePolicy(spec, policy);
    if (decision !== "allow") {
      return { outcome: "rejected", reason: decision.reject };
    }
    const result = await this.cli.install(spec);
    if (result.exitCode !== 0) {
      return { outcome: "failed", exitCode: result.exitCode, stderr: failureOutput(result) };
    }
    const refresh = await this.refreshInstalledAfterMutation();
    if (!refresh.ok) {
      return {
        outcome: "failed",
        exitCode: 0,
        stderr: `spack install succeeded but installed ledger refresh failed: ${refresh.error}`,
      };
    }
    return { outcome: "succeeded", stdout: result.stdout, installed: refresh.installed };
  }

  async uninstallAndRefresh(spec: string, policy: SpackPolicy): Promise<SoftwareOperationOutcome> {
    const decision = decidePolicy(spec, policy);
    if (decision !== "allow") {
      return { outcome: "rejected", reason: decision.reject };
    }
    const result = await this.cli.uninstall(spec);
    if (result.exitCode !== 0) {
      return { outcome: "failed", exitCode: result.exitCode, stderr: failureOutput(result) };
    }
    const refresh = await this.refreshInstalledAfterMutation();
    if (!refresh.ok) {
      return {
        outcome: "failed",
        exitCode: 0,
        stderr: `spack uninstall succeeded but installed ledger refresh failed: ${refresh.error}`,
      };
    }
    return { outcome: "succeeded", stdout: result.stdout, installed: refresh.installed };
  }

  async loadShell(spec: string, policy: SpackPolicy): Promise<SoftwareOperationOutcome> {
    const decision = decidePolicy(spec, policy);
    if (decision !== "allow") {
      return { outcome: "rejected", reason: decision.reject };
    }
    const result = await this.cli.loadShell(spec);
    if (result.exitCode !== 0) {
      return { outcome: "failed", exitCode: result.exitCode, stderr: failureOutput(result) };
    }
    return {
      outcome: "succeeded",
      stdout: result.stdout,
      installed: this.installedCache ?? [],
    };
  }

  async importPreinstalled(spec: string): Promise<SoftwareOperationOutcome> {
    const result = await this.cli.findJson(spec);
    if (result.exitCode !== 0) {
      return { outcome: "failed", exitCode: result.exitCode, stderr: failureOutput(result) };
    }
    let matched: InstalledSpec[];
    try {
      matched = parseSpackFindJson(result.stdout);
    } catch (err) {
      return {
        outcome: "failed",
        exitCode: 0,
        stderr: `spack find --json ${spec} returned invalid JSON: ${errorMessage(err)}`,
      };
    }
    if (matched.length === 0) {
      return { outcome: "rejected", reason: `${spec} is not present in this Spack installation` };
    }
    const refresh = await this.refreshInstalledAfterMutation();
    if (!refresh.ok) {
      return {
        outcome: "failed",
        exitCode: 0,
        stderr: `preinstalled import matched but installed ledger refresh failed: ${refresh.error}`,
      };
    }
    return { outcome: "succeeded", stdout: result.stdout, installed: refresh.installed };
  }

  /** Force a cache refresh via `spack find --json`. */
  async refreshInstalled(): Promise<InstalledSpec[]> {
    const list = await getInstalledList(this.cli);
    this.installedCache = list;
    return list;
  }

  /** Last-known installed list, or undefined if never populated. */
  cachedInstalled(): InstalledSpec[] | undefined {
    return this.installedCache;
  }

  private async refreshInstalledAfterMutation(): Promise<
    { ok: true; installed: InstalledSpec[] } | { ok: false; error: string }
  > {
    try {
      return { ok: true, installed: await this.refreshInstalled() };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failureOutput(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim();
}
