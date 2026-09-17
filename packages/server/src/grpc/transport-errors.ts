import type { Http2Server } from "node:http2";
import type { Socket } from "node:net";
import type { Logger } from "pino";

type GrpcTransportLogger = Pick<Logger, "debug" | "fatal" | "warn">;
type GrpcTransportServer = Pick<Http2Server, "on">;

export interface GrpcTransportErrorOptions {
  secure: boolean;
  exit?: (code: number) => void;
}

function isConnectionReset(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ECONNRESET";
}

function connectionContext(error: Error, socket?: Socket) {
  return {
    err: error,
    ...(socket?.remoteAddress ? { remoteAddress: socket.remoteAddress } : {}),
    ...(socket?.remotePort ? { remotePort: socket.remotePort } : {}),
  };
}

export function attachGrpcTransportErrorHandlers(
  server: GrpcTransportServer,
  logger: GrpcTransportLogger,
  options: GrpcTransportErrorOptions,
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const reportedTlsErrors = new WeakSet<Socket>();

  server.on("connection", (socket: Socket) => {
    socket.on("error", (error: Error) => {
      if (reportedTlsErrors.has(socket)) return;
      if (isConnectionReset(error)) {
        logger.debug(connectionContext(error, socket), "Agent gRPC connection reset during I/O");
        return;
      }
      logger.warn(connectionContext(error, socket), "Agent gRPC connection failed");
    });
  });

  if (options.secure) {
    server.on("tlsClientError", (error: Error, socket: Socket) => {
      reportedTlsErrors.add(socket);
      if (isConnectionReset(error)) {
        logger.debug(connectionContext(error, socket), "Agent gRPC TLS handshake reset by peer");
        return;
      }
      logger.warn(connectionContext(error, socket), "Agent gRPC TLS handshake failed");
    });
  }

  server.on("error", (error: Error) => {
    if (isConnectionReset(error)) {
      logger.debug(connectionContext(error), "Agent gRPC server observed a connection reset");
      return;
    }
    logger.fatal({ err: error }, "Agent gRPC server failed");
    exit(1);
  });
}
