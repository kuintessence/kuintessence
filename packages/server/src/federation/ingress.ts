import type { PgDb } from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { FederationAdmission } from "./admission";
import { FederationAgreementExchange } from "./agreement-exchange";
import { FederationCancellationReceiver } from "./cancellation";
import { FederationClosingAutomation } from "./closing-automation";
import { FederationCommercialApprovalExchange } from "./commercial-approval-exchange";
import type { FederationDatasetUseResponder } from "./dataset-use-exchange";
import type { FederationDownloadStorage } from "./download-credential";
import type { FederationExecutionConfirmationService } from "./execution-confirmation";
import { FederationTerminalExchange } from "./execution-terminal-exchange";
import { FederationMarketRequestService } from "./market-requests";
import type { FederationMediaKeyResponder } from "./media-key-exchange";
import { FederationMediaReceiptReceiver } from "./media-receipts";
import type { FederationOutboundService } from "./outbound";
import { FederationReservationProposalService } from "./reservation-proposals";
import { FederationResultReceiptReceiver } from "./result-receipts";
import { type FederationResultDownloadStorage, FederationResultResponder } from "./results";
import { type FederationSigningKey, federationMessageKeyId } from "./signatures";
import { FederationStatusResponder } from "./status";
import { FederationTrustRegistry } from "./trust-registry";
import { FederationUsageExchange } from "./usage-exchange";

const logger = createLogger("federation-ingress");

import type { FederationStorageGuard } from "./storage-capacity";

/** Mount only on the private Unix listener. The Node gateway owns the certificate header. */
export function createFederationIngress(
  db: PgDb,
  signingKey: FederationSigningKey,
  downloads?: FederationResultDownloadStorage,
  materials?: Pick<FederationOutboundService, "materialChunk" | "inputDownload">,
  inputDownloads?: FederationDownloadStorage,
  confirmations?: FederationExecutionConfirmationService,
  storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
  mediaKeys?: Pick<FederationMediaKeyResponder, "respond">,
  datasetUse?: Pick<FederationDatasetUseResponder, "respond">,
) {
  const r = new Hono();
  const trust = new FederationTrustRegistry(db);
  const status = new FederationStatusResponder(db, signingKey);
  r.use("*", bodyLimit({ maxSize: 524288 }));
  r.onError((error, c) => {
    if (error instanceof FederationError) {
      c.header("cache-control", "no-store");
      const status =
        error.code === "ATTESTATION_BACKLOG" || error.code === "STORAGE_PRESSURE"
          ? 503
          : error.code === "INVALID_MESSAGE"
            ? 400
            : error.code === "UNTRUSTED_IDENTITY"
              ? 401
              : 409;
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
    const admission = new FederationAdmission(
      db,
      signingKey,
      localKey,
      undefined,
      confirmations,
      storageGuard,
    );
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
  r.post("/federation/v1/materials", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    if (!materials) return c.json({ error: { code: "TEMPORARILY_UNAVAILABLE" } }, 503);
    const response = await materials.materialChunk(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(response, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  const mediaReceipts = new FederationMediaReceiptReceiver(db, signingKey);
  r.post("/federation/v1/media-receipts", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const response = await mediaReceipts.receive(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(response, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  r.post("/federation/v1/media-keys", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    if (!mediaKeys) throw new FederationError("POLICY_DENIED");
    const response = await mediaKeys.respond(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(response, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  r.post("/federation/v1/dataset-use", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    if (!datasetUse) throw new FederationError("POLICY_DENIED");
    const response = await datasetUse.respond(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(response, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  r.post("/federation/v1/input-downloads", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    if (!inputDownloads || !materials) throw new FederationError("POLICY_DENIED");
    const grant = await materials.inputDownload(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
      inputDownloads,
    );
    return c.body(grant, 200, { "content-type": "application/jose", "cache-control": "no-store" });
  });
  for (const path of ["/federation/v1/terminals", "/federation/v1/terminal-signatures"] as const) {
    r.post(path, async (c) => {
      if (c.req.header("content-type") !== "application/jose")
        return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
      const service = new FederationTerminalExchange(db, signingKey);
      const jws = await c.req.text(),
        fingerprint = c.req.header("x-kq-federation-cert") ?? "";
      const response =
        path === "/federation/v1/terminals"
          ? await service.receiveQuery(jws, fingerprint)
          : await service.receiveDelivery(jws, fingerprint);
      return c.body(response, 200, {
        "content-type": "application/jose",
        "cache-control": "no-store",
      });
    });
  }
  r.post("/federation/v1/market-requests", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const response = await new FederationMarketRequestService(
      db,
      signingKey,
      undefined,
      undefined,
      storageGuard,
    ).receive(await c.req.text(), c.req.header("x-kq-federation-cert") ?? "");
    return c.body(response, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  r.post("/federation/v1/reservation-proposals", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const response = await new FederationReservationProposalService(
      db,
      signingKey,
      undefined,
      undefined,
      storageGuard,
    ).receive(await c.req.text(), c.req.header("x-kq-federation-cert") ?? "");
    return c.body(response, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  r.post("/federation/v1/agreement-approvals", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const response = await new FederationAgreementExchange(db, signingKey).receive(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(response, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  r.post("/federation/v1/commercial-closing", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    try {
      const response = await new FederationClosingAutomation(
        db,
        signingKey,
        undefined,
        storageGuard,
      ).receive(await c.req.text(), c.req.header("x-kq-federation-cert") ?? "");
      return c.body(response, 200, {
        "content-type": "application/jose",
        "cache-control": "no-store",
      });
    } catch (error) {
      if (error instanceof FederationError && error.code === "DATA_WAITING")
        return c.json({ error: { code: "DATA_WAITING" } }, 503);
      throw error;
    }
  });
  r.post("/federation/v1/commercial-approvals", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const response = await new FederationCommercialApprovalExchange(db, signingKey).receive(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(response, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  r.post("/federation/v1/usage", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const report = await new FederationUsageExchange(db, signingKey).receive(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(report, 200, { "content-type": "application/jose", "cache-control": "no-store" });
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
    const receipt = await new FederationCancellationReceiver(
      db,
      signingKey,
      undefined,
      storageGuard,
    ).receive(await c.req.text(), c.req.header("x-kq-federation-cert") ?? "");
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
  r.post("/federation/v1/result-receipts", async (c) => {
    if (c.req.header("content-type") !== "application/jose")
      return c.json({ error: { code: "INVALID_MESSAGE" } }, 415);
    const acknowledgement = await new FederationResultReceiptReceiver(db, signingKey).receive(
      await c.req.text(),
      c.req.header("x-kq-federation-cert") ?? "",
    );
    return c.body(acknowledgement, 200, {
      "content-type": "application/jose",
      "cache-control": "no-store",
    });
  });
  return r;
}
