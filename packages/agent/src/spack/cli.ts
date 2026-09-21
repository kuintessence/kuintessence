import { realSpawner, type Spawner } from "../adapters/base";

/**
 * Result of a single Spack CLI invocation. Mirrors the `Spawner.run` shape.
 *
 * We deliberately do not throw on non-zero exit codes — Spack returns
 * non-zero for normal "policy violation" / "spec already installed" / "no
 * such mirror" cases and the orchestrating layer must inspect stderr to
 * make sense of the failure.
 */
export interface SpackCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpackCliOptions {
  /** Spawner abstraction. Defaults to the real `Bun.spawn` wrapper. */
  spawner?: Spawner;
  /** Path to the spack binary. Defaults to `spack` (must be on PATH). */
  binary?: string;
  /** Platform-managed mode never executes network-capable installation commands. */
  requireServerMaterials?: boolean;
}

export const MANAGED_SPACK_EXECUTION_DISABLED =
  "managed offline Spack execution is not enabled yet";

/**
 * Thin typed wrapper around `Bun.spawn(['spack', ...])`.
 *
 * Each public method returns a `SpackCliResult` with stdout/stderr captured.
 * Argument validation throws synchronously for programmer errors (empty
 * required strings); CLI-level failures are reported via `exitCode != 0`.
 *
 * The wrapper does not parse output. Parsing is the responsibility of the
 * higher-level modules (`installed.ts`, `mirror-manager.ts`).
 */
export class SpackCli {
  readonly requireServerMaterials: boolean;
  private readonly spawner: Spawner;
  private readonly binary: string;

  constructor(options: SpackCliOptions = {}) {
    this.spawner = options.spawner ?? realSpawner;
    this.binary = options.binary ?? "spack";
    this.requireServerMaterials = options.requireServerMaterials ?? false;
  }

  assertNetworkExecutionAllowed(): void {
    if (this.requireServerMaterials) throw new Error(MANAGED_SPACK_EXECUTION_DISABLED);
  }

  /** `spack --version` — used as the boot-time probe. */
  version(): Promise<SpackCliResult> {
    return this.spawner.run([this.binary, "--version"]);
  }

  /** `spack find --json [spec]` — installed-list dump, optionally filtered by spec. */
  findJson(spec?: string): Promise<SpackCliResult> {
    if (spec !== undefined && spec.length === 0) {
      throw new Error("SpackCli.findJson: spec must be non-empty when provided");
    }
    return this.spawner.run(
      spec === undefined ? [this.binary, "find", "--json"] : [this.binary, "find", "--json", spec],
    );
  }

  /** `spack install --yes <spec>` — on-demand install. */
  async install(spec: string): Promise<SpackCliResult> {
    this.assertNetworkExecutionAllowed();
    if (!spec || spec.length === 0) {
      throw new Error("SpackCli.install: spec must be non-empty");
    }
    return this.spawner.run([this.binary, "install", "--yes", spec]);
  }

  /** `spack uninstall --yes <spec>` — remove an installed spec. */
  async uninstall(spec: string): Promise<SpackCliResult> {
    if (!spec || spec.length === 0) {
      throw new Error("SpackCli.uninstall: spec must be non-empty");
    }
    return this.spawner.run([this.binary, "uninstall", "--yes", spec]);
  }

  /** `spack load --sh <spec>` — validate loadability and return shell snippet. */
  async loadShell(spec: string): Promise<SpackCliResult> {
    if (!spec || spec.length === 0) {
      throw new Error("SpackCli.loadShell: spec must be non-empty");
    }
    return this.spawner.run([this.binary, "load", "--sh", spec]);
  }

  /** `spack mirror add <name> <url>` — register a mirror. */
  async mirrorAdd(name: string, url: string): Promise<SpackCliResult> {
    this.assertNetworkExecutionAllowed();
    if (!name || name.length === 0) {
      throw new Error("SpackCli.mirrorAdd: name must be non-empty");
    }
    if (!url || url.length === 0) {
      throw new Error("SpackCli.mirrorAdd: url must be non-empty");
    }
    return this.spawner.run([this.binary, "mirror", "add", name, url]);
  }

  /** `spack mirror list` — enumerate registered mirrors. */
  mirrorList(): Promise<SpackCliResult> {
    return this.spawner.run([this.binary, "mirror", "list"]);
  }

  /** `spack mirror rm <name>` — deregister a mirror. */
  async mirrorRemove(name: string): Promise<SpackCliResult> {
    if (!name || name.length === 0) {
      throw new Error("SpackCli.mirrorRemove: name must be non-empty");
    }
    return this.spawner.run([this.binary, "mirror", "rm", name]);
  }

  /**
   * `spack buildcache push --keys none --rebuild-index <mirror> <spec>`.
   *
   * `--keys none` does not require GPG signing. `--rebuild-index`
   * keeps the mirror's index consistent so `buildcache install` from
   * elsewhere can find it.
   */
  async buildcachePush(mirror: string, spec: string): Promise<SpackCliResult> {
    this.assertNetworkExecutionAllowed();
    if (!mirror || mirror.length === 0) {
      throw new Error("SpackCli.buildcachePush: mirror must be non-empty");
    }
    if (!spec || spec.length === 0) {
      throw new Error("SpackCli.buildcachePush: spec must be non-empty");
    }
    return this.spawner.run([
      this.binary,
      "buildcache",
      "push",
      "--keys",
      "none",
      "--rebuild-index",
      mirror,
      spec,
    ]);
  }

  /** `spack buildcache install <spec>` — consume a prebuilt buildcache. */
  async buildcacheInstall(spec: string): Promise<SpackCliResult> {
    this.assertNetworkExecutionAllowed();
    if (!spec || spec.length === 0) {
      throw new Error("SpackCli.buildcacheInstall: spec must be non-empty");
    }
    return this.spawner.run([this.binary, "buildcache", "install", spec]);
  }
}
