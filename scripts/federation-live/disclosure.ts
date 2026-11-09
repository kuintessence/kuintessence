import assert from "node:assert/strict";
import { createPublicKey, randomUUID } from "node:crypto";
import {
  createPgDb,
  federationCommercialAgreements,
  federationCommercialBills,
  federationCommercialSubmissions,
  federationDisclosurePolicies,
  federationDisclosures,
  federationEvidenceCases,
  federationReceivedDisclosures,
  federationSigningKeys,
  jobs,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { FederationPermissionService } from "../../packages/server/src/federation/permissions";
import { FederationTrustRegistry } from "../../packages/server/src/federation/trust-registry";

const root = z.string().min(1).parse(process.env.LAB_ROOT);
const peerSchema = z.object({ siteId: z.uuid(), keyId: z.string(), publicKeyPem: z.string() });
const config = z
  .object({
    source: peerSchema,
    target: peerSchema,
    terms: z.object({ validFrom: z.iso.datetime(), validUntil: z.iso.datetime() }),
  })
  .parse(await Bun.file(`${root}/source-init.json`).json());
const recipient = z
  .object({ siteId: z.uuid() })
  .parse(await Bun.file(`${root}/disclosure-recipient.json`).json());
const urls = [
  process.env.SOURCE_DATABASE_URL,
  process.env.DATABASE_URL,
  process.env.LAB_RECIPIENT_DATABASE_URL,
];
const databases = urls.map((raw) => {
  const url = z.string().min(1).parse(raw);
  assert(new URL(url).pathname.startsWith("/kuintessence_unit_"));
  return createPgDb(url);
});
assert.equal(new Set(urls).size, 3, "Each institution needs its own database");
const [source, provider, receiver] = databases;
assert(source && provider && receiver);
try {
  if (process.argv[2] === "setup") {
    const actorSchema = z.object({ userId: z.uuid(), orgId: z.uuid() });
    const actors = [
      actorSchema.parse(await Bun.file(`${root}/source-actor.json`).json()),
      actorSchema.parse(await Bun.file(`${root}/registration.json`).json()),
    ];
    const addedKinds = [
      "commercial-disclosure-policy",
      "commercial-disclosure",
      "commercial-disclosure-read-query",
      "commercial-disclosure-read-authorization",
      "commercial-disclosure-download-query",
    ] as const;
    const receiverActor = { userId: randomUUID(), orgId: randomUUID() };
    await receiver.insert(orgs).values({ id: receiverActor.orgId, name: "Evidence recipient" });
    await receiver.insert(users).values({
      id: receiverActor.userId,
      orgId: receiverActor.orgId,
      email: "recipient-admin@test.invalid",
      role: "platform_admin",
    });
    await receiver.insert(userOrgMemberships).values({ ...receiverActor, role: "owner" });
    await new FederationPermissionService(receiver).set(
      { ...receiverActor, capability: "disclosure.receive", enabled: true },
      receiverActor.userId,
    );
    const peers = [
      config.source,
      config.target,
      {
        siteId: recipient.siteId,
        keyId: "recipient-1",
        publicKeyPem: createPublicKey(await Bun.file(`${root}/recipient-signing.pem`).text())
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    ];
    for (const [index, db] of databases.entries()) {
      const actor = index === 2 ? receiverActor : actors[index];
      assert(actor);
      const trust = new FederationTrustRegistry(db);
      for (const peer of peers) {
        const existing = await db
          .select()
          .from(federationSigningKeys)
          .where(
            and(
              eq(federationSigningKeys.siteId, peer.siteId),
              eq(federationSigningKeys.keyId, peer.keyId),
            ),
          );
        if (existing[0]) {
          // Test trust configuration only; no business records or signatures are copied.
          await db
            .update(federationSigningKeys)
            .set({ allowedKinds: [...new Set([...existing[0].allowedKinds, ...addedKinds])] })
            .where(
              and(
                eq(federationSigningKeys.siteId, peer.siteId),
                eq(federationSigningKeys.keyId, peer.keyId),
              ),
            );
        } else {
          const endpoint =
            peer.siteId === config.source.siteId
              ? process.env.LAB_SOURCE_ORIGIN
              : peer.siteId === config.target.siteId
                ? process.env.LAB_TARGET_ORIGIN
                : "https://recipient.test.invalid";
          await trust.addSite(
            { id: peer.siteId, name: peer.keyId, endpoint: z.string().parse(endpoint) },
            actor.userId,
          );
          await trust.addKey(
            peer.siteId,
            {
              keyId: peer.keyId,
              publicKeyPem: peer.publicKeyPem,
              allowedKinds: [...addedKinds],
              validFrom: config.terms.validFrom,
              validUntil: config.terms.validUntil,
            },
            actor.userId,
          );
        }
      }
      if (index < 2) {
        await trust.addCertificate(
          recipient.siteId,
          { certificatePem: await Bun.file(`${root}/recipient-client.crt`).text() },
          actor.userId,
        );
        await new FederationPermissionService(db).set(
          { ...actor, capability: "disclosure.approve", enabled: true },
          actor.userId,
        );
      }
    }
    await Bun.write(`${root}/recipient-actor.json`, JSON.stringify(receiverActor));
  } else {
    assert.equal(process.argv[2], "inspect");
    const cases = await receiver.select().from(federationEvidenceCases);
    const records = await receiver.select().from(federationReceivedDisclosures);
    assert.equal(cases.length, 1);
    assert.equal(records.length, 2);
    for (const row of records) {
      const policies: { approvalJws: string }[][] = await Promise.all(
        [source, provider].map((db) =>
          db
            .select({ approvalJws: federationDisclosurePolicies.approvalJws })
            .from(federationDisclosurePolicies)
            .where(eq(federationDisclosurePolicies.policyId, row.scope.policyId)),
        ),
      );
      const grants: { approvalJws: string; revokedAt: Date | null }[][] = await Promise.all(
        [source, provider].map((db) =>
          db
            .select({
              approvalJws: federationDisclosures.approvalJws,
              revokedAt: federationDisclosures.revokedAt,
            })
            .from(federationDisclosures)
            .where(eq(federationDisclosures.grantId, row.grantId)),
        ),
      );
      assert.equal(row.evidence.policy.sourceJws, policies[0]?.[0]?.approvalJws);
      assert.equal(row.evidence.policy.targetJws, policies[1]?.[0]?.approvalJws);
      assert.equal(row.evidence.disclosure.sourceJws, grants[0]?.[0]?.approvalJws);
      assert.equal(row.evidence.disclosure.targetJws, grants[1]?.[0]?.approvalJws);
      assert(grants[0]?.[0]?.revokedAt || grants[1]?.[0]?.revokedAt);
    }
    for (const table of [
      federationCommercialAgreements,
      federationCommercialBills,
      federationCommercialSubmissions,
      jobs,
    ])
      assert.equal(
        (await receiver.select().from(table)).length,
        0,
        "Recipient acquired unrelated commercial state",
      );
    await Bun.write(
      z.string().min(1).parse(process.env.LAB_EVIDENCE),
      JSON.stringify({ cases, records, commercialStateEmpty: true }, null, 2),
    );
  }
} finally {
  await Promise.all(databases.map((db) => db.$client.end()));
}
