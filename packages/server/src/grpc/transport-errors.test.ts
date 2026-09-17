import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Http2Server } from "node:http2";
import type { Socket } from "node:net";
import forge from "node-forge";
import type { Logger } from "pino";
import { attachGrpcTransportErrorHandlers } from "./transport-errors";

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code === "ECONNRESET" ? "socket hang up" : "server failed"), {
    code,
  });
}

function setup(secure = true) {
  const server = new EventEmitter();
  const logger = {
    debug: mock(() => {}),
    fatal: mock(() => {}),
    warn: mock(() => {}),
  };
  const exit = mock(() => {});
  attachGrpcTransportErrorHandlers(
    server as unknown as Http2Server,
    logger as unknown as Pick<Logger, "debug" | "fatal" | "warn">,
    { secure, exit },
  );
  return { exit, logger, server };
}

function selfSignedServerCertificate(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 60_000);
  const subject = [{ name: "commonName", value: "localhost" }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe("gRPC transport errors", () => {
  test("keeps a peer TLS handshake reset connection-local", () => {
    const { exit, logger, server } = setup();
    const socket = Object.assign(new EventEmitter(), {
      remoteAddress: "10.0.0.5",
      remotePort: 45123,
    });
    server.emit("connection", socket as unknown as Socket);

    server.emit("tlsClientError", errorWithCode("ECONNRESET"), socket as unknown as Socket);
    socket.emit("error", errorWithCode("ECONNRESET"));

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test("handles a reset emitted by the accepted socket", () => {
    const { exit, logger, server } = setup();
    const socket = new EventEmitter();
    server.emit("connection", socket as unknown as Socket);

    socket.emit("error", errorWithCode("ECONNRESET"));

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test("logs a malformed TLS handshake without terminating the server", () => {
    const { exit, logger, server } = setup();

    server.emit("tlsClientError", errorWithCode("ERR_SSL_WRONG_VERSION_NUMBER"), {} as Socket);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test("keeps unexpected server errors fail-fast", () => {
    const { exit, logger, server } = setup();

    server.emit("error", errorWithCode("EADDRINUSE"));

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("does not register a TLS listener in plaintext mode", () => {
    const { server } = setup(false);

    expect(server.listenerCount("tlsClientError")).toBe(0);
  });

  test("survives a real TLS client disconnect during handshake", async () => {
    const certificate = selfSignedServerCertificate();
    const moduleUrl = new URL("./transport-errors.ts", import.meta.url).href;
    const script = `
      import { createSecureServer } from "node:http2";
      import { connect } from "node:net";
      import { attachGrpcTransportErrorHandlers } from ${JSON.stringify(moduleUrl)};

      const server = createSecureServer(${JSON.stringify(certificate)}, () => {});
      const logger = { debug() {}, fatal() {}, warn() {} };
      attachGrpcTransportErrorHandlers(server, logger, { secure: true });
      let handshakeErrorCode = null;
      server.on("tlsClientError", (error) => {
        handshakeErrorCode = error.code ?? null;
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      await new Promise((resolve) => {
        const socket = connect(address.port, "127.0.0.1");
        socket.once("connect", () => {
          socket.write(Buffer.from([0x16, 0x03, 0x03, 0x00, 0x20]));
          socket.destroy();
          resolve();
        });
        socket.once("error", resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!handshakeErrorCode) throw new Error("TLS handshake error was not observed");
      await new Promise((resolve) => server.close(resolve));
      process.stdout.write("survived:" + handshakeErrorCode);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect({ exitCode, stderr, stdout }).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "survived:ECONNRESET",
    });
  }, 15_000);
});
