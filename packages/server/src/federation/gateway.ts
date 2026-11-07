import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import type { TLSSocket } from "node:tls";

export interface FederationGatewayOptions {
  ca: string;
  cert: string;
  key: string;
  socketPath: string;
}

/** Run with Node, never Bun: per-request verified TLS certificate context is mandatory. */
export function createFederationGateway(options: FederationGatewayOptions) {
  if (process.versions.bun) throw new Error("Federation TLS gateway requires Node.js");
  const server = createServer(
    {
      ca: options.ca,
      cert: options.cert,
      key: options.key,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxHeaderSize: 8192,
    },
    async (req, res) => {
      const socket = req.socket as TLSSocket;
      const cert = socket.getPeerCertificate();
      if (!socket.authorized || !cert.raw) {
        res.writeHead(401).end();
        return;
      }
      if (
        req.method !== "POST" ||
        (req.url !== "/federation/v1/delegations" &&
          req.url !== "/federation/v1/status" &&
          req.url !== "/federation/v1/cancellations" &&
          req.url !== "/federation/v1/results" &&
          req.url !== "/federation/v1/result-downloads" &&
          req.url !== "/federation/v1/result-receipts")
      ) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers["content-type"] !== "application/jose") {
        res.writeHead(415).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of req) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += part.length;
          if (bytes > 524288) {
            res.writeHead(413, { connection: "close" }).end();
            return;
          }
          chunks.push(part);
        }
      } catch {
        res.writeHead(400).end();
        return;
      }
      const upstream = httpRequest(
        {
          socketPath: options.socketPath,
          method: "POST",
          path: req.url,
          // Deliberate allowlist: never forward client identity, cookies, authorization or proxy headers.
          headers: {
            "content-type": "application/jose",
            "content-length": bytes,
            "x-kq-federation-cert": createHash("sha256").update(cert.raw).digest("hex"),
          },
          timeout: 15000,
        },
        (reply) => {
          const output: Buffer[] = [];
          let size = 0;
          reply.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 524288) {
              reply.destroy();
              upstream.destroy();
              return;
            }
            output.push(chunk);
          });
          reply.on("end", () => {
            res
              .writeHead(reply.statusCode ?? 502, {
                "content-type":
                  reply.headers["content-type"] === "application/jose"
                    ? "application/jose"
                    : "application/json",
                "cache-control": "no-store",
              })
              .end(Buffer.concat(output));
          });
          reply.on("error", () => {
            if (!res.writableEnded) res.writeHead(502).end();
          });
        },
      );
      res.on("close", () => upstream.destroy());
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.writableEnded) res.writeHead(502).end();
      });
      upstream.end(Buffer.concat(chunks));
    },
  );
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.setTimeout(20000, (socket) => socket.destroy());
  return server;
}
