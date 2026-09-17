// `kq dsl schema` subcommand tests.
//
// We exercise three things:
//   1. fetchWorkflowDslSchema hits the right URL on the configured Server.
//   2. Non-2xx responses surface as a thrown Error so the CLI exits non-zero.
//   3. The Commander wiring writes to stdout by default and to a file under
//      `--output`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { fetchWorkflowDslSchema, registerDslCommand, validateWorkflowYaml } from "./dsl";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(responder: (url: string) => Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request) =>
    responder(input.toString())) as typeof fetch;
}

describe("fetchWorkflowDslSchema", () => {
  test("GETs /api/dsl/schema/workflow from the configured Server", async () => {
    let captured = "";
    mockFetch(async (url) => {
      captured = url;
      return new Response(JSON.stringify({ $id: "https://platform.local/schemas/workflow.json" }), {
        status: 200,
        headers: { "Content-Type": "application/schema+json" },
      });
    });
    const body = await fetchWorkflowDslSchema("http://server.example:3000");
    expect(captured).toBe("http://server.example:3000/api/dsl/schema/workflow");
    expect(JSON.parse(body).$id).toBe("https://platform.local/schemas/workflow.json");
  });

  test("throws on non-2xx response", async () => {
    mockFetch(async () => new Response("nope", { status: 503 }));
    await expect(fetchWorkflowDslSchema("http://server.example:3000")).rejects.toThrow(/503/);
  });
});

describe("registerDslCommand — `kq dsl schema`", () => {
  test("prints the schema to stdout when no --output is given", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ $id: "https://example/test.json", type: "object" }), {
          status: 200,
          headers: { "Content-Type": "application/schema+json" },
        }),
    );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const program = new Command();
      // Silence Commander's own help/version exits so the test doesn't kill bun.
      program.exitOverride();
      registerDslCommand(program);
      await program.parseAsync(["node", "kq", "dsl", "schema"]);
      const combined = logs.join("\n");
      expect(combined).toMatch(/"\$id": "https:\/\/example\/test.json"/);
      expect(combined).toMatch(/"type": "object"/);
    } finally {
      console.log = originalLog;
    }
  });

  test("writes the schema to disk when --output is given", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ $id: "https://example/saved.json", title: "saved" }), {
          status: 200,
          headers: { "Content-Type": "application/schema+json" },
        }),
    );

    const dir = mkdtempSync(join(tmpdir(), "kq-dsl-test-"));
    const out = join(dir, "schema.json");
    try {
      const program = new Command();
      program.exitOverride();
      registerDslCommand(program);
      await program.parseAsync(["node", "kq", "dsl", "schema", "--output", out]);
      const written = readFileSync(out, "utf-8");
      expect(JSON.parse(written).$id).toBe("https://example/saved.json");
      expect(JSON.parse(written).title).toBe("saved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateWorkflowYaml (offline)", () => {
  test("accepts a minimal valid workflow (no errors)", () => {
    const yaml = "name: my-wf\nspec:\n  nodeDrafts: []\n";
    expect(validateWorkflowYaml(yaml)).toEqual([]);
  });

  test("reports Zod shape errors for a malformed document", () => {
    const errors = validateWorkflowYaml("name: 99\n");
    expect(errors.length).toBeGreaterThan(0);
    // the readable issues include a field path
    expect(errors.join("\n")).toMatch(/name|spec/);
  });

  test("reports a YAML parse error distinctly, not a stack trace", () => {
    const errors = validateWorkflowYaml("name: [unterminated\n");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/Invalid YAML/);
  });
});
