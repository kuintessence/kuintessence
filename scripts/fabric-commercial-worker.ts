import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPgDb,
  federationCapabilities,
  federationSigningKeys,
  federationSites,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  CommercialAgreementSchema,
  CommercialProposalInputSchema,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { FederationCommercialAgreementService } from "../packages/server/src/federation/commercial-agreements";
import { UnixCommercialClient } from "../packages/server/src/federation/commercial-client";
import { FederationCommercialSubmissionService } from "../packages/server/src/federation/commercial-submissions";
import { Site } from "./fabric-evidence-fixture";

async function main() {
  const root = z.string().parse(process.argv[2]);
  const action = z
    .enum([
      "initialize",
      "approve-direct",
      "approve-attested",
      "approve-mvcc",
      "advance",
      "crash-after-commit",
    ])
    .parse(process.argv[3]);
  const url = process.env.DATABASE_URL;
  if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
    throw new Error("Isolated database required");
  const network = z
    .object({ trust: FabricCommercialTrustSchema, sites: z.array(Site) })
    .parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
  const sites = ["A", "B"].map((name) =>
    Site.parse(network.sites.find((site) => site.name === name)),
  );
  const db = createPgDb(url, { max: 4, idle_timeout: 1 });
  async function signing(index: number) {
    const site = sites[index];
    assert(site);
    const configured = network.trust.organizations.find((org) => org.siteId === site.siteId)
      ?.keys[0];
    assert(configured);
    return {
      siteId: site.siteId,
      keyId: configured.keyId,
      privateKey: await importPKCS8(await readFile(site.businessKeyFile, "utf8"), "RS256"),
    };
  }
  const aKey = await signing(0),
    bKey = await signing(1);
  const client = new UnixCommercialClient(join(root, "commercial-adapter", "commercial.sock"));
  const service = new FederationCommercialSubmissionService(
    db,
    aKey.siteId,
    action === "crash-after-commit"
      ? {
          prepare: (input) => client.prepare(input),
          advance: async (recovery) => {
            const result = await client.advance(recovery);
            if (result.state === "committed") process.exit(86);
            return result;
          },
        }
      : client,
  );
  const Fixture = z.object({
    actors: z.array(z.object({ userId: z.uuid(), orgId: z.uuid() })).length(2),
    direct: CommercialAgreementSchema,
    attested: CommercialAgreementSchema,
  });
  const fixtureFile = join(root, "commercial-database-fixture.json");
  try {
    if (action === "initialize") {
      const actors = [0, 1].map(() => ({ userId: randomUUID(), orgId: randomUUID() }));
      for (const actor of actors) {
        await db.insert(orgs).values({ id: actor.orgId, name: "Isolated commercial institution" });
        await db.insert(users).values({
          id: actor.userId,
          orgId: actor.orgId,
          email: `${actor.userId}@test.invalid`,
          role: "user",
        });
        await db.insert(userOrgMemberships).values({ ...actor, role: "member" });
        await db
          .insert(federationCapabilities)
          .values({ ...actor, capability: "agreement.approve", grantedBy: actor.userId });
      }
      for (const org of network.trust.organizations) {
        await db
          .insert(federationSites)
          .values({ id: org.siteId, name: org.mspId, endpoint: "https://test.invalid" });
        for (const key of org.keys) {
          const purposes = network.trust.keyPurposes.find(
            (item) => item.siteId === org.siteId && item.keyId === key.keyId,
          );
          assert(purposes);
          await db.insert(federationSigningKeys).values({
            siteId: org.siteId,
            ...key,
            validFrom: new Date(key.validFrom),
            validUntil: new Date(key.validUntil),
            allowedKinds: z
              .array(z.enum(["commercial-agreement", "commercial-usage"]))
              .parse(purposes.kinds),
          });
        }
      }
      const proposal = CommercialProposalInputSchema.parse(
        JSON.parse(await readFile(join(root, "commercial-proposal.json"), "utf8")),
      );
      assert(proposal.operation === "register-agreement");
      const encoded = proposal.envelope.sourceJws.split(".")[1];
      assert(encoded);
      const original = CommercialAgreementSchema.parse(
        JSON.parse(Buffer.from(encoded, "base64url").toString()),
      );
      const terms = (mode: "bilateral_direct" | "bilateral_attested") =>
        CommercialAgreementSchema.parse({
          ...original,
          salt: randomBytes(32).toString("hex"),
          createdAt: new Date().toISOString(),
          agreement: { ...original.agreement, agreementRevisionId: randomUUID(), mode },
        });
      await writeFile(
        fixtureFile,
        JSON.stringify(
          Fixture.parse({
            actors,
            direct: terms("bilateral_direct"),
            attested: terms("bilateral_attested"),
          }),
        ),
        { mode: 0o600 },
      );
    } else if (
      action === "approve-direct" ||
      action === "approve-attested" ||
      action === "approve-mvcc"
    ) {
      const fixture = Fixture.parse(JSON.parse(await readFile(fixtureFile, "utf8")));
      const actorA = fixture.actors[0],
        actorB = fixture.actors[1];
      assert(actorA && actorB);
      const terms =
        action === "approve-direct"
          ? fixture.direct
          : action === "approve-mvcc"
            ? CommercialAgreementSchema.parse({
                ...fixture.attested,
                salt: randomBytes(32).toString("hex"),
                createdAt: new Date().toISOString(),
                agreement: { ...fixture.attested.agreement, agreementRevisionId: randomUUID() },
              })
            : fixture.attested;
      const source = new FederationCommercialAgreementService(db, aKey);
      const target = new FederationCommercialAgreementService(db, bKey);
      await source.approve(actorA, terms);
      const approval = await target.approve(actorB, terms);
      await source.attachCounterparty(
        actorA,
        terms.agreement.agreementRevisionId,
        approval.approvalJws,
      );
    } else {
      assert(await service.advanceNext(), "A checkpoint must advance");
    }
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}
main().catch(() => {
  process.stderr.write("Commercial database worker failed; inspect isolated test state\n");
  process.exitCode = 1;
});
