import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAgentBinaryRoutes } from "./agent-binaries";

const revision = "a".repeat(40);
const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 255]);
const hash = createHash("sha256").update(bytes).digest("hex");
let directory: string;
let app: Hono;
const manifest = {
  version: 1,
  revision,
  agentVersion: "0.1.0-rc.1",
  bunVersion: "1.4.2",
  files: ["bun-linux-x64", "bun-linux-arm64"].map((target) => ({
    name: `kq-agent-${target}`,
    target,
    size: bytes.length,
    sha256: hash,
  })),
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kq-agent-download-"));
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "SHA256SUMS"), `${hash}  kq-agent-bun-linux-x64\n`);
  for (const file of manifest.files) await writeFile(join(directory, file.name), bytes);
  app = new Hono();
  app.route("/api", createAgentBinaryRoutes(directory));
  app.use("/api/*", async (c) => c.json({ error: "Requires login" }, 401));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("Server-matched Agent downloads", () => {
  test("public manifest reports revision, architectures and hashes before the authentication gate", async () => {
    const response = await app.request("/api/agent-binaries");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(manifest);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await app.request("/api/agents")).status).toBe(401);
  });

  test.each([
    "bun-linux-x64",
    "bun-linux-arm64",
  ])("streams the exact %s executable with pinned revision", async (target) => {
    const response = await app.request(
      `/api/agent-binaries/kq-agent-${target}?revision=${revision}`,
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="kq-agent-${target}"`,
    );
    expect(response.headers.get("X-Kuintessence-Revision")).toBe(revision);
    expect(response.headers.get("ETag")).toBe(`"${hash}"`);
  });

  test("HEAD exposes the size without sending a binary body", async () => {
    const response = await app.request("/api/agent-binaries/kq-agent-bun-linux-x64", {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(await response.text()).toBe("");
  });

  test("rejects an old revision after a deployment instead of silently changing artifacts", async () => {
    expect(
      (await app.request(`/api/agent-binaries/kq-agent-bun-linux-x64?revision=${"b".repeat(40)}`))
        .status,
    ).toBe(409);
  });

  test.each([
    "manifest.json",
    "SHA256SUMS",
  ])("downloads original checksum metadata %s", async (name) => {
    const response = await app.request(`/api/agent-binaries/${name}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(await Bun.file(join(directory, name)).text());
  });

  test.each([
    ".env",
    "ca.key",
    "unknown",
    "..%2Fsecret",
    "%2e%2e%2fsecret",
  ])("does not serve arbitrary path %s", async (name) => {
    expect((await app.request(`/api/agent-binaries/${name}`)).status).toBe(404);
  });

  test("source deployments without a bundle return 404", async () => {
    await rm(join(directory, "manifest.json"));
    expect((await app.request("/api/agent-binaries")).status).toBe(404);
    expect((await app.request("/api/agent-binaries/kq-agent-bun-linux-x64")).status).toBe(404);
  });

  test("a missing binary is not replaced by another architecture", async () => {
    await rm(join(directory, "kq-agent-bun-linux-arm64"));
    expect((await app.request("/api/agent-binaries/kq-agent-bun-linux-arm64")).status).toBe(404);
  });

  test("corrupt bundle metadata or truncated binaries fail closed", async () => {
    app.onError((_error, c) => c.text("Invalid bundle", 500));
    await writeFile(join(directory, "kq-agent-bun-linux-x64"), "short");
    expect((await app.request("/api/agent-binaries/kq-agent-bun-linux-x64")).status).toBe(500);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({ ...manifest, files: [manifest.files[0], manifest.files[0]] }),
    );
    expect((await app.request("/api/agent-binaries")).status).toBe(500);
  });
});
