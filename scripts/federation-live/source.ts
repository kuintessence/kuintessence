import {
  createPgDb,
  federationOutbound,
  orgs,
  softwareAssetRevisions,
  softwareAssets,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { FederationAssetService } from "../../packages/server/src/federation/assets";
import { FederationPermissionService } from "../../packages/server/src/federation/permissions";
import { FederationTrustRegistry } from "../../packages/server/src/federation/trust-registry";
import { SoftwareAvailabilityService } from "../../packages/server/src/services/software-availability";
import { approveContract } from "./business";

const root = z.string().min(1).parse(process.env.LAB_ROOT);
const url = z.string().min(1).parse(process.env.SOURCE_DATABASE_URL);
if (!new URL(url).pathname.startsWith("/kuintessence_unit_")) throw Error("Isolated DB required");
const db = createPgDb(url);
if (process.argv[2] === "inspect") {
  const rows = await db.select().from(federationOutbound);
  await Bun.write(
    `${root}/source-state.json`,
    JSON.stringify(
      rows.map(({ operationId, requestDigest, state, receipt, lastError }) => ({
        operationId,
        requestDigest,
        state,
        receipt,
        lastError,
      })),
    ),
  );
} else {
  const config = await Bun.file(`${root}/source-init.json`).json();
  const actor = { userId: crypto.randomUUID(), orgId: crypto.randomUUID() };
  await db.insert(orgs).values({ id: actor.orgId, name: "Source institution" });
  await db.insert(users).values({
    id: actor.userId,
    orgId: actor.orgId,
    email: "source-admin@test.invalid",
    role: "platform_admin",
  });
  await db.insert(userOrgMemberships).values({ ...actor, role: "member" });
  const trust = new FederationTrustRegistry(db);
  for (const peer of [config.source, config.target]) {
    await trust.addSite(
      {
        id: peer.siteId,
        name: peer.keyId,
        endpoint:
          peer.siteId === config.target.siteId
            ? z.string().min(1).parse(process.env.LAB_TARGET_ORIGIN)
            : "https://source.test.invalid",
      },
      actor.userId,
    );
    await trust.addKey(
      peer.siteId,
      {
        keyId: peer.keyId,
        publicKeyPem: peer.publicKeyPem,
        allowedKinds: [
          "agreement-approval-query",
          "agreement-approval-waiting",
          "commercial-approval-query",
          "commercial-approval-waiting",
          "reservation-proposal-receipt",
          "commercial-agreement",
          "commercial-reservation",
          "commercial-release",
          "commercial-terminal",
          "terminal-query",
          "terminal-chunk",
          "terminal-delivery",
          "terminal-ack",
          "commercial-usage",
          "agreement",
          "delegation",
          "acceptance",
          "status-query",
          "status-report",
          "cancellation",
          "cancellation-receipt",
          "result-query",
          "result-report",
          "result-download-query",
          "result-download-grant",
          "result-receipt",
          "result-receipt-ack",
          "material-query",
          "material-chunk",
        ],
        validFrom: config.terms.validFrom,
        validUntil: config.terms.validUntil,
      },
      actor.userId,
    );
  }
  await trust.addCertificate(
    config.target.siteId,
    { certificatePem: await Bun.file(`${root}/target-client.crt`).text() },
    actor.userId,
  );
  for (const capability of [
    "agreement.approve",
    "delegation.submit",
    "asset.map",
    "result.read",
  ] as const)
    await new FederationPermissionService(db).set(
      { ...actor, capability, enabled: true },
      actor.userId,
    );
  const availability = new SoftwareAvailabilityService(db);
  const assets = new FederationAssetService(db, {
    authorizeSoftware: (id, principal, capability) =>
      availability.assertAssetCapability(id, principal, capability),
  });
  const assetId = crypto.randomUUID(),
    revisionId = crypto.randomUUID();
  await db.insert(softwareAssets).values({
    id: assetId,
    kind: "workflow-template",
    name: "Source file workflow",
    version: "1",
    source: "sp-published",
    lifecycle: "published",
    visibility: "platform-public",
    ownerUserId: actor.userId,
    payload: config.payload,
  });
  await db
    .insert(softwareAssetRevisions)
    .values({ id: revisionId, assetId, revision: 1, payload: config.payload });
  await assets.register(actor, { reference: config.reference, localRevisionId: revisionId });
  await assets.putMaterial(actor, config.source.siteId, config.inputs);
  await assets.putMaterial(actor, config.source.siteId, config.environment);
  const key = {
    siteId: config.source.siteId,
    keyId: config.source.keyId,
    privateKey: await importPKCS8(await Bun.file(`${root}/source-signing.pem`).text(), "RS256"),
  };
  await approveContract(db, actor, key, config.terms, config.commercial);
  await Bun.write(`${root}/source-actor.json`, JSON.stringify(actor));
}
await db.$client.end();
