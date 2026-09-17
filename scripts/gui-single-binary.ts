/**
 * Build the single-binary GUI: compile `kq` with the SPA embedded.
 *
 * Steps: build the SPA → codegen `embedded-spa.ts` from `packages/web/dist` →
 * `bun build --compile` (captures the populated module). The embed module is
 * committed EMPTY, so it is ALWAYS restored afterwards (try/finally) — even on
 * a mid-build failure — to keep the working tree clean. The real build exit
 * code is propagated, so a failed web/CLI build fails this script (the `git
 * checkout` restore must not mask it).
 */
const EMBED_MODULE = "packages/cli/src/gui-serve/embedded-spa.ts";

const STEPS: string[][] = [
  ["bun", "run", "--filter", "@kuintessence/web", "build"],
  ["bun", "run", "scripts/gui-embed-spa.ts"],
  ["bun", "run", "--filter", "@kuintessence/cli", "build"],
];

async function run(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await proc.exited;
}

let code = 0;
try {
  for (const step of STEPS) {
    code = await run(step);
    if (code !== 0) break;
  }
} finally {
  await run(["git", "checkout", "--", EMBED_MODULE]);
}

process.exit(code);
