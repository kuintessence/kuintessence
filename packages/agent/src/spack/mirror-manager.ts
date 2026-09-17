import type { MirrorSpec } from "@kuintessence/shared";
import type { SpackCli } from "./cli";

/**
 * Result of an `applyMirrors` reconciliation pass. Tells the caller exactly
 * which mirrors were added vs. already present vs. failed to add — useful
 * for the audit log when a CP pushes a mirror config update via Server.
 */
export interface MirrorDelta {
  added: string[];
  alreadyPresent: string[];
  failed: Array<{ name: string; url: string; stderr: string; exitCode: number }>;
}

/**
 * Parse `spack mirror list` output into a `name -> url` map.
 *
 * Real spack emits whitespace-separated columns, but the column count varies
 * by version:
 *  - older: `<name>   <url>`                       (2 columns)
 *  - spack 1.0.x: `<name> [<flags>] <url>`         (3 columns; flags bracketed)
 *
 * The name is always the first token and the url is always the last token, so
 * we anchor on those and treat anything in between (the `[sb]` access flags)
 * as ignorable. Lines with fewer than two tokens are skipped silently.
 */
export function parseMirrorList(stdout: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // Spack prefixes status/heading lines with `==>` (e.g. a "no mirrors
    // configured" notice). Without this guard such a line would be tokenised
    // into a phantom mirror (name `==>`, url = last word).
    if (line.startsWith("==>")) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const name = tokens[0];
    const url = tokens[tokens.length - 1];
    if (name && url) result.set(name, url);
  }
  return result;
}

/**
 * Reconciles a desired `MirrorSpec[]` against `spack mirror list` output:
 * adds whichever entries are new, no-ops on already-present entries, and
 * collects per-mirror failure details so the caller can surface them.
 *
 * NOT a full sync — does not REMOVE mirrors that were once added but are
 * no longer in the desired set. Mirror retirement needs an explicit operation.
 */
export class MirrorManager {
  constructor(private readonly cli: SpackCli) {}

  /**
   * Read the currently-registered mirrors as a `name -> url` map. Throws on a
   * `spack mirror list` CLI failure so the all-in-one CLI can surface the
   * error (unlike `applyMirrors`, which treats a list miss as "no mirrors" to
   * keep a reconcile pass moving).
   */
  async list(): Promise<Map<string, string>> {
    const r = await this.cli.mirrorList();
    if (r.exitCode !== 0) {
      throw new Error(`spack mirror list failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    return parseMirrorList(r.stdout);
  }

  /** Register one mirror. Throws on a non-zero exit so the caller surfaces it. */
  async add(name: string, url: string): Promise<void> {
    const r = await this.cli.mirrorAdd(name, url);
    if (r.exitCode !== 0) {
      throw new Error(`spack mirror add ${name} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
  }

  /** Deregister one mirror. Throws on a non-zero exit so the caller surfaces it. */
  async remove(name: string): Promise<void> {
    const r = await this.cli.mirrorRemove(name);
    if (r.exitCode !== 0) {
      throw new Error(`spack mirror rm ${name} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
  }

  async applyMirrors(desired: MirrorSpec[]): Promise<MirrorDelta> {
    const existing = await this.listExisting();
    const delta: MirrorDelta = { added: [], alreadyPresent: [], failed: [] };

    for (const spec of desired) {
      if (existing.has(spec.name)) {
        delta.alreadyPresent.push(spec.name);
        continue;
      }
      const r = await this.cli.mirrorAdd(spec.name, spec.url);
      if (r.exitCode === 0) {
        delta.added.push(spec.name);
      } else {
        delta.failed.push({
          name: spec.name,
          url: spec.url,
          stderr: r.stderr,
          exitCode: r.exitCode,
        });
      }
    }
    return delta;
  }

  private async listExisting(): Promise<Map<string, string>> {
    const r = await this.cli.mirrorList();
    if (r.exitCode !== 0) {
      // Treat list failure as "no mirrors known" — the worst case is we
      // try to add an existing mirror, which Spack reports as "already
      // exists" via stderr and we route into `failed`. Better than
      // throwing and aborting the whole reconcile pass.
      return new Map();
    }
    return parseMirrorList(r.stdout);
  }
}
