import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createPgDb,
  federationCommercialSubmissions,
  federationMarketSubmissions,
} from "@kuintessence/db";
import type { FederationAgreement } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialReservationSchema,
} from "@kuintessence/shared/federation/commercial";
import { eq } from "drizzle-orm";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { FederationCommercialAgreementService } from "../../packages/server/src/federation/commercial-agreements";
import { FederationCommercialExecutionService } from "../../packages/server/src/federation/commercial-execution";
import { FederationExecutionConfirmationService } from "../../packages/server/src/federation/execution-confirmation";
import { FederationMarketService } from "../../packages/server/src/federation/market";
import { UnixMarketClient } from "../../packages/server/src/federation/market-client";
import { FederationPermissionService } from "../../packages/server/src/federation/permissions";
import {
  type FederationSigningKey,
  signFederationMessage,
} from "../../packages/server/src/federation/signatures";

export async function approveContract(
  db: ReturnType<typeof createPgDb>,
  actor: { userId: string; orgId: string },
  own: FederationSigningKey,
  other: FederationSigningKey,
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
  await service.attachCounterparty(
    actor,
    terms.agreementRevisionId,
    await signFederationMessage(CommercialAgreementSchema, contract, other),
  );
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
      for (const capability of ["market.publish", "market.claim"] as const)
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
    const commercialReady = async (p: typeof a) => {
      const rows = await p.db.select().from(federationCommercialSubmissions);
      assert(
        !rows.some((r) => r.state === "needs_review"),
        rows
          .map((r) => r.lastError)
          .filter(Boolean)
          .join(","),
      );
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
    const own = await a.execution.approve(a.actor, config.terms.agreementRevisionId, reserve);
    const other = await b.execution.approve(b.actor, config.terms.agreementRevisionId, reserve);
    await a.execution.attachCounterparty(
      a.actor,
      config.terms.agreementRevisionId,
      reservationId,
      other.approvalJws,
    );
    await b.execution.attachCounterparty(
      b.actor,
      config.terms.agreementRevisionId,
      reservationId,
      own.approvalJws,
    );
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
