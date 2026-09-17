import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Stage the compiled `kq` binary as a Tauri externalBin sidecar.
 *
 * Tauri resolves `externalBin: ["binaries/kq"]` to `binaries/kq-<target-triple>`,
 * so the binary must be named with the host's Rust target triple. We read the
 * triple from `rustc -vV` (the authoritative source Tauri itself uses) rather
 * than guessing from `process.platform`/`process.arch`.
 *
 * Prerequisite: `packages/cli/dist/kq` already built (gui:bundle runs the CLI
 * build first). Run standalone with: `bun run scripts/gui-prepare-sidecar.ts`.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_BINARY = join(REPO_ROOT, "packages/cli/dist/kq");
const SIDECAR_DIR = join(REPO_ROOT, "gui/src-tauri/binaries");

function hostTargetTriple(): string {
  const proc = Bun.spawnSync(["rustc", "-vV"]);
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    throw new Error(`rustc -vV failed (is Rust installed?): ${stderr || `exit ${proc.exitCode}`}`);
  }
  const stdout = proc.stdout.toString();
  const match = stdout.match(/^host:\s*(\S+)$/m);
  if (match?.[1] === undefined) {
    throw new Error(`Could not parse host triple from rustc -vV output:\n${stdout}`);
  }
  return match[1];
}

function main(): void {
  if (!existsSync(CLI_BINARY)) {
    throw new Error(
      `CLI binary not found at ${CLI_BINARY}. Build it first: bun run --filter @kuintessence/cli build`,
    );
  }

  const triple = hostTargetTriple();
  const dest = join(SIDECAR_DIR, `kq-${triple}`);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(CLI_BINARY, dest);
  chmodSync(dest, 0o755);

  console.log(`Staged sidecar: ${dest}`);
}

main();
