import assert from "node:assert/strict";
import { createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPgDb,
  federationArbitrationPolicies,
  federationArbitrationRevocationDeliveries,
  federationArbitrationRevocationNotices,
  federationCommercialAgreements,
  federationCommercialAttempts,
  federationCommercialSubmissions,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { CommercialAgreementSchema } from "@kuintessence/shared/federation/commercial";
import { z } from "zod";
import { UnixCommercialClient } from "../../packages/server/src/federation/commercial-client";
import { FederationPermissionService } from "../../packages/server/src/federation/permissions";
import { testAgreement } from "../../packages/server/src/federation/test-fixtures";
import { FederationTrustRegistry } from "../../packages/server/src/federation/trust-registry";

const root = z.string().min(1).parse(process.env.LAB_ARBITRATION_ROOT);
const config = z
  .object({
    domainId: z.uuid(),
    sites: z
      .array(
        z.object({
          name: z.enum(["A", "B", "C"]),
          siteId: z.uuid(),
          databaseUrl: z.url(),
          businessKeyFile: z.string(),
          endpoint: z.url(),
          certificateFile: z.string(),
        }),
      )
      .length(3),
  })
  .parse(JSON.parse(await readFile(join(root, "platforms.json"), "utf8")));
assert.equal(new Set(config.sites.map((s) => s.databaseUrl)).size, 3);
const now = new Date(),
  until = new Date(+now + 3600000).toISOString();
const output = z.string().min(1).parse(process.env.LAB_EVIDENCE);
const results: unknown[] = [];
for (const site of config.sites) {
  assert(new URL(site.databaseUrl).pathname.startsWith("/kuintessence_unit_"));
  const db = createPgDb(site.databaseUrl);
  try {
    if (process.argv[2] === "setup") {
      const actor = { userId: randomUUID(), orgId: randomUUID() };
      await db
        .insert(orgs)
        .values({ id: actor.orgId, name: `${site.name} arbitration institution` });
      await db.insert(users).values({
        id: actor.userId,
        orgId: actor.orgId,
        email: `${site.name.toLowerCase()}@test.invalid`,
        role: "platform_admin",
      });
      await db.insert(userOrgMemberships).values({ ...actor, role: "member" });
      if (site.name !== "C")
        for (const capability of ["agreement.approve", "arbitration.approve"] as const)
          await new FederationPermissionService(db).set(
            { ...actor, capability, enabled: true },
            actor.userId,
          );
      const trust = new FederationTrustRegistry(db);
      for (const peer of config.sites) {
        await trust.addSite(
          { id: peer.siteId, name: peer.name, endpoint: peer.endpoint },
          actor.userId,
        );
        await trust.addKey(
          peer.siteId,
          {
            keyId: "batch-1",
            publicKeyPem: createPublicKey(await readFile(peer.businessKeyFile))
              .export({ format: "pem", type: "spki" })
              .toString(),
            allowedKinds: [
              "commercial-agreement",
              "commercial-approval-query",
              "commercial-approval-waiting",
              "commercial-arbitration-policy",
              "commercial-arbitration-revocation",
              "arbitration-revocation-notice",
              "arbitration-revocation-receipt",
            ],
            validFrom: new Date(+now - 60000).toISOString(),
            validUntil: until,
          },
          actor.userId,
        );
        await trust.addCertificate(
          peer.siteId,
          { certificatePem: await readFile(peer.certificateFile, "utf8") },
          actor.userId,
        );
      }
      results.push(actor);
    } else if (process.argv[2] === "snapshot") {
      results.push({
        site: site.name,
        policies: await db.select().from(federationArbitrationPolicies),
        deliveries: await db.select().from(federationArbitrationRevocationDeliveries),
        notices: await db.select().from(federationArbitrationRevocationNotices),
        contracts: await db.select().from(federationCommercialAgreements),
        submissions: await db.select().from(federationCommercialSubmissions),
        attempts: await db.select().from(federationCommercialAttempts),
      });
    } else {
      assert.equal(process.argv[2], "receipts");
      if (site.name === "C") continue;
      const id = z.uuid().parse(process.env.LAB_REVOCATION_ID);
      const client = new UnixCommercialClient(
        join(
          z.string().parse(process.env.LAB_FABRIC_ROOT),
          `live-${site.name}-commercial/commercial.sock`,
        ),
      );
      results.push(
        await client.receipt({
          operation: "get-commercial-receipt",
          domainId: config.domainId,
          recordId: id,
          recordType: "arbitration-revocation",
        }),
      );
    }
  } finally {
    await db.$client.end();
  }
}
if (process.argv[2] === "setup") {
  const a = config.sites.find((s) => s.name === "A"),
    b = config.sites.find((s) => s.name === "B");
  assert(a && b);
  const terms = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: config.domainId,
    salt: randomBytes(32).toString("hex"),
    createdAt: now.toISOString(),
    agreement: {
      ...testAgreement(a.siteId, b.siteId, "bilateral_attested"),
      validFrom: new Date(+now - 60000).toISOString(),
      validUntil: until,
    },
    consideration: "paid",
    priceVersionId: randomUUID(),
    prices: [
      { metric: "job.elapsed", quantityUnit: "job-millisecond", perQuantity: "1000", amount: "1" },
    ],
    termsText: "Private isolated arbitration recovery contract",
  });
  await writeFile(join(root, "terms.json"), JSON.stringify(terms), { mode: 0o600 });
}
await writeFile(output, JSON.stringify(results), { mode: 0o600 });
