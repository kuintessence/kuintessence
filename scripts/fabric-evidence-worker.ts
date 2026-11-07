import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPgDb,
  federationSigningKeys,
  federationSites,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAgreementSchema,
  FederationDelegationSchema,
} from "@kuintessence/shared/federation";
import { importPKCS8, importSPKI } from "jose";
import { z } from "zod";
import { FederationAdmission } from "../packages/server/src/federation/admission";
import { FederationAttestationService } from "../packages/server/src/federation/attestation";
import { UnixAttestationClient } from "../packages/server/src/federation/attestation-client";
import { FederationAttestationWorker } from "../packages/server/src/federation/attestation-worker";
import {
  type FederationSigningKey,
  type FederationVerificationKey,
  signFederationMessage,
} from "../packages/server/src/federation/signatures";
import { testAgreement, testDelegation } from "../packages/server/src/federation/test-fixtures";
import { Network, Site } from "./fabric-evidence-fixture";

const Fixture = z.object({
  direct: FederationAgreementSchema,
  attested: FederationAgreementSchema,
});

async function main() {
  const root = z.string().min(1).parse(process.argv[2]);
  const action = z
    .enum([
      "initialize",
      "admit-direct",
      "admit-attested",
      "advance",
      "tick",
      "crash-after-commit",
      "serve",
    ])
    .parse(process.argv[3]);
  const url = process.env.DATABASE_URL;
  if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
    throw new Error("An isolated kuintessence_unit_* database is required");
  const network = Network.parse(JSON.parse(await readFile(join(root, "network.json"), "utf8")));
  const domain = network.trust.domains[0];
  assert(domain);
  async function key(name: "A" | "B") {
    const site = Site.parse(network.sites.find((s) => s.name === name));
    const configured = network.trust.organizations.find((org) => org.siteId === site.siteId)
      ?.keys[0];
    assert(configured);
    const signing: FederationSigningKey = {
      siteId: site.siteId,
      keyId: configured.keyId,
      privateKey: await importPKCS8(await readFile(site.businessKeyFile, "utf8"), "RS256"),
    };
    const verification = {
      siteId: site.siteId,
      keyId: configured.keyId,
      publicKey: await importSPKI(configured.publicKeyPem, "RS256"),
      validFrom: new Date(configured.validFrom),
      validUntil: new Date(configured.validUntil),
      revoked: false,
      allowedKinds: ["agreement", "delegation", "acceptance", "evidence-batch"],
    } satisfies FederationVerificationKey;
    return { signing, verification, configured };
  }
  const source = await key("A");
  const target = await key("B");
  const db = createPgDb(url, { max: 4, idle_timeout: 1 });
  const admission = new FederationAdmission(db, target.signing, target.verification);
  const client = new UnixAttestationClient(join(root, "adapter-run", "evidence.sock"));
  const service = new FederationAttestationService(
    db,
    target.signing,
    action === "crash-after-commit"
      ? {
          prepare: (input) => client.prepare(input),
          advance: async (recovery) => {
            const result = await client.advance(recovery);
            // Deliberately kill this worker after the real side effect, before its DB transaction.
            if (result.state === "anchored") process.exit(86);
            return result;
          },
        }
      : client,
  );
  try {
    if (action === "initialize") {
      const identity = { orgId: randomUUID(), userId: randomUUID() };
      await db.insert(orgs).values({ id: identity.orgId, name: "Isolated Fabric institution B" });
      await db.insert(users).values({
        id: identity.userId,
        orgId: identity.orgId,
        email: `${identity.userId}@test.invalid`,
        role: "user",
        serviceAccount: true,
      });
      await db.insert(userOrgMemberships).values({ ...identity, role: "member" });
      await db.insert(federationSites).values({
        id: target.signing.siteId,
        name: "Isolated B",
        endpoint: "https://b.test.invalid",
      });
      await db.insert(federationSigningKeys).values({
        siteId: target.signing.siteId,
        keyId: target.signing.keyId,
        publicKeyPem: target.configured.publicKeyPem,
        validFrom: target.verification.validFrom,
        validUntil: target.verification.validUntil,
        allowedKinds: [...target.verification.allowedKinds],
      });
      const create = async (mode: "bilateral_direct" | "bilateral_attested") => {
        const terms = FederationAgreementSchema.parse({
          ...testAgreement(source.signing.siteId, target.signing.siteId, mode),
          ...(mode === "bilateral_attested" ? { budgetDomainId: domain.domainId } : {}),
          validFrom: new Date(Date.now() - 30_000).toISOString(),
          validUntil: new Date(Date.now() + 3_600_000).toISOString(),
        });
        await admission.installApprovedAgreement({
          sourceApprovalJws: await signFederationMessage(
            FederationAgreementSchema,
            terms,
            source.signing,
          ),
          targetApprovalJws: await signFederationMessage(
            FederationAgreementSchema,
            terms,
            target.signing,
          ),
          sourceKey: source.verification,
          targetKey: target.verification,
          identity,
        });
        return terms;
      };
      const fixture = {
        direct: await create("bilateral_direct"),
        attested: await create("bilateral_attested"),
      };
      await writeFile(join(root, "database-fixture.json"), JSON.stringify(fixture), {
        mode: 0o600,
      });
    } else if (action === "admit-direct" || action === "admit-attested") {
      const fixture = Fixture.parse(
        JSON.parse(await readFile(join(root, "database-fixture.json"), "utf8")),
      );
      const terms = action === "admit-direct" ? fixture.direct : fixture.attested;
      await admission.receive({
        requestJws: await signFederationMessage(
          FederationDelegationSchema,
          {
            ...testDelegation(terms),
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            maxAmount: "10",
          },
          source.signing,
        ),
        senderKey: source.verification,
        authenticatedPeerSiteId: source.signing.siteId,
      });
    } else if (action === "advance" || action === "crash-after-commit") {
      assert(await service.advanceNext(), "Expected a due checkpoint");
    } else {
      const worker = new FederationAttestationWorker(service);
      if (action === "tick") {
        await worker.tick();
        await worker.stop();
      } else {
        worker.start();
        await new Promise<void>((resolve) => {
          // Production Server keeps the event loop alive; this standalone test needs a bounded handle.
          const deadline = setTimeout(resolve, 150_000);
          const stop = () => {
            clearTimeout(deadline);
            resolve();
          };
          process.once("SIGTERM", stop);
          process.once("SIGINT", stop);
        });
        await worker.stop();
      }
    }
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

if (import.meta.main)
  main().catch(() => {
    console.error("Fabric database worker check failed; private fixtures retained by parent");
    process.exitCode = 1;
  });
