import type { InstalledSpec } from "@kuintessence/shared";
import type { SpackCli } from "./cli";

/**
 * Raw shape of one entry from `spack find --json`. Spack emits richer fields
 * (parameters, package_hash, namespace, dependencies, …) but we project only
 * what the platform reasons about. Unknown fields are ignored.
 */
interface RawSpackFindEntry {
  name?: unknown;
  version?: unknown;
  hash?: unknown;
  spec?: unknown;
  arch?:
    | {
        platform?: unknown;
        platform_os?: unknown;
        target?: unknown;
      }
    | unknown;
  compiler?:
    | {
        name?: unknown;
        version?: unknown;
      }
    | unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function flattenArch(raw: RawSpackFindEntry["arch"]): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as { platform?: unknown; platform_os?: unknown; target?: unknown };
  const platform = asString(a.platform);
  const platformOs = asString(a.platform_os);
  const target = asString(a.target);
  const parts = [platform, platformOs, target].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join("-") : undefined;
}

function flattenCompiler(raw: RawSpackFindEntry["compiler"]): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as { name?: unknown; version?: unknown };
  const name = asString(c.name);
  const version = asString(c.version);
  if (!name) return undefined;
  return version ? `${name}@${version}` : name;
}

/**
 * Parse `spack find --json` output into a normalized `InstalledSpec[]`.
 *
 * Behaviors:
 *  - Every entry must contain `name`, `version`, and `hash`. A partial
 *    snapshot must never be published as authoritative empty inventory.
 *  - `spec` is derived as `name@version[%compiler]` when not provided.
 *  - Throws on invalid JSON, non-array top-level, or invalid entries.
 */
export function parseSpackFindJson(stdout: string): InstalledSpec[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("parseSpackFindJson: expected top-level array");
  }
  const result: InstalledSpec[] = [];
  for (const raw of parsed as RawSpackFindEntry[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("parseSpackFindJson: invalid installed entry");
    }
    const name = asString(raw?.name);
    const version = asString(raw?.version);
    const hash = asString(raw?.hash);
    if (!name || !version || !hash) {
      throw new Error("parseSpackFindJson: invalid installed entry");
    }
    const compiler = flattenCompiler(raw?.compiler);
    const arch = flattenArch(raw?.arch);
    const explicitSpec = asString(raw?.spec);
    const synthesized = compiler ? `${name}@${version}%${compiler}` : `${name}@${version}`;
    result.push({
      name,
      version,
      hash,
      spec: explicitSpec ?? synthesized,
      ...(compiler ? { compiler } : {}),
      ...(arch ? { arch } : {}),
    });
  }
  return result;
}

/**
 * High-level: shell out to `spack find --json`, parse, return installed list.
 *
 * Throws when the CLI itself fails (exit != 0) so the caller can decide
 * whether to mark Spack unavailable. CLI argument errors propagate as
 * exceptions; incomplete or malformed inventories also fail the whole snapshot.
 */
export async function getInstalledList(cli: SpackCli): Promise<InstalledSpec[]> {
  const r = await cli.findJson();
  if (r.exitCode !== 0) {
    throw new Error(`spack find --json failed (exit ${r.exitCode}): ${r.stderr}`);
  }
  return parseSpackFindJson(r.stdout);
}
