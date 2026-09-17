import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_DIR = join(homedir(), ".kq");
const DEFAULT_CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface CliConfig {
  serverUrl: string;
  token?: string;
  expiresAt?: string;
}

const DEFAULT_CONFIG: CliConfig = {
  serverUrl: "http://localhost:3000",
};

/**
 * Resolve the active CLI config file path.
 * Honors KQ_CONFIG_FILE env var for tests and multi-profile workflows.
 */
function resolveConfigFile(): string {
  const fromEnv = process.env.KQ_CONFIG_FILE;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_CONFIG_FILE;
}

export function loadCliConfig(path?: string): CliConfig {
  const target = path ?? resolveConfigFile();
  if (!existsSync(target)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const content = readFileSync(target, "utf-8");
    const parsed = JSON.parse(content) as Partial<CliConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveCliConfig(config: CliConfig, path?: string): void {
  const target = path ?? resolveConfigFile();
  const dir = dirname(target);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // The config holds the auth token. On a shared HPC login node a default
  // (umask-derived, typically world-readable) file would leak it, so force
  // owner-only perms. `mode` on writeFileSync only applies when creating the
  // file, so chmod after to also tighten a pre-existing file. (chmod is a
  // no-op on platforms without POSIX modes, e.g. Windows — acceptable.)
  writeFileSync(target, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  chmodSync(target, 0o600);
}

export function getActiveConfigPath(): string {
  return resolveConfigFile();
}

/** @deprecated Use getActiveConfigPath() instead. */
export const CONFIG_FILE_PATH = DEFAULT_CONFIG_FILE;
