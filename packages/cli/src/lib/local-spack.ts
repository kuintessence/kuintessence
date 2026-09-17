import {
  type ExportOutcome,
  type ImportResult,
  type InstallOutcome,
  realSpawner,
  SpackManager,
  type Spawner,
} from "@kuintessence/agent/embedded";
import type { InstalledSpec, SpackPolicy } from "@kuintessence/shared";

/**
 * Permissive policy for the all-in-one (Form 2, no Server) software surface. The
 * local user is their own administrator, so there is no install lock and no
 * deny/allow list — `decidePolicy` resolves every spec to "allow". Form 1
 * (daemon + Server) keeps using the Server-pushed `SpackPolicy` instead.
 */
export const LOCAL_POLICY: SpackPolicy = { lockEnabled: false };

export interface LocalSpackOptions {
  /** Spawner abstraction. Tests inject a mock; production uses `realSpawner`. */
  spawner?: Spawner;
  /** Path to the spack binary. Defaults to `spack` (must be on PATH). */
  binary?: string;
}

/**
 * Bootstrap the embedded `SpackManager` for `kq software ... --local`. Throws a
 * friendly one-liner (caught by the command handler → exit 1) when spack is not
 * on PATH, mirroring `localSchedulerErrorMessage`.
 */
export async function localSpack(opts: LocalSpackOptions = {}): Promise<SpackManager> {
  const manager = await SpackManager.bootstrap({
    spawner: opts.spawner ?? realSpawner,
    binary: opts.binary,
  });
  if (!manager.available) {
    throw new Error(
      "spack not found on PATH; install Spack or run against a Server (without --local)",
    );
  }
  return manager;
}

/** Format a `kq software ... --local` failure as a clean one-liner (no stack). */
export function localSpackErrorMessage(command: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `kq software ${command} (local): ${msg}`;
}

/** Render the installed-spec table (NAME/VERSION/SPEC). Pure + exported for testing. */
export function formatInstalledTable(specs: InstalledSpec[]): string {
  if (specs.length === 0) return "No software installed.";
  const lines = ["NAME\tVERSION\tSPEC"];
  for (const s of specs) {
    lines.push(`${s.name}\t${s.version}\t${s.spec}`);
  }
  return lines.join("\n");
}

/**
 * Render an install outcome. The boolean signals the exit code: a non-"installed"
 * outcome is a failure (exit 1). Pure + exported for testing.
 */
export function formatInstallOutcome(
  spec: string,
  outcome: InstallOutcome,
): { text: string; ok: boolean } {
  switch (outcome.outcome) {
    case "installed":
      return { text: `Installed ${spec}.`, ok: true };
    case "rejected":
      return { text: `Rejected ${spec}: ${outcome.reason}`, ok: false };
    case "failed":
      return {
        text: `Install of ${spec} failed (exit ${outcome.exitCode}): ${outcome.stderr.trim()}`,
        ok: false,
      };
  }
}

/** Render a `name -> url` mirror map as a table. Pure + exported for testing. */
export function formatMirrorList(mirrors: Map<string, string>): string {
  if (mirrors.size === 0) return "No mirrors configured.";
  const lines = ["NAME\tURL"];
  for (const [name, url] of mirrors) {
    lines.push(`${name}\t${url}`);
  }
  return lines.join("\n");
}

/**
 * Render a buildcache import result. The boolean signals the exit code: any
 * failed spec makes the batch a failure (exit 1). Pure + exported for testing.
 */
export function formatImportResult(result: ImportResult): { text: string; ok: boolean } {
  const lines: string[] = [];
  if (result.installed.length > 0) {
    lines.push(`Installed from buildcache: ${result.installed.join(", ")}`);
  }
  for (const f of result.failed) {
    lines.push(`Failed ${f.spec} (exit ${f.exitCode}): ${f.stderr.trim()}`);
  }
  if (lines.length === 0) lines.push("Nothing to install.");
  return { text: lines.join("\n"), ok: result.failed.length === 0 };
}

/** Render a buildcache push outcome. Pure + exported for testing. */
export function formatExportOutcome(
  spec: string,
  mirror: string,
  outcome: ExportOutcome,
): { text: string; ok: boolean } {
  if (outcome.outcome === "pushed") {
    return { text: `Pushed ${spec} to ${mirror}.`, ok: true };
  }
  return {
    text: `Push of ${spec} to ${mirror} failed (exit ${outcome.exitCode}): ${outcome.stderr.trim()}`,
    ok: false,
  };
}
