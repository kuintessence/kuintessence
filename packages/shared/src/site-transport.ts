/** Explicit site egress. Never changes a signed URL's HTTP authority or TLS identity. */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { type Socket, connect as tcpConnect } from "node:net";
import { type ConnectionOptions, type TLSSocket, connect as tlsConnect } from "node:tls";
import { z } from "zod";

const loopback = z.enum(["127.0.0.1", "::1"]);
const destination = z.object({ host: loopback, port: z.number().int().min(1).max(65535) }).strict();
export interface SiteTransport {
  mode: "ssh-forward" | "http-proxy";
  origins: ReadonlySet<string>;
  forwards: Record<string, z.infer<typeof destination>>;
  proxy?: URL;
  ca?: string;
  caFile?: string;
}

export function readSiteTransport(env: NodeJS.ProcessEnv = process.env): SiteTransport | undefined {
  const mode = env.KQ_TRANSPORT_MODE;
  if (!mode) return undefined;
  if (mode !== "ssh-forward" && mode !== "http-proxy") throw new Error("Invalid KQ_TRANSPORT_MODE");
  const origins = new Set<string>();
  for (const value of (env.KQ_ALLOWED_ORIGINS ?? "").split(/\s+/).filter(Boolean)) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
      throw new Error("KQ_ALLOWED_ORIGINS must contain HTTPS origins without paths");
    }
    origins.add(value);
  }
  if (!origins.size) throw new Error("KQ_ALLOWED_ORIGINS is required in site transport mode");
  const forwards = z.record(z.string(), destination).parse(JSON.parse(env.KQ_FORWARD_MAP ?? "{}"));
  let proxy: URL | undefined;
  if (mode === "ssh-forward") {
    if ([...origins].some((origin) => !forwards[origin]))
      throw new Error("Missing site origin forwarding mapping");
  } else {
    proxy = new URL(env.KQ_HTTP_PROXY_URL ?? "");
    if (
      proxy.protocol !== "http:" ||
      proxy.pathname !== "/" ||
      proxy.search ||
      proxy.hash ||
      proxy.username ||
      proxy.password
    ) {
      throw new Error(
        "KQ_HTTP_PROXY_URL must be an HTTP origin; use SSH authentication for the local proxy tunnel",
      );
    }
  }
  return {
    mode,
    origins,
    forwards,
    proxy,
    ...(env.KQ_TLS_CA_FILE
      ? { ca: readFileSync(env.KQ_TLS_CA_FILE, "utf8"), caFile: env.KQ_TLS_CA_FILE }
      : {}),
  };
}

export function siteTarget(
  url: URL,
  config: SiteTransport,
): z.infer<typeof destination> | undefined {
  if (!config.origins.has(url.origin) || url.username || url.password || url.hash) {
    throw new Error("Site transport refused an unconfigured destination");
  }
  return config.mode === "ssh-forward" ? config.forwards[url.origin] : undefined;
}

/** Bun fetch paths use the same explicit policy as HTTP/2 and curl. */
export const siteFetch: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const config = readSiteTransport();
    if (!config) return globalThis.fetch(input, init);
    const original = new URL(input instanceof Request ? input.url : String(input));
    const target = siteTarget(original, config);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (headers.has("host") && headers.get("host") !== original.host)
      throw new Error("Site transport Host mismatch");
    headers.set("host", original.host);
    const destinationUrl = new URL(original);
    if (target) {
      destinationUrl.hostname = target.host === "::1" ? "[::1]" : target.host;
      destinationUrl.port = String(target.port);
    }
    const extra = init as (RequestInit & { tls?: Bun.TLSOptions }) | undefined;
    // Automatic redirects would escape the origin policy and, for forwards, lose SNI.
    // Platform machine endpoints must return their final URL, or callers handle redirects explicitly.
    const options = {
      ...init,
      headers,
      redirect: init?.redirect === "manual" ? ("manual" as const) : ("error" as const),
      proxy: config.proxy?.href ?? "",
      tls: {
        ...extra?.tls,
        ...(config.ca ? { ca: config.ca } : {}),
        serverName: original.hostname,
        rejectUnauthorized: true,
      },
    };
    const requestInput =
      input instanceof Request ? new Request(destinationUrl.href, input) : destinationUrl;
    const response = await globalThis.fetch(requestInput, options);
    Object.defineProperty(response, "url", { value: original.href });
    return response;
  },
  { preconnect: globalThis.fetch.preconnect },
);

/** Establish and authenticate TLS before handing the socket to the HTTP/2 manager. */
export async function openSiteTls(
  url: URL,
  config: SiteTransport,
  tls: ConnectionOptions = {},
  signal?: AbortSignal,
): Promise<TLSSocket> {
  const target = siteTarget(url, config);
  const deadline = AbortSignal.timeout(15_000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  abort.throwIfAborted();
  let socket: Socket;
  if (target) {
    socket = tcpConnect(target.port, target.host);
  } else {
    const proxy = config.proxy;
    if (!proxy) throw new Error("Site proxy missing");
    socket = await new Promise<Socket>((resolve, reject) => {
      const req = request(proxy, {
        method: "CONNECT",
        path: `${url.hostname}:${url.port || 443}`,
        headers: { Host: `${url.hostname}:${url.port || 443}` },
        signal: abort,
      });
      req.once("error", reject);
      req.once("connect", (res, connected, head) => {
        if (res.statusCode !== 200 || head.length) {
          connected.destroy();
          reject(new Error("Site CONNECT proxy rejected tunnel"));
          return;
        }
        resolve(connected);
      });
      req.end();
    });
  }
  return new Promise<TLSSocket>((resolve, reject) => {
    const secure = tlsConnect({
      ...tls,
      ...(config.ca ? { ca: config.ca } : {}),
      socket,
      servername: url.hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ["h2"],
    });
    const onAbort = () => secure.destroy(new Error("Site TLS connection aborted"));
    abort.addEventListener("abort", onAbort, { once: true });
    if (abort.aborted) onAbort();
    secure.once("error", (error) => {
      abort.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(error);
    });
    secure.once("secureConnect", () => {
      abort.removeEventListener("abort", onAbort);
      if (secure.alpnProtocol !== "h2") {
        secure.destroy();
        reject(new Error("Site gateway did not negotiate HTTP/2"));
      } else resolve(secure);
    });
  });
}

export function siteCurlArgs(url: string, config = readSiteTransport()): string[] {
  if (!config) return [];
  const parsed = new URL(url);
  const target = siteTarget(parsed, config);
  return [
    "--proto",
    "=https",
    "--location",
    "--max-redirs",
    "0",
    ...(config.caFile ? ["--cacert", config.caFile] : []),
    ...(target
      ? [
          "--noproxy",
          "*",
          "--connect-to",
          `${parsed.hostname}:${parsed.port || 443}:${target.host === "::1" ? "[::1]" : target.host}:${target.port}`,
        ]
      : ["--noproxy", "", "--proxy", config.proxy?.href ?? ""]),
  ];
}
