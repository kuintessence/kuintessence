import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpackManager, Spawner } from "@kuintessence/agent/embedded";
import { SpackManager as RealSpackManager } from "@kuintessence/agent/embedded";
import { formatInstalledTable, LOCAL_POLICY } from "../lib/local-spack";
import {
  fetchRemoteSoftwareCatalog,
  formatRemoteSoftwareCatalog,
  parseRemoteCatalogSource,
  requireLocal,
  resolveRegistryApiBase,
  runLocal,
} from "./software";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "agent", "src", "spack", "__fixtures__");
const FIND_JSON = readFileSync(join(FIXTURES, "spack-find.json"), "utf-8");
const VERSION_TXT = readFileSync(join(FIXTURES, "spack-version.txt"), "utf-8");

interface MockResp {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

function mockSpawner(responses: MockResp[]): Spawner {
  let i = 0;
  return {
    async run(_cmd) {
      const r = responses[i++];
      if (!r) throw new Error("No more mock responses");
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? "" };
    },
  };
}

// Capture console + process.exit so we can assert the print/exit-code glue.
type Captured = { out: string[]; err: string[]; exit: number | undefined };

function capture(): { c: Captured; restore: () => void } {
  const c: Captured = { out: [], err: [], exit: undefined };
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...a: unknown[]) => c.out.push(a.join(" "));
  console.error = (...a: unknown[]) => c.err.push(a.join(" "));
  // Throw to short-circuit like the real `never`-typed exit would unwind.
  process.exit = ((code?: number) => {
    c.exit = code ?? 0;
    throw new Error("__exit__");
  }) as typeof process.exit;
  return {
    c,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    },
  };
}

let activeRestore: (() => void) | undefined;
afterEach(() => {
  activeRestore?.();
  activeRestore = undefined;
});

async function withCapture(fn: () => Promise<void>): Promise<Captured> {
  const { c, restore } = capture();
  activeRestore = restore;
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "__exit__") throw err;
  }
  return c;
}

describe("requireLocal", () => {
  test("exits 1 when --local is absent", async () => {
    const c = await withCapture(async () => {
      requireLocal("mirror list", undefined);
    });
    expect(c.exit).toBe(1);
    expect(c.err.join("\n")).toContain("only --local is supported");
  });

  test("no-op when --local is present", async () => {
    const c = await withCapture(async () => {
      requireLocal("mirror list", true);
    });
    expect(c.exit).toBeUndefined();
  });
});

describe("runLocal", () => {
  function manager(spawner: Spawner): () => Promise<SpackManager> {
    return () => RealSpackManager.bootstrap({ spawner });
  }

  test("prints the action text on an ok outcome (no exit)", async () => {
    const provide = manager(mockSpawner([{ exitCode: 0, stdout: VERSION_TXT }]));
    const c = await withCapture(async () => {
      await runLocal("list", async () => ({ text: "hello", ok: true }), provide);
    });
    expect(c.exit).toBeUndefined();
    expect(c.out.join("\n")).toContain("hello");
  });

  test("prints to stderr + exits 1 on a not-ok outcome", async () => {
    const provide = manager(mockSpawner([{ exitCode: 0, stdout: VERSION_TXT }]));
    const c = await withCapture(async () => {
      await runLocal("install", async () => ({ text: "rejected", ok: false }), provide);
    });
    expect(c.exit).toBe(1);
    expect(c.err.join("\n")).toContain("rejected");
  });

  test("friendly error + exit 1 when bootstrap reports spack unavailable", async () => {
    const provide = (): Promise<SpackManager> => {
      throw new Error("spack not found on PATH");
    };
    const c = await withCapture(async () => {
      await runLocal("list", async () => ({ text: "x", ok: true }), provide);
    });
    expect(c.exit).toBe(1);
    expect(c.err.join("\n")).toContain("kq software list (local): spack not found on PATH");
  });

  test("friendly error + exit 1 when the action throws", async () => {
    const provide = manager(mockSpawner([{ exitCode: 0, stdout: VERSION_TXT }]));
    const c = await withCapture(async () => {
      await runLocal(
        "mirror list",
        async () => {
          throw new Error("mirror manager unavailable");
        },
        provide,
      );
    });
    expect(c.exit).toBe(1);
    expect(c.err.join("\n")).toContain("mirror manager unavailable");
  });

  test("end-to-end list via an injected manager backed by a mock Spawner", async () => {
    const provide = manager(
      mockSpawner([
        { exitCode: 0, stdout: VERSION_TXT }, // bootstrap
        { exitCode: 0, stdout: FIND_JSON }, // find --json
      ]),
    );
    const c = await withCapture(async () => {
      await runLocal(
        "list",
        async (m) => ({ text: formatInstalledTable(await m.installedList()), ok: true }),
        provide,
      );
    });
    expect(c.exit).toBeUndefined();
    expect(c.out.join("\n")).toContain("gromacs");
  });

  test("LOCAL_POLICY install path is allow-all", async () => {
    const provide = manager(
      mockSpawner([
        { exitCode: 0, stdout: VERSION_TXT }, // bootstrap
        { exitCode: 0, stdout: "installed" }, // install
        { exitCode: 0, stdout: FIND_JSON }, // cache refresh
      ]),
    );
    const c = await withCapture(async () => {
      await runLocal(
        "install",
        async (m) => {
          const o = await m.requestInstall("anything@1.0", LOCAL_POLICY);
          return { text: o.outcome, ok: o.outcome === "installed" };
        },
        provide,
      );
    });
    expect(c.exit).toBeUndefined();
    expect(c.out.join("\n")).toContain("installed");
  });
});

describe("remote software catalog", () => {
  test("derives path-mode and domain-mode Registry API URLs", () => {
    expect(resolveRegistryApiBase("https://platform.example/platform", "")).toBe(
      "https://platform.example/software/api",
    );
    expect(
      resolveRegistryApiBase(
        "https://platform.example/platform",
        "https://software.example/custom",
      ),
    ).toBe("https://software.example/custom/api");
    expect(() =>
      resolveRegistryApiBase("https://platform.example/platform", "http://software.example"),
    ).toThrow("must use HTTPS");
    expect(resolveRegistryApiBase("http://127.0.0.1:3000", "http://127.0.0.1:3100")).toBe(
      "http://127.0.0.1:3100/api",
    );
  });

  test("rejects an invalid source instead of silently returning every package", () => {
    expect(parseRemoteCatalogSource("vendor")).toBe("vendor");
    expect(() => parseRemoteCatalogSource("vendro")).toThrow("--source must be");
  });

  test("reads and formats the real Spack catalog response", async () => {
    let requested = "";
    const page = await fetchRemoteSoftwareCatalog(
      { serverUrl: "https://platform.example/platform", token: "test-token" },
      { page: 2, pageSize: 50, query: "gromacs", source: "upstream" },
      async (input, init) => {
        requested = String(input);
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
        return new Response(
          JSON.stringify({
            page: 1,
            pageSize: 24,
            totalCount: 1,
            totalPages: 1,
            packages: [
              {
                name: "gromacs",
                source: "upstream",
                metadata: { versions: ["2025.1"] },
                asset: { lifecycle: "published", version: "catalog" },
              },
            ],
          }),
          { status: 200 },
        );
      },
    );
    expect(requested).toBe(
      "https://platform.example/software/api/spack/catalog?page=2&pageSize=50&q=gromacs&source=upstream",
    );
    expect(formatRemoteSoftwareCatalog(page)).toContain("upstream\tgromacs\t2025.1\tpublished");
    expect(formatRemoteSoftwareCatalog(page)).toContain("Showing 1 of 1 (page 1/1)");
  });

  test("rejects malformed pages and duplicate package row ids", async () => {
    const config = { serverUrl: "https://platform.example/platform" };
    const fetchBody = (body: unknown) => async () => new Response(JSON.stringify(body));

    expect(
      fetchRemoteSoftwareCatalog(config, {}, fetchBody({ page: 1, packages: [] })),
    ).rejects.toThrow("invalid response");
    expect(
      fetchRemoteSoftwareCatalog(
        config,
        {},
        fetchBody({
          page: 1,
          pageSize: 24,
          totalCount: 2,
          totalPages: 1,
          packages: [
            { id: "same", name: "solver-a", source: "official" },
            { id: "same", name: "solver-b", source: "official" },
          ],
        }),
      ),
    ).rejects.toThrow("invalid response");
    expect(
      fetchRemoteSoftwareCatalog(
        config,
        {},
        fetchBody({
          page: 1,
          pageSize: 24,
          totalCount: 1,
          totalPages: 1,
          packages: [
            {
              name: "broken",
              source: "upstream",
              metadata: { versions: "1.0" },
              asset: { lifecycle: 42 },
            },
          ],
        }),
      ),
    ).rejects.toThrow("invalid response");
  });
});
