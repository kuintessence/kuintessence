import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSiteTransport, siteFetch } from "@kuintessence/shared/site-transport";
import { siteSessionManager } from "./site-session-manager";
import { downloadToFile } from "./staging/download-to-file";

const dir = mkdtempSync(join(tmpdir(), "kq-site-tls-"));
const saved = { ...process.env };
const server = createSecureServer;
let gateway: ReturnType<typeof server>;
let proxy: ReturnType<typeof createServer>;
let port: number;
let proxyPort: number;
let seen: string[] = [];
beforeAll(async () => {
  writeFileSync(
    join(dir, "ext"),
    "subjectAltName=DNS:site.invalid\nextendedKeyUsage=serverAuth,clientAuth\n",
  );
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=KQ test CA",
    "-days",
    "1",
  ]);
  run([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "site.key",
    "-out",
    "site.csr",
    "-subj",
    "/CN=site.invalid",
  ]);
  run([
    "x509",
    "-req",
    "-in",
    "site.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "site.crt",
    "-days",
    "1",
    "-extfile",
    "ext",
  ]);
  gateway = createSecureServer({
    key: readFileSync(join(dir, "site.key")),
    cert: readFileSync(join(dir, "site.crt")),
    ca: readFileSync(join(dir, "ca.crt")),
    allowHTTP1: true,
    requestCert: true,
    rejectUnauthorized: true,
  });
  gateway.on("request", (req, res) => {
    seen.push(String(req.headers.host ?? req.headers[":authority"]));
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "https://elsewhere.invalid/" });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => res.end(`${req.url}|${Buffer.concat(chunks)}`));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("test bind");
  port = address.port;
  proxy = createServer();
  proxy.on("connect", (req, socket, head) => {
    if (req.url !== "site.invalid:443") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const bound = proxy.address();
  if (!bound || typeof bound === "string") throw new Error("test bind");
  proxyPort = bound.port;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("KQ_")) delete process.env[key];
  Object.assign(process.env, saved);
  seen = [];
});
afterAll(() => {
  gateway.close();
  proxy.close();
  rmSync(dir, { recursive: true, force: true });
});
function configure(mode: "ssh-forward" | "http-proxy") {
  process.env.KQ_TRANSPORT_MODE = mode;
  process.env.KQ_ALLOWED_ORIGINS = "https://site.invalid";
  process.env.KQ_FORWARD_MAP = JSON.stringify({
    "https://site.invalid": { host: "127.0.0.1", port },
  });
  process.env.KQ_HTTP_PROXY_URL = `http://127.0.0.1:${proxyPort}`;
  process.env.KQ_TLS_CA_FILE = join(dir, "ca.crt");
}
function identity() {
  return {
    cert: readFileSync(join(dir, "site.crt"), "utf8"),
    key: readFileSync(join(dir, "site.key"), "utf8"),
  };
}
for (const mode of ["ssh-forward", "http-proxy"] as const) {
  test(`${mode}: verified host file download uses the configured HTTPS route`, async () => {
    configure(mode);
    const body = "/artifact?signature=a%2Fb|";
    const targetPath = join(dir, `download-${mode}`);
    const authenticated = Object.assign(
      (input: string | URL | Request, init?: RequestInit) =>
        siteFetch(input, { ...init, tls: identity() } as RequestInit),
      { preconnect: fetch.preconnect },
    );
    await downloadToFile({
      url: "https://site.invalid/artifact?signature=a%2Fb",
      targetPath,
      size: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
      signal: new AbortController().signal,
      fetch: authenticated,
      connectTo: "site.invalid:443:unreachable.invalid:1",
    });
    expect(readFileSync(targetPath, "utf8")).toBe(body);
    expect(seen).toEqual(["site.invalid"]);
  });
  test(`${mode}: HTTPS mTLS, authority, signed query, streaming PUT and no direct fallback`, async () => {
    configure(mode);
    const response = await siteFetch("https://site.invalid/bucket/key?signature=a%2Fb", {
      method: "PUT",
      body: "payload",
      tls: identity(),
    } as RequestInit);
    expect(await response.text()).toBe("/bucket/key?signature=a%2Fb|payload");
    expect(response.url).toBe("https://site.invalid/bucket/key?signature=a%2Fb");
    expect(seen).toEqual(["site.invalid"]);
    await expect(siteFetch("https://elsewhere.invalid/")).rejects.toThrow("unconfigured");
    await expect(
      siteFetch("https://site.invalid/redirect", { tls: identity() } as RequestInit),
    ).rejects.toThrow();
    await expect(siteFetch("https://site.invalid/")).rejects.toThrow();
  });
  test(`${mode}: actual HTTP/2 through mTLS with connection reuse`, async () => {
    configure(mode);
    const config = readSiteTransport();
    if (!config) throw new Error("missing config");
    const manager = siteSessionManager(
      "https://site.invalid",
      config,
      { idleConnectionTimeoutMs: 50 },
      identity(),
    );
    for (let i = 0; i < 2; i++) {
      const stream = await manager.request("POST", "/connect", {}, {});
      stream.end("frame");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
        manager.notifyResponseByteRead(stream);
      }
      expect(Buffer.concat(chunks).toString()).toBe("/connect|frame");
    }
  });
}

for (const mode of ["ssh-forward", "http-proxy"] as const) {
  test(`${mode}: gateway drain and a failed reconnect preserve the accepted stream`, async () => {
    configure(mode);
    const config = readSiteTransport();
    if (!config) throw new Error("missing config");
    const original = gateway.listeners("request");
    gateway.removeAllListeners("request");
    let held: Http2ServerResponse | undefined;
    const serve = (req: Http2ServerRequest, res: Http2ServerResponse) => {
      res.writeHead(200);
      if (req.url === "/held") {
        held = res;
        res.write("before|");
        res.stream.session?.goaway();
      } else res.end("new-tunnel");
    };
    gateway.on("request", serve);
    const manager = siteSessionManager(
      "https://site.invalid",
      config,
      { idleConnectionTimeoutMs: 50 },
      identity(),
    );
    let active: Awaited<ReturnType<typeof manager.request>> | undefined;
    let replacement: Awaited<ReturnType<typeof manager.request>> | undefined;
    let concurrent: Awaited<ReturnType<typeof manager.request>> | undefined;
    try {
      active = await manager.request("GET", "/held", {}, {});
      const drained = new Promise<void>((resolve) =>
        active?.session?.once("goaway", () => resolve()),
      );
      active.end();
      await drained;
      const trustedCa = config.ca;
      config.ca = "untrusted";
      await expect(manager.request("GET", "/not-accepted", {}, {})).rejects.toThrow();
      config.ca = trustedCa;
      [replacement, concurrent] = await Promise.all([
        manager.request("GET", "/replacement", {}, {}),
        manager.request("GET", "/concurrent", {}, {}),
      ]);
      expect(replacement.session).toBe(concurrent.session);
      expect(replacement.session).not.toBe(active.session);
      for (const stream of [replacement, concurrent]) {
        stream.end();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
          manager.notifyResponseByteRead(stream);
        }
        expect(Buffer.concat(chunks).toString()).toBe("new-tunnel");
      }
      held?.end("after");
      const retained: Buffer[] = [];
      for await (const chunk of active) {
        retained.push(Buffer.from(chunk));
        manager.notifyResponseByteRead(active);
      }
      expect(Buffer.concat(retained).toString()).toBe("before|after");
    } finally {
      held?.end();
      active?.destroy();
      replacement?.destroy();
      concurrent?.destroy();
      gateway.removeListener("request", serve);
      for (const listener of original) gateway.on("request", listener);
    }
  });
}
