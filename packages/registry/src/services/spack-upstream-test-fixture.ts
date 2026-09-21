import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";

export const UPSTREAM_HOST = "upstream.example.test";
export const UPSTREAM_ORIGIN = `https://${UPSTREAM_HOST}`;
export const PINNED_ADDRESS = "93.184.216.34";
export const UPSTREAM_BYTES = Buffer.concat([
  Buffer.from("Spack upstream integration fixture\0", "utf8"),
  Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
  Buffer.alloc(128 * 1024, 0xa5),
]);

export type ProxyTransport = "http" | "socks5" | "socks5h";
export type OriginMode =
  | "ok"
  | "redirect"
  | "overflow"
  | "chunked-overflow"
  | "short"
  | "idle"
  | "drip"
  | "slow";

export interface TestCertificate {
  caBundle: string;
  cert: Buffer;
  key: Buffer;
  dispose(): Promise<void>;
}

// This subprocess is invoked only by the test runner, never during fixture import.
export async function createTestCertificate(): Promise<TestCertificate> {
  const directory = await mkdtemp(join(tmpdir(), "kq-upstream-cert-"));
  const caBundle = join(directory, "certificate.pem");
  const keyPath = join(directory, "private-key.pem");
  let key: Buffer | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "/usr/bin/openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-sha256",
          "-days",
          "1",
          "-subj",
          `/CN=${UPSTREAM_HOST}`,
          "-addext",
          `subjectAltName=DNS:${UPSTREAM_HOST}`,
          "-addext",
          "basicConstraints=critical,CA:TRUE",
          "-keyout",
          keyPath,
          "-out",
          caBundle,
        ],
        { stdio: "ignore", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      let failed = false;
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failed || code !== 0) reject(new Error("Ephemeral TLS certificate generation failed"));
        else resolve();
      });
    });
    key = await readFile(keyPath);
    const cert = await readFile(caBundle);
    await rm(keyPath);
    const privateKey = key;
    return {
      caBundle,
      cert,
      key: privateKey,
      async dispose() {
        privateKey.fill(0);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch {
    key?.fill(0);
    await rm(directory, { recursive: true, force: true });
    throw new Error("Could not prepare ephemeral upstream TLS fixture");
  }
}

interface Destination {
  host: string;
  port: number;
  addressType: "ipv4" | "authority";
}

interface OriginRequest {
  path: string | undefined;
  host: string | undefined;
  sni: string | false | null;
  hasProxyAuthorization: boolean;
  hasAuthorization: boolean;
  hasInheritedSecret: boolean;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new Error("Could not start loopback upstream fixture"));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback fixture port");
  return address.port;
}

export async function bounded<T>(promise: Promise<T>, timeoutMs = 2_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Upstream fixture wait exceeded budget")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  let interval: ReturnType<typeof setInterval> | undefined;
  try {
    await bounded(
      new Promise<void>((resolve) => {
        if (predicate()) return resolve();
        interval = setInterval(() => {
          if (predicate()) resolve();
        }, 10);
      }),
    );
  } finally {
    clearInterval(interval);
  }
}

class LoopbackProxy {
  readonly server: Server;
  readonly destinations: Destination[] = [];
  readonly authentication: boolean[] = [];
  connections = 0;
  port = 0;
  requireAuthentication = true;
  rejectAuthentication = false;

  constructor(
    private readonly fixture: UpstreamTestFixture,
    private readonly transport: "http" | "socks5",
  ) {
    this.server = createServer((socket) => this.accept(socket));
    this.server.maxConnections = 8;
  }

  async start(): Promise<void> {
    this.port = await listen(this.server);
  }

  private accept(socket: Socket): void {
    this.connections += 1;
    this.fixture.track(socket);
    let buffer = Buffer.alloc(0);
    let phase = this.transport === "http" ? "http" : "greeting";
    let authenticated = false;
    const fail = (reason: string) => {
      this.fixture.protocolFailures.push(reason);
      socket.destroy();
    };
    const bridge = (destination: Destination, reply: Buffer) => {
      this.destinations.push(destination);
      // Never connect to an observed destination: only the pinned test tuple is accepted.
      if (destination.host !== PINNED_ADDRESS || destination.port !== 443) {
        fail("Proxy received an unexpected pinned destination");
        return;
      }
      phase = "tunnel";
      socket.pause();
      socket.removeListener("data", onData);
      const upstream = connect({ host: "127.0.0.1", port: this.fixture.originPort });
      this.fixture.track(upstream);
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => {
        if (!upstream.readableEnded) socket.destroy();
      });
      upstream.once("connect", () => {
        socket.write(reply);
        if (buffer.length) upstream.write(buffer);
        buffer = Buffer.alloc(0);
        socket.pipe(upstream).pipe(socket);
        socket.resume();
      });
    };
    const onData = (chunk: Buffer) => {
      if (buffer.length + chunk.length > 16 * 1024) {
        fail("Proxy handshake exceeded its byte budget");
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (!socket.destroyed) {
        if (phase === "http") {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const lines = buffer.subarray(0, end).toString("ascii").split("\r\n");
          buffer = buffer.subarray(end + 4);
          const request = /^CONNECT ([0-9.]+):([0-9]+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
          if (!request) return fail("Proxy expected a numeric HTTP CONNECT authority");
          const authorization = lines
            .find((line) => line.toLowerCase().startsWith("proxy-authorization:"))
            ?.slice("proxy-authorization:".length)
            .trim();
          const credentials = `${this.fixture.username}:${this.fixture.password}`;
          const expected = Buffer.from(credentials).toString("base64");
          authenticated =
            !this.rejectAuthentication &&
            (!this.requireAuthentication || authorization === `Basic ${expected}`);
          this.authentication.push(authenticated);
          if (!authenticated) {
            const body = this.fixture.password;
            socket.end(
              "HTTP/1.1 407 Proxy Authentication Required\r\n" +
                'Proxy-Authenticate: Basic realm="upstream-test"\r\n' +
                `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            );
            return;
          }
          bridge(
            { host: request[1] ?? "", port: Number(request[2]), addressType: "authority" },
            Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"),
          );
          return;
        }
        if (phase === "greeting") {
          if (buffer.length < 2) return;
          const count = buffer[1] ?? 0;
          if (buffer[0] !== 5 || count === 0) return fail("Invalid SOCKS greeting");
          if (buffer.length < count + 2) return;
          const method = this.requireAuthentication ? 2 : 0;
          const offered = buffer.subarray(2, count + 2);
          buffer = buffer.subarray(count + 2);
          if (!offered.includes(method)) {
            socket.end(Buffer.from([5, 255]));
            return;
          }
          socket.write(Buffer.from([5, method]));
          authenticated = method === 0 && !this.rejectAuthentication;
          phase = method === 2 ? "authentication" : "request";
        } else if (phase === "authentication") {
          if (buffer.length < 2) return;
          const usernameLength = buffer[1] ?? 0;
          if (buffer.length < usernameLength + 3) return;
          const passwordLength = buffer[usernameLength + 2] ?? 0;
          const length = usernameLength + passwordLength + 3;
          if (buffer.length < length) return;
          authenticated =
            buffer[0] === 1 &&
            !this.rejectAuthentication &&
            buffer.subarray(2, usernameLength + 2).toString() === this.fixture.username &&
            buffer.subarray(usernameLength + 3, length).toString() === this.fixture.password;
          buffer = buffer.subarray(length);
          this.authentication.push(authenticated);
          if (!authenticated) {
            socket.end(Buffer.from([1, 1]));
            return;
          }
          socket.write(Buffer.from([1, 0]));
          phase = "request";
        } else if (phase === "request") {
          if (buffer.length < 4) return;
          if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0 || buffer[3] !== 1) {
            return fail("SOCKS request did not contain a pinned numeric IPv4 CONNECT");
          }
          if (buffer.length < 10) return;
          if (!authenticated) return fail("SOCKS request bypassed authentication");
          const destination: Destination = {
            host: [...buffer.subarray(4, 8)].join("."),
            port: buffer.readUInt16BE(8),
            addressType: "ipv4",
          };
          buffer = buffer.subarray(10);
          bridge(destination, Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          return;
        } else {
          return;
        }
      }
    };
    socket.on("data", onData);
  }
}

export class UpstreamTestFixture {
  readonly username = `fixture-${randomUUID()}`;
  readonly password = `${randomUUID()}@:/?#%"`;
  readonly requests: OriginRequest[] = [];
  readonly payloads = new Map<string, Uint8Array>();
  readonly protocolFailures: string[] = [];
  readonly http = new LoopbackProxy(this, "http");
  readonly socks = new LoopbackProxy(this, "socks5");
  readonly sockets = new Set<Socket>();
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  private readonly origin: ReturnType<typeof createHttpsServer>;
  originPort = 0;
  mode: OriginMode = "ok";
  dripWrites = 0;

  constructor(certificate: TestCertificate) {
    this.origin = createHttpsServer(
      { key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2" },
      (request, response) => {
        const payload = this.payloads.get(request.url ?? "") ?? UPSTREAM_BYTES;
        this.requests.push({
          path: request.url,
          host: request.headers.host,
          sni: (request.socket as TLSSocket).servername,
          hasProxyAuthorization: request.headers["proxy-authorization"] !== undefined,
          hasAuthorization: request.headers.authorization !== undefined,
          hasInheritedSecret: request.headers["x-inherited-secret"] !== undefined,
        });
        response.setHeader("Connection", "close");
        if (this.mode === "redirect") {
          response.writeHead(302, { Location: `${UPSTREAM_ORIGIN}/redirect-target` });
          response.end();
        } else if (this.mode === "overflow" || this.mode === "chunked-overflow") {
          const bytes = Buffer.concat([payload, Buffer.from([0xff])]);
          if (this.mode === "overflow") response.setHeader("Content-Length", bytes.length);
          response.write(bytes);
          response.end();
        } else if (this.mode === "short") {
          response.end(payload.subarray(1));
        } else if (this.mode === "slow") {
          response.writeHead(200, { "Content-Length": payload.length });
          let offset = 1;
          response.write(payload.subarray(0, offset));
          const timer = setInterval(() => {
            response.write(payload.subarray(offset, offset + 1));
            offset += 1;
            if (offset >= payload.length) {
              clearInterval(timer);
              this.timers.delete(timer);
              response.end();
            }
          }, 120);
          this.timers.add(timer);
          response.once("close", () => {
            clearInterval(timer);
            this.timers.delete(timer);
          });
        } else if (this.mode === "idle" || this.mode === "drip") {
          response.writeHead(200, { "Content-Length": payload.length });
          response.write(payload.subarray(0, 4096));
          if (this.mode === "drip") {
            const timer = setInterval(() => {
              this.dripWrites += 1;
              response.write(payload.subarray(0, 4096));
            }, 100);
            this.timers.add(timer);
            response.once("close", () => {
              clearInterval(timer);
              this.timers.delete(timer);
            });
          }
        } else {
          response.end(payload);
        }
      },
    );
    this.origin.on("connection", (socket) => this.track(socket));
    this.origin.on("secureConnection", (socket) => this.track(socket));
    this.origin.on("tlsClientError", (_error, socket) => socket.destroy());
    this.origin.requestTimeout = 7_000;
    this.origin.headersTimeout = 7_000;
    this.origin.maxConnections = 8;
  }

  async start(): Promise<void> {
    try {
      this.originPort = await listen(this.origin);
      await this.http.start();
      await this.socks.start();
    } catch {
      await this.close();
      throw new Error("Could not start upstream integration fixture");
    }
  }

  proxy(transport: ProxyTransport): LoopbackProxy {
    return transport === "http" ? this.http : this.socks;
  }

  proxyUrl(transport: ProxyTransport, credentials = true): string {
    const auth = credentials
      ? `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}@`
      : "";
    return `${transport}://${auth}127.0.0.1:${this.proxy(transport).port}`;
  }

  track(socket: Socket): void {
    if (this.sockets.has(socket)) return;
    this.sockets.add(socket);
    // An absolute deadline also bounds broken clients that keep trickling data.
    const timer = setTimeout(() => socket.destroy(), 7_000);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
    });
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    const closing = [this.origin, this.http.server, this.socks.server].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close((error) => {
            if (error) reject(new Error("Could not close upstream fixture listener"));
            else resolve();
          });
        }),
    );
    for (const socket of this.sockets) socket.destroy();
    await bounded(Promise.all(closing));
  }
}

// Linux Actions only. Inspect the real child without mocking spawn or logging its environment.
export async function inspectCurlChild(): Promise<{ args: string[]; environment: string[] }> {
  const tasks = join("/proc", String(process.pid), "task");
  const children = new Set<string>();
  for (const task of await readdir(tasks)) {
    try {
      const ids = (await readFile(join(tasks, task, "children"), "utf8")).trim();
      for (const id of ids.split(/\s+/)) if (id) children.add(id);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  const matches: { args: string[]; environment: string[] }[] = [];
  for (const id of children) {
    try {
      const args = (await readFile(`/proc/${id}/cmdline`, "utf8")).split("\0").filter(Boolean);
      if (args[0] !== "/usr/bin/curl") continue;
      const environment = (await readFile(`/proc/${id}/environ`, "utf8")).split("\0").filter(Boolean);
      matches.push({ args, environment });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  if (matches.length !== 1 || !matches[0]) throw new Error("Expected one live upstream curl child");
  return matches[0];
}
