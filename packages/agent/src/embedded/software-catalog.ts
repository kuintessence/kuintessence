import type { InstalledSpec } from "@kuintessence/shared";
import type { Spawner } from "../adapters/base";
import { parseSpackFindJson } from "../spack/installed";

export interface SoftwareEntry extends InstalledSpec {
  source: "spack" | "module";
}

export interface LocalSoftwareCatalogDeps {
  spawner: Spawner;
}

/**
 * Read-only probe for a login node's software stack. Detects `spack` and
 * environment `module` (Lmod) availability and lists installed Spack software.
 * No install/buildcache/mirror operations. Server-free: only
 * depends on the {@link Spawner} process abstraction so it stays testable.
 */
export class LocalSoftwareCatalog {
  constructor(private readonly deps: LocalSoftwareCatalogDeps) {}

  async detect(): Promise<{ spack: boolean; modules: boolean }> {
    const [spack, modules] = await Promise.all([
      this.probe(["spack", "--version"]),
      this.probe(["module", "--version"]),
    ]);
    return { spack, modules };
  }

  async listInstalled(): Promise<SoftwareEntry[]> {
    if (!(await this.probe(["spack", "--version"]))) return [];
    const result = await this.runSafe(["spack", "find", "--json"]);
    if (!result || result.exitCode !== 0) return [];
    return parseSpackFind(result.stdout);
  }

  private async probe(command: string[]): Promise<boolean> {
    const result = await this.runSafe(command);
    return result?.exitCode === 0;
  }

  private async runSafe(
    command: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string } | undefined> {
    try {
      return await this.deps.spawner.run(command);
    } catch {
      return undefined;
    }
  }
}

function parseSpackFind(stdout: string): SoftwareEntry[] {
  try {
    return parseSpackFindJson(stdout).map((entry) => ({ ...entry, source: "spack" }));
  } catch {
    return [];
  }
}
