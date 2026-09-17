import type { SpackCli } from "./cli";

/**
 * Aggregate outcome of an `importBuildcache` call. Per-spec results are kept
 * in `installed` / `failed` so a partial failure surfaces every bad spec
 * with stderr context — useful for the audit log.
 */
export interface ImportResult {
  installed: string[];
  failed: Array<{ spec: string; exitCode: number; stderr: string }>;
}

/**
 * Outcome of a single `exportBuildcache` call. Discriminated union so the
 * caller can pattern-match on `outcome` without losing context fields.
 */
export type ExportOutcome =
  | { outcome: "pushed" }
  | { outcome: "failed"; exitCode: number; stderr: string };

/**
 * Buildcache import/export wrapper.
 *
 * Scope:
 *  - `importBuildcache(specs)`: receive a CP-distributed buildcache by
 *    invoking `spack buildcache install` per spec; isolates per-spec
 *    failures so one bad spec does not abort the batch.
 *  - `exportBuildcache(spec, mirror)`: push a locally-built spec to a
 *    named mirror.
 *
 * Not handled by this wrapper:
 *  - GPG key enrollment + `--keys` strict signing
 *  - Mirror auth (S3 credentials, HTTP basic, etc.)
 *  - Concurrent imports: specs are imported sequentially with isolated failures.
 */
export class Buildcache {
  constructor(private readonly cli: SpackCli) {}

  async importBuildcache(specs: string[]): Promise<ImportResult> {
    const result: ImportResult = { installed: [], failed: [] };
    for (const spec of specs) {
      const r = await this.cli.buildcacheInstall(spec);
      if (r.exitCode === 0) {
        result.installed.push(spec);
      } else {
        result.failed.push({ spec, exitCode: r.exitCode, stderr: r.stderr });
      }
    }
    return result;
  }

  async exportBuildcache(spec: string, mirror: string): Promise<ExportOutcome> {
    const r = await this.cli.buildcachePush(mirror, spec);
    if (r.exitCode === 0) return { outcome: "pushed" };
    return { outcome: "failed", exitCode: r.exitCode, stderr: r.stderr };
  }
}
