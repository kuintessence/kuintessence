import assert from "node:assert/strict";
import {
  createPgDb,
  federationAgreementSyncs,
  federationCommercialApprovalSyncs,
} from "@kuintessence/db";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { FederationAgreementService } from "../../packages/server/src/federation/agreements";
import { FederationCommercialAgreementService } from "../../packages/server/src/federation/commercial-agreements";

const root = z.string().min(1).parse(process.env.LAB_ROOT);
const config = await Bun.file(`${root}/source-init.json`).json();
assert(["bilateral_direct", "bilateral_attested"].includes(config.terms.mode));
const source = await Bun.file(`${root}/source-actor.json`).json();
const target = await Bun.file(`${root}/registration.json`).json();
const execution = await Bun.file(`${root}/federation-probe.json`).json();
const databases = [process.env.SOURCE_DATABASE_URL, process.env.DATABASE_URL].map((value) => {
  const url = z.string().min(1).parse(value);
  assert(new URL(url).pathname.startsWith("/kuintessence_unit_"));
  return createPgDb(url);
});
try {
  const parties = await Promise.all(
    databases.map(async (db, index) => {
      const peer = index === 0 ? config.source : config.target;
      const actor = index === 0 ? source : { orgId: target.orgId, userId: target.userId };
      const key = {
        siteId: peer.siteId,
        keyId: peer.keyId,
        privateKey: await importPKCS8(
          await Bun.file(
            index === 0
              ? `${root}/source-signing.pem`
              : z.string().min(1).parse(process.env.FEDERATION_SIGNING_KEY_FILE),
          ).text(),
          "RS256",
        ),
      };
      const agreement = new FederationAgreementService(db, key);
      const original = await agreement.approve(actor, {
        terms: config.terms,
        ...(index === 1 ? { executionUserId: execution.identity.userId } : {}),
      });
      return {
        actor,
        agreement,
        original,
        contract: new FederationCommercialAgreementService(db, key),
      };
    }),
  );
  const deadline = Date.now() + 180000;
  for (;;) {
    const agreements = await Promise.all(
      parties.map((p) => p.agreement.get(p.actor, config.terms.agreementRevisionId)),
    );
    const contracts = await Promise.all(
      parties.map((p) => p.contract.get(p.actor, config.terms.agreementRevisionId)),
    );
    if (
      agreements.every((v) => v.counterpartyApprovalJws) &&
      contracts.every((v) => v.counterpartyJws)
    ) {
      assert.equal(agreements[0]?.counterpartyApprovalJws, parties[1]?.original.approvalJws);
      assert.equal(agreements[1]?.counterpartyApprovalJws, parties[0]?.original.approvalJws);
      assert.equal(contracts[0]?.counterpartyJws, contracts[1]?.approvalJws);
      assert.equal(contracts[1]?.counterpartyJws, contracts[0]?.approvalJws);
      await Bun.write(`${root}/agreement-exchange.json`, JSON.stringify(agreements));
      await Bun.write(`${root}/approval-exchange.json`, JSON.stringify(contracts));
      break;
    }
    for (const db of databases)
      for (const table of [federationAgreementSyncs, federationCommercialApprovalSyncs])
        for (const row of await db
          .select({ state: table.state, lastError: table.lastError })
          .from(table))
          assert.notEqual(
            row.state,
            "needs_review",
            row.lastError ?? "Agreement exchange needs review",
          );
    assert(Date.now() < deadline, "Bilateral agreements did not exchange original signatures");
    await Bun.sleep(500);
  }
  console.log(
    "PASS bilateral execution and commercial consents exchanged by production workers without ledger confirmation",
  );
} finally {
  await Promise.all(databases.map((db) => db.$client.end()));
}
