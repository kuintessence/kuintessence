import type { TuiBackend } from "../tui/backend/types";
import { UnsupportedInModeError } from "../tui/backend/types";

/**
 * `kq agent serve` HTTP surface. A pure `fetch` request handler over a
 * {@link TuiBackend} (built by the all-in-one's `selectBackend({local:true})`),
 * so a remote `kq` can drive THIS node's scheduler over the network with no Server.
 *
 * The route contract mirrors {@link TuiBackend} one-to-one so the upcoming
 * `ExternalAgentBackend` client maps cleanly:
 *
 *   GET    /healthz            → { ok: true }                         (no auth)
 *   GET    /info               → TuiBackendInfo
 *   GET    /capabilities       → TuiBackendCapabilities
 *   GET    /jobs               → TuiJob[]
 *   POST   /jobs               → TuiSubmitResult        body { spec }  201
 *   GET    /jobs/:id           → TuiJobDetail
 *   DELETE /jobs/:id           → (empty)                              204
 *   GET    /jobs/:id/logs?lines=N → { logs: string }
 *   GET    /agents             → TuiAgent[]
 *   GET    /software           → TuiSoftware[]
 *   GET    /workflows          → TuiWorkflowRun[]
 *   POST   /workflows          → TuiSubmitResult        body { yaml }  201
 *   GET    /workflows/:id      → TuiWorkflowDetail
 *
 * Errors: a method that throws {@link UnsupportedInModeError} → 501
 * `{ error, unsupported: true }` (the client re-raises it); any other error →
 * 500 `{ error }`; a malformed body → 400; an unknown route → 404.
 *
 * Auth: when `opts.token` is set, every route except `/healthz` requires
 * `Authorization: Bearer <token>` (else 401 `{ error: "unauthorized" }`). With
 * no token, no auth — paired with the command's `127.0.0.1` default bind, that
 * is a localhost-only surface.
 */

export interface AgentServerOptions {
  /** Optional bearer token; when set, every route except `/healthz` requires it. */
  token?: string;
}

export interface AgentServer {
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

/** Defensively parse a JSON object body, requiring a string field `key`.
 *  Returns the value or `undefined` (callers map `undefined` → 400). */
async function readStringField(req: Request, key: string): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function isAuthorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization");
  return header === `Bearer ${token}`;
}

export function createAgentServer(backend: TuiBackend, opts: AgentServerOptions): AgentServer {
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "GET" && path === "/healthz") {
      return json({ ok: true });
    }

    if (opts.token && !isAuthorized(req, opts.token)) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      if (method === "GET" && path === "/info") {
        return json(backend.info);
      }
      if (method === "GET" && path === "/capabilities") {
        return json(backend.capabilities);
      }

      if (path === "/jobs") {
        if (method === "GET") {
          return json(await backend.listJobs());
        }
        if (method === "POST") {
          const spec = await readStringField(req, "spec");
          if (spec === undefined) {
            return json({ error: "body must be { spec: string }" }, 400);
          }
          return json(await backend.submitFromSpec(spec), 201);
        }
      }

      const logsMatch = path.match(/^\/jobs\/([^/]+)\/logs$/);
      if (logsMatch?.[1] && method === "GET") {
        const id = decodeURIComponent(logsMatch[1]);
        const lines = Number(url.searchParams.get("lines") ?? "100");
        const safeLines = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 100;
        return json({ logs: await backend.getJobLogs(id, safeLines) });
      }

      const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
      if (jobMatch?.[1]) {
        const id = decodeURIComponent(jobMatch[1]);
        if (method === "GET") {
          return json(await backend.getJobDetail(id));
        }
        if (method === "DELETE") {
          await backend.cancelJob(id);
          return new Response(null, { status: 204 });
        }
      }

      if (method === "GET" && path === "/agents") {
        return json(await backend.listAgents());
      }

      if (method === "GET" && path === "/software") {
        return json(await backend.listSoftware());
      }

      if (path === "/workflows") {
        if (method === "GET") {
          return json(await backend.listWorkflows());
        }
        if (method === "POST") {
          const yaml = await readStringField(req, "yaml");
          if (yaml === undefined) {
            return json({ error: "body must be { yaml: string }" }, 400);
          }
          return json(await backend.submitWorkflow(yaml), 201);
        }
      }

      const workflowMatch = path.match(/^\/workflows\/([^/]+)$/);
      if (workflowMatch?.[1] && method === "GET") {
        const id = decodeURIComponent(workflowMatch[1]);
        return json(await backend.getWorkflowDetail(id));
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  }

  return { fetch: handle };
}
