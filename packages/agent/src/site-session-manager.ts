import type { ClientHttp2Stream } from "node:http2";
import type { ConnectionOptions } from "node:tls";
import { Http2SessionManager, type Http2SessionOptions } from "@connectrpc/connect-node";
import { openSiteTls, type SiteTransport } from "@kuintessence/shared/site-transport";

class SiteSessionReconnectRequired extends Error {}

/** Keeps connect-node's ping/flow control while establishing CONNECT asynchronously. */
export function siteSessionManager(
  authority: string,
  config: SiteTransport,
  options: Http2SessionOptions,
  tls: ConnectionOptions,
) {
  let current: Http2SessionManager | undefined;
  let pending: Promise<Http2SessionManager> | undefined;
  const streams = new WeakMap<ClientHttp2Stream, Http2SessionManager>();
  async function manager(): Promise<Http2SessionManager> {
    if (current && !["closed", "error"].includes(current.state())) return current;
    pending ??= (async () => {
      const socket = await openSiteTls(new URL(authority), config, tls);
      let used = false;
      const next = new Http2SessionManager(authority, options, {
        createConnection() {
          if (used)
            throw new SiteSessionReconnectRequired("A new authenticated tunnel is required");
          used = true;
          return socket;
        },
      });
      const state = await next.connect();
      if (state === "error") {
        socket.destroy();
        throw next.error();
      }
      current = next;
      return next;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  return {
    authority,
    async request(...args: Parameters<Http2SessionManager["request"]>) {
      for (let refreshes = 0; ; refreshes++) {
        const active = await manager();
        try {
          const stream = await active.request(...args);
          streams.set(stream, active);
          return stream;
        } catch (error) {
          if (current === active) current = undefined;
          // GOAWAY and idle verification can require a fresh socket before a stream exists.
          // Keep a draining manager alive so its accepted streams can finish.
          if (error instanceof SiteSessionReconnectRequired) {
            if (refreshes === 0) continue;
            throw error;
          }
          active.abort(error instanceof Error ? error : new Error("Site HTTP/2 request failed"));
          throw error;
        }
      }
    },
    notifyResponseByteRead(stream: ClientHttp2Stream) {
      streams.get(stream)?.notifyResponseByteRead(stream);
    },
  };
}
