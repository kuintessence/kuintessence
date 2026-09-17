// OIDC Authorization-Code-Flow with PKCE for the CLI.
//
// 1. Spin up local HTTP listener on a random port.
// 2. Open the user's browser to the Server's `/auth/oidc/login` with
//    redirect_uri=http://127.0.0.1:<port>/callback and a CSRF state.
// 3. Wait for the callback (GET /callback?code=...&state=...).
// 4. POST the code to the Server's `/auth/oidc/exchange` and get a token.
// 5. Persist the token via the existing config writer.
//
// All network I/O is injectable so the unit tests can drive the flow
// without a real browser or Server.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Loose fetch shape accepting either the standard fetch or a test fake. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OidcFlowDeps {
  /** Open a URL in the user's browser. Tests override to a no-op. */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Inject the fetch used for the code-exchange POST. */
  fetch?: FetchLike;
  /** Optional fixed local-port for tests; default: random. */
  port?: number;
  /** Total flow timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
}

export interface OidcFlowResult {
  accessToken: string;
  expiresAt?: string;
  principal?: { sub: string; email?: string; name?: string };
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runOidcBrowserFlow(
  serverUrl: string,
  deps: OidcFlowDeps = {},
): Promise<OidcFlowResult> {
  const fetchFn: FetchLike = deps.fetch ?? ((input, init) => fetch(input as string, init));
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const state = randomBytes(16).toString("hex");
  const authBaseUrl = `${serverUrl.replace(/\/+$/, "")}/api/auth/oidc`;
  const { server, port } = await startCallbackListener(deps.port);
  try {
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const authUrl = `${authBaseUrl}/login?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    await openBrowser(authUrl);
    console.error(`If your browser did not open, paste:\n  ${authUrl}\n`);
    const cb = await waitForCallback(server, timeoutMs);
    if (cb.state !== state) {
      throw new Error(`OIDC state mismatch (CSRF check): expected ${state}, got ${cb.state}`);
    }
    const exchange = await fetchFn(`${authBaseUrl}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: cb.code }),
    });
    if (!exchange.ok) {
      throw new Error(`OIDC token exchange failed: HTTP ${exchange.status}`);
    }
    return (await exchange.json()) as OidcFlowResult;
  } finally {
    server.close();
  }
}

interface CallbackPayload {
  code: string;
  state: string;
}

function startCallbackListener(fixedPort?: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(fixedPort ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("could not resolve listener address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function waitForCallback(server: Server, timeoutMs: number): Promise<CallbackPayload> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: CallbackPayload | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    const handleRequest = (req: IncomingMessage, response: ServerResponse): void => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        response.statusCode = 400;
        response.end("Missing code or state");
        finish(new Error("missing code/state in callback"));
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", "text/html");
      response.end(`<html><body style="font-family:system-ui;padding:40px;">
<h2>Sign-in complete</h2>
<p>You can close this tab and return to the CLI.</p>
</body></html>`);
      finish({ code, state });
    };
    const timer = setTimeout(
      () => finish(new Error(`OIDC flow timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    server.on("request", handleRequest);
  });
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}
