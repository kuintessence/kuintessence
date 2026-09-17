import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../index.ts");

/**
 * Every always-local / `--local` command validates `--scheduler` BEFORE its
 * no-scheduler catch, so a bad value reports parseScheduler's own "Unknown
 * scheduler …" message instead of being dressed up as a missing-scheduler-CLI
 * failure (the "Ensure a scheduler CLI on PATH" hint, which doesn't apply to a
 * typo'd scheduler name and can't be fixed by dropping `--local`).
 */
const INVOCATIONS: Array<{ name: string; args: string[] }> = [
  { name: "list", args: ["list", "--local", "--scheduler", "nope"] },
  { name: "status", args: ["status", "j1", "--local", "--scheduler", "nope"] },
  { name: "cancel", args: ["cancel", "j1", "--local", "--scheduler", "nope"] },
  { name: "logs", args: ["logs", "j1", "--local", "--scheduler", "nope"] },
  { name: "submit", args: ["submit", "/no/such/spec.json", "--local", "--scheduler", "nope"] },
];

describe("local command --scheduler validation routing", () => {
  for (const { name, args } of INVOCATIONS) {
    it(`kq ${name} reports a bad --scheduler value cleanly, not as a missing-scheduler failure`, async () => {
      const proc = Bun.spawn(["bun", "run", CLI, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await proc.exited;
      const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;

      expect(exit).toBe(1);
      expect(out).toContain('Unknown scheduler "nope"');
      expect(out).not.toContain("Ensure a scheduler CLI");
      expect(out).not.toContain("(local):");
    }, 30_000);
  }
});
