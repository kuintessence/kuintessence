import { request } from "node:https";
import { FederationSiteInput } from "./trust-registry";

export class FederationDeliveryError extends Error {
  constructor(readonly code: "DELIVERY_UNAVAILABLE" | "INVALID_RECEIPT_RESPONSE") {
    super(code);
  }
}

export type FederationSend = (endpoint: string, jws: string) => Promise<string>;

/** Only registry-approved HTTPS origins; no redirects, proxies or peer-provided URLs. */
export function createFederationSender(tls: {
  cert: string;
  key: string;
  ca: string;
  timeoutMs?: number;
}): FederationSend {
  return (origin, jws) => {
    const endpoint = FederationSiteInput.shape.endpoint.parse(origin);
    if (Buffer.byteLength(jws) > 524288)
      throw new FederationDeliveryError("INVALID_RECEIPT_RESPONSE");
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const req = request(new URL("/federation/v1/delegations", endpoint), {
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
