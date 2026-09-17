import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDataDir } from "@kuintessence/agent/embedded";
import type { Command } from "commander";

export interface MigrateResult {
  copied: boolean;
  from: string;
  to: string;
}

/**
 * Relocate the all-in-one local job database by copying `<from>/local.db` →
 * `<to>/local.db`. Only the job DB is moved — the CLI config/auth token lives in
 * `~/.kq/config.json` and must stay put, so the whole directory is deliberately
 * NOT copied. The source is left in place (copy, never delete). Re-running
 * overwrites an existing target file, which is acceptable for a manual command.
 * Filesystem effect only — no `process.exit`.
 */
export function migrateLocalDb(from: string, to: string): MigrateResult {
  const fromDb = join(from, "local.db");
  const toDb = join(to, "local.db");
  if (!existsSync(fromDb)) {
    return { copied: false, from: fromDb, to: toDb };
  }
  mkdirSync(to, { recursive: true });
  copyFileSync(fromDb, toDb);
  return { copied: true, from: fromDb, to: toDb };
}

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("All-in-one local configuration");

  config
    .command("migrate")
    .description("Relocate the local job database (copies local.db, does not delete the source)")
    .option("--from <path>", "Source data directory (default ~/.kq, the legacy location)")
    .option("--to <path>", "Target data directory (default ~/.kuintessence)")
    .action((opts: { from?: string; to?: string }) => {
      const from = opts.from ?? join(homedir(), ".kq");
      const to =
        opts.to ??
        resolveDataDir({ form: "tui", home: homedir(), env: process.env.KUINTESSENCE_HOME });
      const result = migrateLocalDb(from, to);
      if (result.copied) {
        console.log(`Migrated local job database:\n  from ${result.from}\n  to   ${result.to}`);
        console.log(
          "Only the job database was moved; your CLI config and auth token remain in ~/.kq.",
        );
      } else {
        console.log(`Nothing to migrate: ${result.from} does not exist.`);
      }
    });
}
