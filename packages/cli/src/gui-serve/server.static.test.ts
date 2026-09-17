import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TuiAgent,
  TuiBackend,
  TuiBackendCapabilities,
  TuiBackendInfo,
  TuiJob,
  TuiJobDetail,
  TuiJobStatus,
  TuiSoftware,
  TuiSubmitResult,
  TuiWorkflowDetail,
  TuiWorkflowRun,
} from "../tui/backend/types";
import { createGuiServer } from "./server";

class FakeBackend implements TuiBackend {
  readonly info: TuiBackendInfo = { mode: "local", target: "slurm 23.02" };
  readonly capabilities: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: true,
    workflows: true,
    agents: true,
    metrics: true,
    software: true,
    ssh: false,
  };

  listJobs(): Promise<TuiJob[]> {
    return Promise.resolve([
      {
        id: "j1",
        name: "echo",
        status: "running" as TuiJobStatus,
        location: "batch",
        submittedAt: "2026-06-02T00:00:00Z",
      },
    ]);
  }
  cancelJob(): Promise<void> {
    return Promise.resolve();
  }
  getJobDetail(id: string): Promise<TuiJobDetail> {
    return Promise.resolve({
      id,
      name: "echo",
      status: "completed" as TuiJobStatus,
      command: "echo hi",
      exitCode: 0,
      cpus: 1,
      memoryMb: 256,
    });
  }
  subscribeJobStatus(): () => void {
    return () => {};
  }
  submitFromSpec(): Promise<TuiSubmitResult> {
    return Promise.resolve({ id: "j99", name: "submitted" });
  }
  getJobLogs(): Promise<string> {
    return Promise.resolve("line1");
  }
  listWorkflows(): Promise<TuiWorkflowRun[]> {
    return Promise.resolve([]);
  }
  submitWorkflow(): Promise<TuiSubmitResult> {
    return Promise.resolve({ id: "w99", name: "wf" });
  }
  getWorkflowDetail(id: string): Promise<TuiWorkflowDetail> {
    return Promise.resolve({ id, name: "p", status: "running" as TuiJobStatus, steps: [] });
  }
  subscribeWorkflowStatus(): () => void {
    return () => {};
  }
  listAgents(): Promise<TuiAgent[]> {
    return Promise.resolve([]);
  }
  listSoftware(): Promise<TuiSoftware[]> {
    return Promise.resolve([]);
  }
}

function req(method: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://x${path}`, { method, ...init });
}

const INDEX_HTML = "<html><head></head><body>app</body></html>";

describe("createGuiServer static SPA serving", () => {
  let webDir: string;

  beforeAll(() => {
    webDir = mkdtempSync(join(tmpdir(), "kq-gui-web-"));
    writeFileSync(join(webDir, "index.html"), INDEX_HTML);
    mkdirSync(join(webDir, "assets"));
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('hi');");
    writeFileSync(join(webDir, "favicon.ico"), "icon-bytes");
  });

  afterAll(() => {
    rmSync(webDir, { recursive: true, force: true });
  });

  it("GET / → 200 text/html with injected window.__KQ_LOCAL__ (baseUrl /api + token)", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "tok123", webDir });
    const r = await s.fetch(req("GET", "/"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain('window.__KQ_LOCAL__ = { baseUrl: "/api"');
    expect(html).toContain('"tok123"');
    expect(html).toContain("<body>app</body>");
    // injection happens before the closing </head>
    expect(html.indexOf("__KQ_LOCAL__")).toBeLessThan(html.indexOf("</head>"));
  });

  it("GET / with no configured token → injects the local session token", async () => {
    const s = createGuiServer(new FakeBackend(), { webDir });
    const r = await s.fetch(req("GET", "/"));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('window.__KQ_LOCAL__ = { baseUrl: "/api", token: "local-dev" }');
  });

  it("GET /jobs (client route, no file) → 200 index.html SPA fallback with injection", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "tok123", webDir });
    const r = await s.fetch(req("GET", "/jobs"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("__KQ_LOCAL__");
    expect(html).toContain("<body>app</body>");
  });

  it("GET /assets/app.js → 200 JS content-type, NOT index.html", async () => {
    const s = createGuiServer(new FakeBackend(), { webDir });
    const r = await s.fetch(req("GET", "/assets/app.js"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    const body = await r.text();
    expect(body).toContain("console.log('hi');");
    expect(body).not.toContain("__KQ_LOCAL__");
  });

  it("GET /favicon.ico → 200 served as a file", async () => {
    const s = createGuiServer(new FakeBackend(), { webDir });
    const r = await s.fetch(req("GET", "/favicon.ico"));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("icon-bytes");
  });

  it("GET /api/jobs still works (API precedence) when webDir is set", async () => {
    const s = createGuiServer(new FakeBackend(), { webDir });
    const r = await s.fetch(req("GET", "/api/jobs"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it("bearer is still enforced on /api/* when token + webDir set; static stays public", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "t", webDir });
    // /api/* requires bearer
    expect((await s.fetch(req("GET", "/api/jobs"))).status).toBe(401);
    expect(
      (await s.fetch(req("GET", "/api/jobs", { headers: { authorization: "Bearer t" } }))).status,
    ).toBe(200);
    // static + index are public (no bearer)
    expect((await s.fetch(req("GET", "/"))).status).toBe(200);
    expect((await s.fetch(req("GET", "/assets/app.js"))).status).toBe(200);
    expect((await s.fetch(req("GET", "/jobs"))).status).toBe(200);
  });

  it("path traversal via ../ → not the file (falls back to index, never escapes webDir)", async () => {
    const s = createGuiServer(new FakeBackend(), { webDir });
    const r = await s.fetch(req("GET", "/assets/../../etc/passwd"));
    // must not leak /etc/passwd; either SPA fallback (200 html) or 403/404
    if (r.status === 200) {
      const body = await r.text();
      expect(body).not.toContain("root:");
      expect(body).toContain("__KQ_LOCAL__");
    } else {
      expect([403, 404]).toContain(r.status);
    }
  });

  it("path traversal via %2e%2e → not the file", async () => {
    const s = createGuiServer(new FakeBackend(), { webDir });
    const r = await s.fetch(req("GET", "/%2e%2e/%2e%2e/etc/passwd"));
    if (r.status === 200) {
      const body = await r.text();
      expect(body).not.toContain("root:");
    } else {
      expect([403, 404]).toContain(r.status);
    }
  });

  it("no webDir → GET / → 404 (today's API-only behavior, regression)", async () => {
    const s = createGuiServer(new FakeBackend(), {});
    expect((await s.fetch(req("GET", "/"))).status).toBe(404);
    expect((await s.fetch(req("GET", "/jobs"))).status).toBe(404);
  });
});

const EMBEDDED_SPA = {
  "index.html": {
    type: "text/html; charset=utf-8",
    base64: btoa(INDEX_HTML),
  },
  "assets/app.js": {
    type: "text/javascript; charset=utf-8",
    base64: btoa("console.log(1)"),
  },
};

describe("createGuiServer embedded SPA serving", () => {
  it("GET / → injected index.html from the embedded map (window.__KQ_LOCAL__)", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "tok123", embeddedSpa: EMBEDDED_SPA });
    const r = await s.fetch(req("GET", "/"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain('window.__KQ_LOCAL__ = { baseUrl: "/api"');
    expect(html).toContain('"tok123"');
    expect(html).toContain("<body>app</body>");
    expect(html.indexOf("__KQ_LOCAL__")).toBeLessThan(html.indexOf("</head>"));
  });

  it("GET /jobs (client route) → SPA fallback to injected index.html", async () => {
    const s = createGuiServer(new FakeBackend(), { embeddedSpa: EMBEDDED_SPA });
    const r = await s.fetch(req("GET", "/jobs"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("__KQ_LOCAL__");
    expect(html).toContain("<body>app</body>");
  });

  it("GET /assets/app.js → the embedded JS with its declared type, NOT index.html", async () => {
    const s = createGuiServer(new FakeBackend(), { embeddedSpa: EMBEDDED_SPA });
    const r = await s.fetch(req("GET", "/assets/app.js"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    const body = await r.text();
    expect(body).toBe("console.log(1)");
    expect(body).not.toContain("__KQ_LOCAL__");
  });

  it("/api/* precedence + bearer still hold with an embedded SPA", async () => {
    const s = createGuiServer(new FakeBackend(), { token: "t", embeddedSpa: EMBEDDED_SPA });
    expect((await s.fetch(req("GET", "/api/jobs"))).status).toBe(401);
    expect(
      (await s.fetch(req("GET", "/api/jobs", { headers: { authorization: "Bearer t" } }))).status,
    ).toBe(200);
    // static + index public
    expect((await s.fetch(req("GET", "/"))).status).toBe(200);
    expect((await s.fetch(req("GET", "/assets/app.js"))).status).toBe(200);
    expect((await s.fetch(req("GET", "/jobs"))).status).toBe(200);
  });

  it("empty embeddedSpa + no webDir → 404 (today's API-only behavior)", async () => {
    const s = createGuiServer(new FakeBackend(), { embeddedSpa: {} });
    expect((await s.fetch(req("GET", "/"))).status).toBe(404);
    expect((await s.fetch(req("GET", "/jobs"))).status).toBe(404);
  });

  it("webDir wins over embeddedSpa when both are provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kq-gui-web-disk-"));
    writeFileSync(join(dir, "index.html"), "<html><head></head><body>DISK</body></html>");
    try {
      const s = createGuiServer(new FakeBackend(), { webDir: dir, embeddedSpa: EMBEDDED_SPA });
      const r = await s.fetch(req("GET", "/"));
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain("<body>DISK</body>");
      expect(html).not.toContain("<body>app</body>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
