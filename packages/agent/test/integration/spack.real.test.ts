import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SpackPolicy } from "@kuintessence/shared";
import { SpackManager } from "../../src/spack";
import {
  dockerAvailable,
  type SpackContainer,
  startSpackContainer,
} from "../fixtures/spack-container";

// ---------------------------------------------------------------------------
// Real-Spack container e2e. Proves SpackManager (the full-control embedded
// wrapper) drives REAL spack inside a container — not a mocked Spawner.
//
// Parsing/logic is already covered by the unit suite (mocked Spawner). This
// file exercises the live command paths: `spack --version`, `spack find
// --json`, `spack mirror add/list/rm`, `spack buildcache list`, and the
// `spack install` invocation itself.
//
// Skips cleanly when Docker is unavailable so `bun run test:unit` stays green
// on machines without a daemon. (This file lives under packages/agent/test,
// which only runs under `bun run test:integration`, but the guard also makes
// an ad-hoc invocation safe.)
// ---------------------------------------------------------------------------

const HAS_DOCKER = await dockerAvailable();
const describeOrSkip = HAS_DOCKER ? describe : describe.skip;

let container: SpackContainer;
let manager: SpackManager;

// Image pull is large and a fresh container boot + spack probe take time;
// give the suite a generous boot budget.
beforeAll(async () => {
  if (!HAS_DOCKER) return;
  container = await startSpackContainer();
  manager = await SpackManager.bootstrap({
    spawner: container.spawner,
    binary: container.spackBinary,
  });
}, 600_000);

afterAll(async () => {
  await container?.stop();
});

describeOrSkip("SpackManager — real spack container", () => {
  test("bootstrap reports available with a real version string", () => {
    expect(manager.available).toBe(true);
    // spack --version emits e.g. "1.0.3 (1b670fed…)"; bootstrap keeps the
    // first token. Assert it looks like a real semver-ish version.
    expect(manager.version).toMatch(/^\d+\.\d+/);
  });

  test("installedList parses real `spack find --json` (array, fresh image likely empty)", async () => {
    const list = await manager.installedList();
    expect(Array.isArray(list)).toBe(true);
    // Fresh image has nothing installed; the assertion that matters is that
    // parsing real JSON does not throw and yields an array.
  }, 60_000);

  test("mirror add → list → remove round-trips against real `spack mirror`", async () => {
    const mgr = manager.mirrorManager;
    if (!mgr) throw new Error("mirrorManager unavailable on an available SpackManager");

    const NAME = "kq-test-mirror";
    const URL = "file:///tmp/kq-test-mirror";

    // Clean any stale entry from a prior aborted run (best-effort).
    await mgr.remove(NAME).catch(() => {});

    await mgr.add(NAME, URL);
    const afterAdd = await mgr.list();
    expect(afterAdd.get(NAME)).toBe(URL);

    await mgr.remove(NAME);
    const afterRemove = await mgr.list();
    expect(afterRemove.has(NAME)).toBe(false);
  }, 60_000);

  test("buildcache list runs against real spack without throwing", async () => {
    // Non-mutating real call. `spack buildcache list` on a fresh image with no
    // configured buildcache returns cleanly (empty). We invoke via the same
    // spawner the manager uses to prove the real binary handles the args.
    const r = await container.spawner.run([container.spackBinary, "buildcache", "list"]);
    expect(r.exitCode).toBe(0);
  }, 60_000);

  test("importBuildcache([]) is a no-op that does not throw", async () => {
    const result = await manager.importBuildcache([]);
    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  // Real install (pragmatic): a from-source `spack install` compiles for many
  // minutes and is out of the e2e budget. We exercise `requestInstall` of a
  // tiny leaf spec under a permissive policy to prove the policy-allow path
  // REACHES the real `spack install` invocation. We accept either `installed`
  // (if a binary/cache path is fast) or `failed` (compile not finished / no
  // cache) — we do NOT assert success. A full from-source compile is
  // deliberately outside the suite budget. `gmake` is a small build tool with
  // few dependencies, the cheapest real spec to attempt.
  test("requestInstall reaches the real `spack install` (allow path)", async () => {
    const policy: SpackPolicy = { lockEnabled: false };
    const outcome = await manager.requestInstall("gmake", policy);
    // The policy allowed it, so we must NOT see "rejected" — that would mean
    // the install command was never invoked. "installed" or "failed" both
    // prove the real `spack install` path executed.
    expect(outcome.outcome).not.toBe("rejected");
    expect(["installed", "failed"]).toContain(outcome.outcome);
  }, 300_000);
});
