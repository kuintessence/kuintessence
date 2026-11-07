import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createPgDb,
  federationCommercialAttempts,
  federationCommercialSubmissions,
  federationMarketSubmissions,
  federationReservationProposals,
} from "@kuintessence/db";
import type { FederationAgreement } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialReservationSchema,
} from "@kuintessence/shared/federation/commercial";
import { desc, eq } from "drizzle-orm";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { FederationAgreementService } from "../../packages/server/src/federation/agreements";
import { federationMaterialDigest } from "../../packages/server/src/federation/assets";
import { FederationCommercialAgreementService } from "../../packages/server/src/federation/commercial-agreements";
import { FederationCommercialApprovalExchange } from "../../packages/server/src/federation/commercial-approval-exchange";
import { FederationCommercialExecutionService } from "../../packages/server/src/federation/commercial-execution";
import { FederationCommercialSubmissionService } from "../../packages/server/src/federation/commercial-submissions";
import { FederationExecutionConfirmationService } from "../../packages/server/src/federation/execution-confirmation";
import { FederationMarketService } from "../../packages/server/src/federation/market";
import { UnixMarketClient } from "../../packages/server/src/federation/market-client";
import { createFederationSender } from "../../packages/server/src/federation/outbound-client";
import { FederationPermissionService } from "../../packages/server/src/federation/permissions";
import { FederationReservationPolicyService } from "../../packages/server/src/federation/reservation-policy";
import { FederationReservationProposalService } from "../../packages/server/src/federation/reservation-proposals";
import type { FederationSigningKey } from "../../packages/server/src/federation/signatures";

export async function approveContract(
  db: ReturnType<typeof createPgDb>,
  actor: { userId: string; orgId: string },
  own: FederationSigningKey,
  terms: FederationAgreement,
  existing?: unknown,
) {
  const network = await Bun.file(`${process.env.LAB_FABRIC_ROOT}/network.json`).json();
  const contract = CommercialAgreementSchema.parse(
    existing ?? {
      protocolVersion: 1,
      kind: "commercial-agreement",
      domainId: network.trust.domains[0].domainId,
      salt: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(),
      agreement: terms,
      consideration: "exchange",
      priceVersionId: randomUUID(),
      prices: [
        {
          metric: "job.elapsed",
          quantityUnit: "job-millisecond",
          perQuantity: "1000",
          amount: "1",
        },
      ],
      termsText: "Private isolated execution acceptance contract",
    },
  );
  const service = new FederationCommercialAgreementService(db, own);
  await service.approve(actor, contract);
  return contract;
}

if (import.meta.main) {
  const root = z.string().min(1).parse(process.env.LAB_ROOT),
    networkRoot = z.string().min(1).parse(process.env.LAB_FABRIC_ROOT);
  const config = await Bun.file(`${root}/source-init.json`).json();
  const network = await Bun.file(`${networkRoot}/network.json`).json();
  const sourceActor = await Bun.file(`${root}/source-actor.json`).json();
  const registration = await Bun.file(`${root}/registration.json`).json();
  const dbA = createPgDb(z.string().min(1).parse(process.env.SOURCE_DATABASE_URL));
  const dbB = createPgDb(z.string().min(1).parse(process.env.DATABASE_URL));
  for (const url of [
    z.string().min(1).parse(process.env.SOURCE_DATABASE_URL),
    z.string().min(1).parse(process.env.DATABASE_URL),
  ])
    assert(new URL(url).pathname.startsWith("/kuintessence_unit_"));
  try {
    const parties = [];
    for (const [name, db, actor] of [
      ["A", dbA, sourceActor],
      ["B", dbB, { orgId: registration.orgId, userId: registration.userId }],
    ] as const) {
      const site = network.sites.find((s: { name: string }) => s.name === name);
      const key = {
        siteId: site.siteId,
        keyId: "batch-1",
        privateKey: await importPKCS8(await Bun.file(site.businessKeyFile).text(), "RS256"),
      };
      for (const capability of ["market.publish", "market.claim", "delegation.submit"] as const)
        await new FederationPermissionService(db).set(
          { ...actor, capability, enabled: true },
          actor.userId,
        );
      const client = new UnixMarketClient(`${networkRoot}/live-${name}-market/market.sock`);
      parties.push({
        db,
        actor,
        key,
        market: new FederationMarketService(db, key.siteId, client),
        execution: new FederationCommercialExecutionService(db, key, client),
        confirmation: new FederationExecutionConfirmationService(db, key.siteId, client),
      });
    }
    const a = parties[0],
      b = parties[1];
    assert(a && b);
    const wait = async (read: () => Promise<boolean>, label: string) => {
      const end = Date.now() + 180000;
      while (!(await read())) {
        assert(Date.now() < end, label);
        await Bun.sleep(500);
      }
      console.log(`PASS ${label}`);
    };
    const reviewed = new Set<string>();
    const commercialReady = async (p: typeof a) => {
      const rows = await p.db.select().from(federationCommercialSubmissions);
      for (const row of rows.filter((r) => r.state === "needs_review")) {
        const [attempt] = await p.db
          .select()
          .from(federationCommercialAttempts)
          .where(eq(federationCommercialAttempts.submissionId, row.id))
          .orderBy(desc(federationCommercialAttempts.number))
          .limit(1);
        assert(
          row.lastError === "LEDGER_INVALID" &&
            attempt?.stage === "invalid" &&
            attempt.validationCode === 11 &&
            !reviewed.has(row.id),
          row.lastError ?? "Commercial failure",
        );
        const other = p === a ? b : a;
        const peers = await other.db.select().from(federationCommercialSubmissions);
        const duplicate = peers.find(
          (r) => federationMaterialDigest(r.input) === federationMaterialDigest(row.input),
        );
        assert(
          duplicate && duplicate.state !== "needs_review",
          "MVCC retry needs the exact peer intent",
        );
        if (duplicate.state !== "committed" || (row.leaseUntil && row.leaseUntil > new Date()))
          return false;
        const [valid] = await other.db
          .select()
          .from(federationCommercialAttempts)
          .where(eq(federationCommercialAttempts.submissionId, duplicate.id))
          .orderBy(desc(federationCommercialAttempts.number))
          .limit(1);
        assert(
          valid?.stage === "committed" && valid.validationCode === 0 && valid.blockNumber !== null,
        );
        // The fixture acts as the authorized reviewer only for a proven duplicate VALID peer intent.
        await new FederationCommercialSubmissionService(p.db, p.key.siteId).retry(
          p.actor,
          row.agreementRevisionId,
          row.id,
        );
        reviewed.add(row.id);
        console.log(
          `Reviewed duplicate commercial MVCC conflict: ${attempt.transactionId}; peer VALID ${valid.transactionId}`,
        );
        return false;
      }
      return rows.length > 0 && rows.every((r) => r.state === "committed");
    };
    const marketReady = async (p: typeof a, id: string) => {
      const [row] = await p.db
        .select()
        .from(federationMarketSubmissions)
        .where(eq(federationMarketSubmissions.id, id));
      assert(row?.state !== "needs_review", row?.lastError ?? "Market failure");
      return row?.state === "committed";
    };
    await wait(
      async () => (await commercialReady(a)) && (await commercialReady(b)),
      "both production Servers registered the private contract",
    );
    const identity = await Bun.file(`${root}/federation-probe.json`).json();
    const agreementA = new FederationAgreementService(a.db, a.key);
    const agreementB = new FederationAgreementService(b.db, b.key);
    const sourceConsent = await agreementA.approve(a.actor, { terms: config.terms });
    const providerConsent = await agreementB.approve(b.actor, {
      terms: config.terms,
      executionUserId: identity.identity.userId,
    });
    await agreementA.attachCounterparty(
      a.actor,
      config.terms.agreementRevisionId,
      providerConsent.approvalJws,
    );
    await agreementB.attachCounterparty(
      b.actor,
      config.terms.agreementRevisionId,
      sourceConsent.approvalJws,
    );
    const reservationPolicies = [];
    for (const p of parties)
      reservationPolicies.push(
        await new FederationReservationPolicyService(p.db, p.key.siteId).grant(
          p.actor,
          config.terms.agreementRevisionId,
          {
            maxTaskAmount: config.request.maxAmount,
            maxTotalAmount: config.request.maxAmount,
            maxTasks: 1,
            validUntil: config.request.executionExpiresAt ?? config.request.expiresAt,
          },
        ),
      );
    const demandId = randomUUID(),
      reservationId = randomUUID(),
      activationId = randomUUID();
    await a.market.enqueue(a.actor, {
      operation: "publish-demand",
      demand: {
        protocolVersion: 1,
        demandId,
        sourceSiteId: a.key.siteId,
        title: "Isolated file computation",
        description: "",
        platform: "linux",
        architecture: "x86_64",
        resources: config.request.resources,
        createdAt: new Date().toISOString(),
        expiresAt: config.terms.validUntil,
      },
    });
    await wait(() => marketReady(a, demandId), "source public demand committed");
    await b.market.enqueue(b.actor, {
      operation: "claim-demand",
      claim: {
        demandId,
        claimId: reservationId,
        providerSiteId: b.key.siteId,
        commercialDomainId: config.commercial.domainId,
        expectedVersion: 1,
        expiresAt: config.request.expiresAt,
      },
    });
    await wait(() => marketReady(b, reservationId), "provider claim committed");
    const contract = await new FederationCommercialAgreementService(a.db, a.key).get(
      a.actor,
      config.terms.agreementRevisionId,
    );
    const reserve = CommercialReservationSchema.parse({
      protocolVersion: 1,
      kind: "commercial-reservation",
      domainId: config.commercial.domainId,
      reservationId,
      demandId,
      claimVersion: 2,
      agreementDigest: contract.digest,
      salt: randomBytes(32).toString("hex"),
      request: config.request,
    });
    const sourcePolicy = reservationPolicies[0],
      providerPolicy = reservationPolicies[1];
    assert(sourcePolicy && providerPolicy);
    const sourceProposals = new FederationReservationProposalService(
      a.db,
      a.key,
      createFederationSender({
        cert: await Bun.file(`${root}/peer.crt`).text(),
        key: await Bun.file(`${root}/peer.key`).text(),
        ca: await Bun.file(`${root}/ca/ca.crt`).text(),
      }),
    );
    await sourceProposals.submit(
      a.actor,
      config.terms.agreementRevisionId,
      sourcePolicy.id,
      reserve,
    );
    await wait(async () => {
      const source = (await a.db.select().from(federationReservationProposals))[0];
      const provider = (await b.db.select().from(federationReservationProposals))[0];
      assert(source?.state !== "needs_review", source?.lastError ?? "Source proposal failed");
      assert(provider?.state !== "needs_review", provider?.lastError ?? "Provider proposal failed");
      return source?.state === "delivered" && provider?.state === "approved";
    }, "new task preauthorized and delivered by production workers");
    const own = await a.execution.get(a.actor, config.terms.agreementRevisionId, reservationId);
    const other = await b.execution.get(b.actor, config.terms.agreementRevisionId, reservationId);
    assert.equal(own.authorizationPolicyId, sourcePolicy.id);
    assert.equal(other.authorizationPolicyId, providerPolicy.id);
    const proposalEvidence = [];
    for (const p of parties)
      proposalEvidence.push({
        siteId: p.key.siteId,
        policies: await new FederationReservationPolicyService(p.db, p.key.siteId).list(
          p.actor,
          config.terms.agreementRevisionId,
        ),
        proposals: await p.db.select().from(federationReservationProposals),
      });
    await Bun.write(
      `${root}/reservation-proposals.json`,
      JSON.stringify(proposalEvidence, null, 2),
    );
    await wait(async () => {
      const source = await a.execution.get(
        a.actor,
        config.terms.agreementRevisionId,
        reservationId,
      );
      const provider = await b.execution.get(
        b.actor,
        config.terms.agreementRevisionId,
        reservationId,
      );
      if (!source.counterpartyJws || !provider.counterpartyJws) return false;
      assert.equal(source.counterpartyJws, other.approvalJws);
      assert.equal(provider.counterpartyJws, own.approvalJws);
      return true;
    }, "reservation signatures exchanged automatically over mTLS");
    const exchangeEvidence = [];
    for (const p of parties) {
      const exchanged = await new FederationCommercialApprovalExchange(p.db, p.key).list(
        p.actor,
        config.terms.agreementRevisionId,
        50,
        0,
      );
      assert.equal(exchanged.records.length, 2);
      assert(exchanged.records.every((r) => r.state === "complete"));
      exchangeEvidence.push({ siteId: p.key.siteId, records: exchanged.records });
    }
    await Bun.write(`${root}/approval-exchange.json`, JSON.stringify(exchangeEvidence));
    await wait(
      async () => (await commercialReady(a)) && (await commercialReady(b)),
      "both private reservations committed",
    );
    await a.execution.activate(
      a.actor,
      config.terms.agreementRevisionId,
      reservationId,
      activationId,
    );
    await wait(() => marketReady(a, activationId), "source activation committed");
    for (const p of parties) {
      const proof = await p.confirmation.request(
        p.actor,
        config.terms.agreementRevisionId,
        reservationId,
      );
      await wait(() => marketReady(p, proof.id), "participant confirmation committed");
    }
    await Bun.write(
      `${root}/ledger-proof.json`,
      JSON.stringify({ demandId, reservationId, activationId }),
    );
  } finally {
    await dbA.$client.end();
    await dbB.$client.end();
  }
}
