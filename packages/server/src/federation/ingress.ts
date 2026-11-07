import type { PgDb } from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { FederationAdmission } from "./admission";
import { FederationCancellationReceiver } from "./cancellation";
import { type FederationResultDownloadStorage, FederationResultResponder } from "./results";
import { type FederationSigningKey, federationMessageKeyId } from "./signatures";
import { FederationStatusResponder } from "./status";
import { FederationTrustRegistry } from "./trust-registry";

const logger = createLogger("federation-ingress");

/** Mount only on the private Unix listener. The Node gateway owns the certificate header. */
export function createFederationIngress(
  db: PgDb,
  signingKey: FederationSigningKey,
  downloads?: FederationResultDownloadStorage,
) {
  const r = new Hono();
  const trust = new FederationTrustRegistry(db);
  const status = new FederationStatusResponder(db, signingKey);
  r.use("*", bodyLimit({ maxSize: 524288 }));
  r.onError((error, c) => {
    if (error instanceof FederationError) {
      const status =
        error.code === "INVALID_MESSAGE" ? 400 : error.code === "UNTRUSTED_IDENTITY" ? 401 : 409;
      return c.json({ error: { code: error.code } }, status);
    }
    // No payload, keys, database error or stack trace crosses the institution boundary.
    const incidentId = crypto.randomUUID();
    logger.error(
      { incidentId },
      "Federation admission failed; inspect database and signing-key availability",
    );
    return c.json({ error: { code: "TEMPORARILY_UNAVAILABLE", incidentId } }, 503);
  });
  r.post("/federation/v1/delegations", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const fingerprint = c.req.header("x-kq-federation-cert") ?? "";
    const requestJws = await c.req.text();
    const keyId = federationMessageKeyId(requestJws);
    const now = new Date();
    const senderKey = await trust.resolvePeer(fingerprint, keyId, now);
    const localKey = await trust.resolveKey(signingKey.siteId, signingKey.keyId, now);
    if (!localKey.allowedKinds.includes("acceptance"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const admission = new FederationAdmission(db, signingKey, localKey);
    const result = await admission.receive({
      requestJws,
      senderKey,
      authenticatedPeerSiteId: senderKey.siteId,
      authorize: async (tx, time) => {
        // Fixed site order avoids deadlocks for reciprocal cooperation.
        const sites = [senderKey.siteId, signingKey.siteId].sort();
        for (const site of sites) {
          if (site === senderKey.siteId)
            await trust.assertPeer(tx, fingerprint, site, senderKey.keyId, time);
          else await trust.assertKey(tx, site, signingKey.keyId, time);
        }
      },
    });
    return c.body(result.receiptJws, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  r.post("/federation/v1/status", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const report = await status.receive(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(report, 200, { "content-type": "application/jose", "cache-control": "no-store" });
  });
  r.post("/federation/v1/cancellations", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const receipt = await new FederationCancellationReceiver(db, signingKey).receive(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(receipt, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  r.post("/federation/v1/results", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const report = await new FederationResultResponder(db, signingKey).receive(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(report, 200, { "content-type": "application/jose", "cache-control": "no-store" });
  });
  r.post("/federation/v1/result-downloads", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    if (!downloads) throw new FederationError("POLICY_DENIED");
    const grant = await new FederationResultResponder(db, signingKey).receiveDownload(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
      downloads,
    );
    return c.body(grant, 200, { "content-type": "application/jose", "cache-control": "no-store" });
  });
  return r;
}
