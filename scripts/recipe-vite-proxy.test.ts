import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { IncomingMessage, OutgoingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import config from "../packages/web/vite.config";

type ProxyOptions = Exclude<
  NonNullable<NonNullable<typeof config.server>["proxy"]>[string],
  string
>;

const IMPORT = "/software/api/spack/recipe-repositories/import";
const UPSTREAM_IMPORT = "/software/api/spack/upstream-imports";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signature";
const HOST = "localhost:5173";

function selectedProxy(path: string): string | ProxyOptions | undefined {
  return Object.entries(config.server?.proxy ?? {}).find(([prefix]) =>
    prefix.startsWith("^") ? new RegExp(prefix).test(path) : path.startsWith(prefix),
  )?.[1];
}

function proxyOptions(path: string): ProxyOptions {
  const options = selectedProxy(path);
  if (!options || typeof options === "string") throw new Error(`Missing proxy for ${path}`);
  return options;
}

function forward(
  path: string,
  headers: IncomingMessage["headers"] = {},
  options = proxyOptions(path),
) {
  const events = new EventEmitter();
  options.configure?.(events as Parameters<NonNullable<ProxyOptions["configure"]>>[0], options);
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.url = options.rewrite?.(path) ?? path;
  request.headers = { host: HOST, ...headers };
  const upstream = new OutgoingMessage();
  if (headers.authorization) upstream.setHeader("Authorization", headers.authorization);
  const response = new ServerResponse(request);
  events.emit("proxyReq", upstream, request, response, options, socket);
  socket.destroy();
  return { request, upstream, response };
}

describe("recipe Vite proxy authentication (in memory, no listener)", () => {
  test.each([
    "/software/api/spack/recipe-repositories",
    `${IMPORT}?repository=public%2Fbuiltin`,
    "/software/api/spack/recipe-repositories/id/active",
    "/software/api/spack/recipe-repositories/id/snapshots/commit/archive",
    UPSTREAM_IMPORT,
  ])("bridges the session cookie only into the outgoing Authorization for %s", (path) => {
    const { request, upstream, response } = forward(path, {
      cookie: `other=ignored; kq_access_token=${TOKEN}; kq_refresh_token=not-an-access-token`,
      origin: `http://${HOST}`,
      "sec-fetch-site": "same-origin",
    });
    expect(upstream.getHeader("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.authorization).toBeUndefined();
    expect(response.getHeader("Authorization")).toBeUndefined();
    expect(response.getHeader("Set-Cookie")).toBeUndefined();
    expect(request.listenerCount("data")).toBe(0);
    expect(request.url).toBe(path.replace(/^\/software/, ""));
  });

  test.each([
    "Bearer explicit-token",
    "Basic explicit-auth",
  ])("preserves explicit Authorization %s", (authorization) => {
    const { upstream } = forward(IMPORT, {
      authorization,
      cookie: `kq_access_token=${TOKEN}`,
    });
    expect(upstream.getHeader("Authorization")).toBe(authorization);
  });

  test("allows cookie auth without Origin for same-origin navigation and non-browser clients", () => {
    expect(
      forward(IMPORT, { cookie: `kq_access_token=${TOKEN}` }).upstream.getHeader("Authorization"),
    ).toBe(`Bearer ${TOKEN}`);
  });

  test.each([
    undefined,
    "",
    "kq_refresh_token=refresh-only",
    `other_kq_access_token=${TOKEN}`,
    "kq_access_token=",
    "kq_access_token=bad%0d%0aInjected:yes",
    'kq_access_token="quoted-value"',
    `kq_access_token=${TOKEN}; kq_access_token=${TOKEN}`,
  ])("does not manufacture credentials from absent, invalid, or ambiguous cookies: %s", (cookie) => {
    expect(forward(IMPORT, { cookie }).upstream.getHeader("Authorization")).toBeUndefined();
  });

  test.each([
    { origin: "https://attacker.invalid" },
    { origin: "http://localhost:6000" },
    { origin: "null" },
    { origin: "not a URL" },
    { origin: `http://${HOST}`, "sec-fetch-site": "cross-site" },
    { origin: "https://attacker.invalid", "x-forwarded-host": "attacker.invalid" },
  ])("refuses cookie credential synthesis for a foreign or invalid browser origin: %j", (headers) => {
    expect(
      forward(IMPORT, { ...headers, cookie: `kq_access_token=${TOKEN}` }).upstream.getHeader(
        "Authorization",
      ),
    ).toBeUndefined();
  });

  test.each([
    "/api/spack/recipe-repositories",
    "/platform/api/me/capabilities",
    "/software/v2/public/example",
    "/software/buildcache/public/example",
  ])("does not add a cookie bridge to unrelated proxy routes: %s", (path) => {
    const options = selectedProxy(path);
    if (!options) throw new Error("Expected an existing proxy");
    if (typeof options === "string") return;
    expect(
      forward(path, { cookie: `kq_access_token=${TOKEN}` }, options).upstream.getHeader(
        "Authorization",
      ),
    ).toBeUndefined();
  });

  test("does not bridge an API lookalike prefix", () => {
    expect(
      forward("/software/api-evil", { cookie: `kq_access_token=${TOKEN}` }).upstream.getHeader(
        "Authorization",
      ),
    ).toBeUndefined();
  });

  test("uses only the configured Registry target and never follows upstream redirects", () => {
    const path = `${IMPORT}?repository=public%2Fbuiltin&url=https://attacker.invalid`;
    const options = proxyOptions(path);
    expect(options.target).toBe(proxyOptions("/software/api/spack/recipe-repositories").target);
    expect(options.target).not.toContain("attacker.invalid");
    expect(options.followRedirects).toBe(false);
    expect(proxyOptions("/software/api/spack/recipe-repositories").followRedirects).toBe(false);
  });

  test("allows queued Git processing only on the exact import endpoint", () => {
    const upload = proxyOptions(`${IMPORT}?repository=public%2Fbuiltin`);
    expect(upload.proxyTimeout).toBe(900_000);
    expect(upload.timeout).toBe(900_000);
    for (const path of [
      "/software/api/spack/recipe-repositories",
      `${IMPORT}-other`,
      `${IMPORT}/child`,
      "/software/api/spack/catalog",
    ]) {
      const options = proxyOptions(path);
      expect(options.proxyTimeout).toBeUndefined();
      expect(options.timeout).toBeUndefined();
    }
  });
});

describe("upstream import Vite proxy (in memory, no listener)", () => {
  test.each([UPSTREAM_IMPORT, `${UPSTREAM_IMPORT}?request=example`])(
    "extends only the exact endpoint timeout: %s",
    (path) => {
      const options = proxyOptions(path);
      expect(options.timeout).toBe(1_800_000);
      expect(options.proxyTimeout).toBe(1_800_000);
      expect(options.followRedirects).toBe(false);
      expect(options.target).toBe(proxyOptions("/software/api/spack/catalog").target);
      expect(options.configure).toBe(proxyOptions("/software/api/spack/catalog").configure);
      expect(options.rewrite?.(path)).toBe(path.replace(/^\/software/, ""));
    },
  );

  test.each([
    `${UPSTREAM_IMPORT}-other`,
    `${UPSTREAM_IMPORT}/child`,
    `${UPSTREAM_IMPORT}/`,
    "/software/api/spack/catalog",
  ])("does not extend unrelated or lookalike API timeouts: %s", (path) => {
    const options = proxyOptions(path);
    expect(options.timeout).toBeUndefined();
    expect(options.proxyTimeout).toBeUndefined();
  });

  test("retains explicit credentials over the same-origin cookie", () => {
    const { upstream } = forward(UPSTREAM_IMPORT, {
      authorization: "Bearer explicit-token",
      cookie: `kq_access_token=${TOKEN}`,
      origin: `http://${HOST}`,
    });
    expect(upstream.getHeader("Authorization")).toBe("Bearer explicit-token");
  });

  test.each([
    { origin: "https://attacker.invalid" },
    { origin: "null" },
    { origin: `http://${HOST}`, "sec-fetch-site": "cross-site" },
    { cookie: `kq_access_token=${TOKEN}; kq_access_token=${TOKEN}` },
    { cookie: "kq_access_token=invalid" },
  ])("does not synthesize credentials for an unsafe import request: %j", (headers) => {
    const { upstream } = forward(UPSTREAM_IMPORT, {
      cookie: `kq_access_token=${TOKEN}`,
      ...headers,
    });
    expect(upstream.getHeader("Authorization")).toBeUndefined();
  });
});
