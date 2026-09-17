import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGuiBackend } from "./fake-backend";
import { createGuiServer } from "./server";

const TOKEN = "t";
const BEARER = { authorization: `Bearer ${TOKEN}` };

describe("kq gui serve — Server-shape round-trip over Bun.serve", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeAll(() => {
    const gui = createGuiServer(new FakeGuiBackend(), { token: TOKEN });
    server = Bun.serve({ port: 0, fetch: gui.fetch });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("POST /api/auth/login → { token, expiresIn } (no auth)", async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.c", role: "user" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ token: TOKEN, expiresIn: 86400 });
  });

  it("GET /api/auth/oidc/config-public → { enabled:false, providerName:'' } (no auth)", async () => {
    const r = await fetch(`${base}/api/auth/oidc/config-public`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ enabled: false, providerName: "" });
  });

  it("GET /api/jobs → { jobs: [{ id, name, status, submittedAt }] } (Server shape)", async () => {
    const r = await fetch(`${base}/api/jobs`, { headers: BEARER });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { jobs: Array<Record<string, unknown>> };
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs).toHaveLength(2);
    const first = body.jobs[0];
    expect(first).toEqual({
      id: "j1",
      name: "echo",
      status: "running",
      submittedAt: "2026-06-02T00:00:00Z",
    });
    expect(first?.submittedAt).toBeString();
  });

  it("GET /api/agents → { agents: [{ agentId, siteName, schedulerType, schedulerVersion, status }] }", async () => {
    const r = await fetch(`${base}/api/agents`, { headers: BEARER });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents[0]).toMatchObject({
      agentId: "local",
      siteName: "this-node",
      schedulerType: "slurm",
      schedulerVersion: "23.02",
      status: "online",
    });
  });

  it("GET /api/workflows → { runs: [{ id, name, status, createdAt }] }", async () => {
    const r = await fetch(`${base}/api/workflows`, { headers: BEARER });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { runs: Array<Record<string, unknown>> };
    expect(body.runs[0]).toEqual({
      id: "w1",
      name: "pipeline",
      status: "running",
      createdAt: "2026-06-02T02:00:00Z",
    });
  });

  it("GET /api/software/agents/:id/installed → { success:true, data:[...] }", async () => {
    const r = await fetch(`${base}/api/software/agents/local/installed`, { headers: BEARER });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { success: boolean; data: Array<Record<string, unknown>> };
    expect(body.success).toBe(true);
    expect(body.data[0]).toMatchObject({ name: "zlib", spec: "zlib@1.3" });
  });

  it("GET /api/capabilities → the backend's TuiBackendCapabilities", async () => {
    const r = await fetch(`${base}/api/capabilities`, { headers: BEARER });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      jobs: true,
      submit: true,
      logs: true,
      workflows: true,
      agents: true,
      metrics: true,
      software: true,
      ssh: false,
    });
  });

  it("no Bearer → 401", async () => {
    const r = await fetch(`${base}/api/jobs`);
    expect(r.status).toBe(401);
    expect((await r.json()) as { error: string }).toEqual({ error: "unauthorized" });
  });

  it("Server-only path /api/cp/dashboard → 404 { error }", async () => {
    const r = await fetch(`${base}/api/cp/dashboard`, { headers: BEARER });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe("not available in local mode");
  });
});

describe("kq gui serve — SPA + API same-origin over Bun.serve (zero-Tauri)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let webDir: string;

  beforeAll(() => {
    webDir = mkdtempSync(join(tmpdir(), "kq-gui-e2e-web-"));
    writeFileSync(join(webDir, "index.html"), "<html><head></head><body>app</body></html>");
    const gui = createGuiServer(new FakeGuiBackend(), { token: TOKEN, webDir });
    server = Bun.serve({ port: 0, fetch: gui.fetch });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("GET / → html with the injected local-mode token (same-origin baseUrl /api)", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain('window.__KQ_LOCAL__ = { baseUrl: "/api"');
    expect(html).toContain(`"${TOKEN}"`);
  });

  it("GET /api/auth/oidc/config-public still works (public, no bearer)", async () => {
    const r = await fetch(`${base}/api/auth/oidc/config-public`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ enabled: false, providerName: "" });
  });

  it("GET /api/jobs still enforces the bearer (API auth split unchanged)", async () => {
    expect((await fetch(`${base}/api/jobs`)).status).toBe(401);
    expect((await fetch(`${base}/api/jobs`, { headers: BEARER })).status).toBe(200);
  });
});
