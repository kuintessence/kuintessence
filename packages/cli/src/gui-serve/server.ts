import { resolve, sep } from "node:path";
import { JobSubmitSchema } from "@kuintessence/shared";
import type { TuiBackend } from "../tui/backend/types";
import { UnsupportedInModeError } from "../tui/backend/types";
import {
  toAgentRow,
  toInstalledRow,
  toJobDetail,
  toJobRow,
  toWorkflowRunDetail,
  toWorkflowRunRow,
} from "./server-shapes";

/**
 * `kq gui serve` HTTP surface. A pure `fetch` request handler over a
 * {@link TuiBackend} (the embedded kernel via `selectBackend({local:true})`),
 * exposing the locally-feasible subset of the Server REST API under `/api/*` in
 * **Server-API JSON shapes** (via {@link ./server-shapes}) so the React SPA can drive
 * the all-in-one node in its browser with no Server.
 *
 * Mirrors {@link createAgentServer} structurally, but: routes live under `/api`,
 * responses are Server-shaped (not raw `TuiBackend` shapes), and two stub auth
 * endpoints let the SPA's login/OIDC bootstrap succeed against a single-user
 * local node:
 *
 *   POST /api/auth/login              → { token, expiresIn }        (no auth)
 *   GET  /api/auth/oidc/config-public → { enabled:false, … }        (no auth)
 *   GET  /api/capabilities            → TuiBackendCapabilities
 *   GET  /api/jobs                    → { jobs: JobRow[] }
 *   POST /api/jobs                    → TuiSubmitResult       (JobSubmit body)  201
 *   GET  /api/jobs/:id                → JobDetail
 *   POST /api/jobs/:id/cancel         → JobDetail (after cancel)
 *   GET  /api/jobs/:id/logs?text=1    → { text }
 *   GET  /api/workflows               → { runs: WorkflowRunRow[] }
 *   POST /api/workflows               → { runId, status, … }   (yaml body)  202
 *   POST /api/workflows/run        → { runId, … }           (yaml body)  201
 *   GET  /api/workflows/:id           → WorkflowRunDetail
 *   GET  /api/agents                  → { agents: AgentRow[] }
 *   GET  /api/agents/:id              → AgentRow (else 404)
 *   GET  /api/software/agents/:id/installed → { success:true, data: InstalledRow[] }
 *
 * Server-only surfaces (`/api/cp/*`, `/api/audit-log`, `/api/terminal/*`,
 * `/api/files/*`, `/api/netdrive/*`, `/api/software/policies*`) → 404
 * `{ error: "not available in local mode" }`.
 *
 * Errors: {@link UnsupportedInModeError} → 501 `{ error, unsupported:true }`;
 * any other error → 500 `{ error }`; a malformed body → 400; an unknown route → 404.
 *
 * Auth: when `opts.token` is set, every route EXCEPT `/api/auth/*` requires
 * `Authorization: Bearer <token>` (else 401). With no token, no auth — paired
 * with the command's `127.0.0.1` default bind, that is a localhost-only surface.
 */

export interface GuiServerOptions {
  /** Optional bearer token; when set, every route except `/api/auth/*` requires it. */
  token?: string;
  /**
   * Optional directory of a built SPA (`packages/web/dist`: `index.html` +
   * `assets/`). When set, the server ALSO serves it: real files are returned as
   * static assets, and every other (non-`/api`) path falls back to `index.html`
   * with `window.__KQ_LOCAL__` injected — so a plain browser pointed here is a
   * working all-in-one GUI with no Tauri build. Static + index routes are PUBLIC
   * (the page must load before it has the token, which is injected INTO it);
   * only `/api/*` enforces the bearer. Unset → API-only, unknown route → 404.
   */
  webDir?: string;
  /**
   * An in-binary SPA map (SPA-relative path → `{ type, base64 }`), used ONLY
   * when `webDir` is unset. Lets a single compiled `kq` binary serve the GUI
   * with no disk SPA. The normal `kq` build imports a committed-EMPTY map, so
   * this is `{}` there (→ API-only); only the dedicated GUI single-binary build
   * populates it. Same inject/fallback/`/api`-precedence rules as `webDir`;
   * keys are a fixed set, so lookup is inherently traversal-safe.
   */
  embeddedSpa?: Record<string, { type: string; base64: string }>;
}

export interface GuiServer {
  fetch: (req: Request) => Promise<Response>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof UnsupportedInModeError) {
    return json({ error: err.message, unsupported: true }, 501);
  }
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: message }, 500);
}

async function readJsonObject(req: Request): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}

function isAuthorized(req: Request, token: string): boolean {
  return req.headers.get("authorization") === `Bearer ${token}`;
}

const SERVER_ONLY_PREFIXES = [
  "/api/cp/",
  "/api/audit-log",
  "/api/terminal/",
  "/api/files/",
  "/api/netdrive/",
  "/api/software/policies",
];

function isServerOnly(path: string): boolean {
  return SERVER_ONLY_PREFIXES.some(
    (p) => path === p || path === p.replace(/\/$/, "") || path.startsWith(p),
  );
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXT[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a URL path under `webDir`, decoding it and rejecting anything that
 * escapes the root (path traversal). Returns the absolute on-disk path, or
 * `undefined` when the request must not map to a file (decode failure or escape).
 */
function resolveWithin(webDir: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const rootAbs = resolve(webDir);
  const target = resolve(rootAbs, `.${decoded}`);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return undefined;
  return target;
}

function injectKqLocal(html: string, token: string | undefined): string {
  const localToken = token ?? "local-dev";
  const local = `{ baseUrl: "/api", token: ${JSON.stringify(localToken)} }`;
  const script = `<script>window.__KQ_LOCAL__ = ${local};</script>`;
  const headClose = html.indexOf("</head>");
  if (headClose >= 0) return `${html.slice(0, headClose)}${script}${html.slice(headClose)}`;
  return `${script}${html}`;
}

/** A built SPA, abstracted over its origin (on-disk dir or an in-binary map). */
interface SpaSource {
  /** Resolve a non-`/` request to a concrete asset, or `undefined` to fall back to index. */
  readFile(urlPath: string): Promise<{ body: BodyInit; type: string } | undefined>;
  /** The SPA shell as text, or `undefined` when the source has no `index.html`. */
  readIndex(): Promise<string | undefined>;
}

function diskSpaSource(webDir: string): SpaSource {
  return {
    async readFile(urlPath) {
      const filePath = resolveWithin(webDir, urlPath);
      if (filePath === undefined) return undefined;
      const file = Bun.file(filePath);
      if (!(await file.exists())) return undefined;
      return { body: file, type: contentTypeFor(filePath) };
    },
    async readIndex() {
      const indexFile = Bun.file(resolve(webDir, "index.html"));
      if (!(await indexFile.exists())) return undefined;
      return indexFile.text();
    },
  };
}

function embeddedSpaSource(map: Record<string, { type: string; base64: string }>): SpaSource {
  const get = (key: string): { body: BodyInit; type: string } | undefined => {
    const entry = map[key];
    if (entry === undefined) return undefined;
    return { body: Buffer.from(entry.base64, "base64"), type: entry.type };
  };
  return {
    readFile(urlPath) {
      return Promise.resolve(get(urlPath.replace(/^\/+/, "")));
    },
    readIndex() {
      const entry = map["index.html"];
      if (entry === undefined) return Promise.resolve(undefined);
      return Promise.resolve(Buffer.from(entry.base64, "base64").toString("utf8"));
    },
  };
}

/**
 * Serve the SPA for a non-`/api` request from a {@link SpaSource}: a real asset
 * is returned as-is; anything else (including `/`, client routes, and traversal
 * attempts) falls back to the injected `index.html`. A missing `index.html`
 * yields 404 (API-only).
 */
async function serveSpa(
  source: SpaSource,
  path: string,
  token: string | undefined,
): Promise<Response> {
  if (path !== "/") {
    const asset = await source.readFile(path);
    if (asset !== undefined) {
      return new Response(asset.body, { headers: { "content-type": asset.type } });
    }
  }
  const index = await source.readIndex();
  if (index === undefined) return json({ error: "not found" }, 404);
  return new Response(injectKqLocal(index, token), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Pick the active SPA source: an on-disk `webDir` wins; otherwise a non-empty
 * `embeddedSpa` map; otherwise `undefined` (API-only — unknown routes → 404).
 */
function selectSpaSource(opts: GuiServerOptions): SpaSource | undefined {
  if (opts.webDir !== undefined) return diskSpaSource(opts.webDir);
  if (opts.embeddedSpa !== undefined && Object.keys(opts.embeddedSpa).length > 0) {
    return embeddedSpaSource(opts.embeddedSpa);
  }
  return undefined;
}

export function createGuiServer(backend: TuiBackend, opts: GuiServerOptions): GuiServer {
  const spa = selectSpaSource(opts);

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (spa !== undefined && !path.startsWith("/api/") && path !== "/api") {
      if (method === "GET" || method === "HEAD") {
        return serveSpa(spa, path, opts.token);
      }
      return json({ error: "not found" }, 404);
    }

    if (method === "POST" && path === "/api/auth/login") {
      return json({ token: opts.token ?? "local-dev", expiresIn: 86400 });
    }
    if (method === "GET" && path === "/api/auth/oidc/config-public") {
      return json({ enabled: false, providerName: "" });
    }

    if (opts.token && !isAuthorized(req, opts.token)) {
      return json({ error: "unauthorized" }, 401);
    }

    if (isServerOnly(path)) {
      return json({ error: "not available in local mode" }, 404);
    }

    if (method === "GET" && path === "/api/capabilities") {
      return json(backend.capabilities);
    }

    try {
      if (path === "/api/jobs") {
        if (method === "GET") {
          return json({ jobs: (await backend.listJobs()).map(toJobRow) });
        }
        if (method === "POST") {
          const body = await readJsonObject(req);
          const parsed = JobSubmitSchema.safeParse(body);
          if (!parsed.success) {
            return json({ error: "body must match JobSubmit" }, 400);
          }
          const supportedKeys = new Set(["name", "command", "resources", "workingDir", "envVars"]);
          const unsupported = Object.keys(parsed.data).filter((key) => !supportedKeys.has(key));
          if (unsupported.length > 0) {
            return json(
              {
                error: `not available in local mode: ${unsupported.join(", ")}`,
                unsupported: true,
              },
              501,
            );
          }
          const { name, command, resources, workingDir, envVars } = parsed.data;
          const defaultWorkingDir = backend.info.target.startsWith("kubernetes ")
            ? ""
            : process.cwd();
          const localSpec = {
            name,
            command,
            workingDir: workingDir?.trim() || defaultWorkingDir,
            ...(envVars ? { envVars } : {}),
            cpus: resources.cpus,
            memoryMb: resources.memoryMb,
            gpus: resources.gpus ?? 0,
            wallTimeSec: resources.wallTimeSec ?? 0,
          };
          return json(await backend.submitFromSpec(JSON.stringify(localSpec)), 201);
        }
      }

      const logsMatch = path.match(/^\/api\/jobs\/([^/]+)\/logs$/);
      if (logsMatch?.[1] && method === "GET") {
        const id = decodeURIComponent(logsMatch[1]);
        return json({ text: await backend.getJobLogs(id, 1000) });
      }

      const cancelMatch = path.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch?.[1] && method === "POST") {
        const id = decodeURIComponent(cancelMatch[1]);
        await backend.cancelJob(id);
        return json(toJobDetail(await backend.getJobDetail(id)));
      }

      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch?.[1] && method === "GET") {
        const id = decodeURIComponent(jobMatch[1]);
        return json(toJobDetail(await backend.getJobDetail(id)));
      }

      if (path === "/api/workflows" || path === "/api/workflows/run") {
        if (method === "GET" && path === "/api/workflows") {
          return json({ runs: (await backend.listWorkflows()).map(toWorkflowRunRow) });
        }
        if (method === "POST") {
          const body = await readJsonObject(req);
          const yaml = body?.yaml;
          if (typeof yaml !== "string") {
            return json({ error: "body must be { yaml: string }" }, 400);
          }
          const result = await backend.submitWorkflow(yaml);
          return json({ runId: result.id, name: result.name ?? "", status: "submitted" }, 202);
        }
      }

      const workflowMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
      if (workflowMatch?.[1] && method === "GET") {
        const id = decodeURIComponent(workflowMatch[1]);
        return json(toWorkflowRunDetail(await backend.getWorkflowDetail(id)));
      }

      if (path === "/api/agents" && method === "GET") {
        return json({ agents: (await backend.listAgents()).map(toAgentRow) });
      }

      const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch?.[1] && method === "GET") {
        const id = decodeURIComponent(agentMatch[1]);
        const match = (await backend.listAgents()).map(toAgentRow).find((a) => a.agentId === id);
        return match ? json(match) : json({ error: "not found" }, 404);
      }

      const installedMatch = path.match(/^\/api\/software\/agents\/([^/]+)\/installed$/);
      if (installedMatch?.[1] && method === "GET") {
        return json({ success: true, data: (await backend.listSoftware()).map(toInstalledRow) });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  }

  return { fetch: handle };
}
