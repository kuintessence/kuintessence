import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MirrorSpec } from "@kuintessence/shared";
import type { Spawner } from "../adapters/base";
import { SpackCli } from "./cli";
import { MirrorManager, parseMirrorList } from "./mirror-manager";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const MIRROR_LIST_TXT = readFileSync(join(FIXTURES, "spack-mirror-list.txt"), "utf-8");

interface MockResp {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

function makeSpawner(responses: MockResp[]): { spawner: Spawner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const spawner: Spawner = {
    async run(cmd) {
      calls.push(cmd);
      const r = responses[i++];
      if (!r) throw new Error(`No more mock responses (call #${calls.length})`);
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? "" };
    },
  };
  return { spawner, calls };
}

describe("parseMirrorList", () => {
  test("parses fixture into name->url map", () => {
    const map = parseMirrorList(MIRROR_LIST_TXT);
    expect(map.get("spack-public")).toBe("https://mirror.spack.io");
    expect(map.get("internal")).toBe("https://mirrors.example.com/spack");
    expect(map.get("buildcache-shared")).toBe("s3://kq-buildcache/shared");
  });

  test("returns empty map on empty input", () => {
    expect(parseMirrorList("").size).toBe(0);
    expect(parseMirrorList("\n\n").size).toBe(0);
  });

  test("ignores malformed lines", () => {
    const map = parseMirrorList("name-only\ngood https://example.com\n  \n");
    expect(map.size).toBe(1);
    expect(map.get("good")).toBe("https://example.com");
  });

  test("skips spack `==>` status/notice lines (no phantom mirror)", () => {
    expect(parseMirrorList("==> No mirrors configured.").size).toBe(0);
    const map = parseMirrorList("==> Mirrors:\nlocal [sb] file:///tmp/m\n");
    expect(map.size).toBe(1);
    expect(map.get("local")).toBe("file:///tmp/m");
  });
});

describe("MirrorManager.list / add / remove", () => {
  test("list parses the mirror map from a successful `mirror list`", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: MIRROR_LIST_TXT }]);
    const mgr = new MirrorManager(new SpackCli({ spawner }));
    const map = await mgr.list();
    expect(map.get("internal")).toBe("https://mirrors.example.com/spack");
    expect(calls[0]).toEqual(["spack", "mirror", "list"]);
  });

  test("list throws on a non-zero `mirror list` exit", async () => {
    const { spawner } = makeSpawner([{ exitCode: 1, stdout: "", stderr: "boom" }]);
    const mgr = new MirrorManager(new SpackCli({ spawner }));
    await expect(mgr.list()).rejects.toThrow(/mirror list failed/);
  });

  test("add invokes `mirror add` and resolves on success", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: "" }]);
    const mgr = new MirrorManager(new SpackCli({ spawner }));
    await mgr.add("new", "https://new.example.com");
    expect(calls[0]).toEqual(["spack", "mirror", "add", "new", "https://new.example.com"]);
  });

  test("add throws on a non-zero exit", async () => {
    const { spawner } = makeSpawner([{ exitCode: 1, stdout: "", stderr: "bad url" }]);
    const mgr = new MirrorManager(new SpackCli({ spawner }));
    await expect(mgr.add("bad", "x")).rejects.toThrow(/mirror add bad failed/);
  });

  test("remove invokes `mirror rm` and resolves on success", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: "" }]);
    const mgr = new MirrorManager(new SpackCli({ spawner }));
    await mgr.remove("internal");
    expect(calls[0]).toEqual(["spack", "mirror", "rm", "internal"]);
  });

  test("remove throws on a non-zero exit", async () => {
    const { spawner } = makeSpawner([{ exitCode: 1, stdout: "", stderr: "no such mirror" }]);
    const mgr = new MirrorManager(new SpackCli({ spawner }));
    await expect(mgr.remove("ghost")).rejects.toThrow(/mirror rm ghost failed/);
  });
});

describe("MirrorManager.applyMirrors", () => {
  const desired: MirrorSpec[] = [
    { name: "internal", url: "https://mirrors.example.com/spack" },
    { name: "new-mirror", url: "https://new.example.com" },
  ];

  test("adds only mirrors not already registered", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: MIRROR_LIST_TXT }, // mirror list (internal already present)
      { exitCode: 0, stdout: "" }, // mirror add new-mirror
    ]);
    const cli = new SpackCli({ spawner });
    const mgr = new MirrorManager(cli);

    const delta = await mgr.applyMirrors(desired);

    expect(delta.added).toEqual(["new-mirror"]);
    expect(delta.alreadyPresent).toEqual(["internal"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["spack", "mirror", "add", "new-mirror", "https://new.example.com"]);
  });

  test("no-op when all mirrors already present", async () => {
    const { spawner, calls } = makeSpawner([{ exitCode: 0, stdout: MIRROR_LIST_TXT }]);
    const cli = new SpackCli({ spawner });
    const mgr = new MirrorManager(cli);

    const delta = await mgr.applyMirrors([
      { name: "internal", url: "https://mirrors.example.com/spack" },
    ]);

    expect(delta.added).toEqual([]);
    expect(delta.alreadyPresent).toEqual(["internal"]);
    // only the list call, no add
    expect(calls).toHaveLength(1);
  });

  test("idempotent: second apply with same input adds nothing", async () => {
    const { spawner, calls } = makeSpawner([
      { exitCode: 0, stdout: MIRROR_LIST_TXT },
      { exitCode: 0, stdout: "" }, // first add
      // After the add, the next list shows the new mirror present
      {
        exitCode: 0,
        stdout: `${MIRROR_LIST_TXT}new-mirror   https://new.example.com\n`,
      },
    ]);
    const cli = new SpackCli({ spawner });
    const mgr = new MirrorManager(cli);

    await mgr.applyMirrors(desired);
    const delta2 = await mgr.applyMirrors(desired);

    expect(delta2.added).toEqual([]);
    expect(calls).toHaveLength(3); // list, add, list — no second add
  });

  test("surfaces failed adds without throwing", async () => {
    const { spawner } = makeSpawner([
      { exitCode: 0, stdout: "" }, // empty mirror list
      { exitCode: 1, stdout: "", stderr: "==> Error: bad url" },
      { exitCode: 0, stdout: "" }, // second add succeeds
    ]);
    const cli = new SpackCli({ spawner });
    const mgr = new MirrorManager(cli);

    const delta = await mgr.applyMirrors([
      { name: "bad", url: "https://bad.example.com" },
      { name: "good", url: "https://good.example.com" },
    ]);

    expect(delta.added).toEqual(["good"]);
    expect(delta.failed).toHaveLength(1);
    expect(delta.failed[0]?.name).toBe("bad");
    expect(delta.failed[0]?.stderr).toMatch(/bad url/);
  });
});
