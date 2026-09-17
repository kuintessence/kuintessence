import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ContainerSpawner } from "../adapters/spawner-container";
import { SpackManager } from "./index";

const CONTAINER = process.env.SPACK_E2E_CONTAINER;
const SPACK_BIN = process.env.SPACK_E2E_BINARY ?? "/opt/spack/bin/spack";
const suite = CONTAINER ? describe : describe.skip;

const MIRROR = `kq-e2e-${Date.now()}`;
const MIRROR_URL = "https://example.com/kq-e2e";

suite("real-Spack CP policy + mirror governance (F19)", () => {
  let mgr: SpackManager | undefined;

  beforeAll(async () => {
    if (!CONTAINER) return;
    const spawner = new ContainerSpawner(CONTAINER);
    mgr = await SpackManager.bootstrap({ spawner, binary: SPACK_BIN, enabled: true });
  });

  afterAll(async () => {
    await mgr?.mirrorManager?.remove(MIRROR).catch(() => {});
  });

  test("bootstrap detects real spack", () => {
    if (!mgr) throw new Error("manager not bootstrapped");
    expect(mgr.available).toBe(true);
    expect(mgr.version).toMatch(/^\d+\.\d+/);
  });

  test("installedList parses real spack find --json", async () => {
    if (!mgr) throw new Error("manager not bootstrapped");
    const list = await mgr.installedList();
    expect(Array.isArray(list)).toBe(true);
  }, 30000);

  test("applyPolicy adds a mirror via real spack mirror add+list", async () => {
    if (!mgr) throw new Error("manager not bootstrapped");
    const ack = await mgr.applyPolicy({
      policyVersion: "v1",
      lockEnabled: false,
      mirrors: [{ name: MIRROR, url: MIRROR_URL, priority: 1 }],
    });
    expect(ack.applied).toBe(true);
    if (!mgr.mirrorManager) throw new Error("mirrorManager unavailable");
    const mirrors = await mgr.mirrorManager.list();
    expect(mirrors.get(MIRROR)).toBe(MIRROR_URL);
  }, 30000);

  test("applyMirrors is idempotent against an already-present mirror", async () => {
    if (!mgr) throw new Error("manager not bootstrapped");
    if (!mgr.mirrorManager) throw new Error("mirrorManager unavailable");
    const delta = await mgr.mirrorManager.applyMirrors([{ name: MIRROR, url: MIRROR_URL }]);
    expect(delta.alreadyPresent).toContain(MIRROR);
    expect(delta.added).toHaveLength(0);
  }, 30000);

  test("policy gate rejects a locked install without compiling", async () => {
    if (!mgr) throw new Error("manager not bootstrapped");
    const outcome = await mgr.requestInstall("zlib@9.9.9", { lockEnabled: true, allowList: [] });
    expect(outcome.outcome).toBe("rejected");
  }, 30000);
});
