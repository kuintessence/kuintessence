import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFederationGateway } from "./gateway";

test("gateway refuses Bun where verified peer certificate context is unavailable", () => {
  expect(() =>
    createFederationGateway({ ca: "", key: "", cert: "", socketPath: "/unused" }),
  ).toThrow("requires Node.js");
});

test("Node gateway enforces real TLS certificates and strips caller identity headers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kq-gateway-check-"));
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "gateway-check.fixture.ts")],
      outdir: dir,
      target: "node",
    });
    expect(built.success).toBe(true);
    const process = Bun.spawn(["node", join(dir, "gateway-check.fixture.js")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out).assertions).toContain("mTLS");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
