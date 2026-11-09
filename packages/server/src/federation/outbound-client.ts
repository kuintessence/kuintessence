import { request } from "node:https";
import { FederationSiteInput } from "./trust-registry";

export class FederationDeliveryError extends Error {
  constructor(readonly code: "DELIVERY_UNAVAILABLE" | "INVALID_RECEIPT_RESPONSE") {
    super(code);
  }
}

export type FederationSend = (
  endpoint: string,
  jws: string,
  path?:
    | "/federation/v1/dispute-freezes"
    | "/federation/v1/disputes"
    | "/federation/v1/delegations"
    | "/federation/v1/agreement-approvals"
    | "/federation/v1/commercial-approvals"
    | "/federation/v1/commercial-closing"
    | "/federation/v1/market-requests"
    | "/federation/v1/reservation-proposals"
    | "/federation/v1/usage"
    | "/federation/v1/terminals"
    | "/federation/v1/terminal-signatures"
    | "/federation/v1/status"
    | "/federation/v1/cancellations"
    | "/federation/v1/results"
    | "/federation/v1/result-downloads"
    | "/federation/v1/result-receipts"
    | "/federation/v1/materials"
    | "/federation/v1/input-downloads"
    | "/federation/v1/media-keys"
    | "/federation/v1/dataset-use"
    | "/federation/v1/media-receipts",
) => Promise<string>;

/** Only registry-approved HTTPS origins; no redirects, proxies or peer-provided URLs. */
export function createFederationSender(tls: {
  cert: string;
  key: string;
  ca: string;
  timeoutMs?: number;
}): FederationSend {
  return (origin, jws, path = "/federation/v1/delegations") => {
    if (
      path !== "/federation/v1/dispute-freezes" &&
      path !== "/federation/v1/disputes" &&
      path !== "/federation/v1/delegations" &&
      path !== "/federation/v1/agreement-approvals" &&
      path !== "/federation/v1/commercial-approvals" &&
      path !== "/federation/v1/commercial-closing" &&
      path !== "/federation/v1/market-requests" &&
      path !== "/federation/v1/reservation-proposals" &&
      path !== "/federation/v1/usage" &&
      path !== "/federation/v1/terminals" &&
      path !== "/federation/v1/terminal-signatures" &&
      path !== "/federation/v1/status" &&
      path !== "/federation/v1/cancellations" &&
      path !== "/federation/v1/results" &&
      path !== "/federation/v1/result-downloads" &&
      path !== "/federation/v1/result-receipts" &&
      path !== "/federation/v1/materials" &&
      path !== "/federation/v1/input-downloads" &&
      path !== "/federation/v1/media-keys" &&
      path !== "/federation/v1/dataset-use" &&
      path !== "/federation/v1/media-receipts"
    )
      throw new FederationDeliveryError("INVALID_RECEIPT_RESPONSE");
    const endpoint = FederationSiteInput.shape.endpoint.parse(origin);
    if (Buffer.byteLength(jws) > 524288)
      throw new FederationDeliveryError("INVALID_RECEIPT_RESPONSE");
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const req = request(new URL(path, endpoint), {
        method: "POST",
        cert: tls.cert,
        key: tls.key,
        ca: tls.ca,
        rejectUnauthorized: true,
        agent: false,
        headers: { "content-type": "application/jose", "content-length": Buffer.byteLength(jws) },
      });
      const timer = setTimeout(() => {
        req.destroy(new FederationDeliveryError("DELIVERY_UNAVAILABLE"));
      }, tls.timeoutMs ?? 10000);
      const fail = (code: FederationDeliveryError["code"]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new FederationDeliveryError(code));
        req.destroy();
      };
      req.once("error", () => fail("DELIVERY_UNAVAILABLE"));
      req.once("response", (res) => {
        if (res.statusCode !== 200 || res.headers["content-type"] !== "application/jose") {
          fail(
            res.statusCode && res.statusCode >= 500
              ? "DELIVERY_UNAVAILABLE"
              : "INVALID_RECEIPT_RESPONSE",
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 524288) {
            fail("INVALID_RECEIPT_RESPONSE");
            return;
          }
          chunks.push(chunk);
        });
        res.once("error", () => fail("DELIVERY_UNAVAILABLE"));
        res.once("aborted", () => fail("DELIVERY_UNAVAILABLE"));
        res.once("end", () => {
          clearTimeout(timer);
          if (!res.complete || size === 0) {
            fail("INVALID_RECEIPT_RESPONSE");
            return;
          }
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
      req.end(jws);
    });
  };
}
