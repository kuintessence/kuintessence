import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createPgDb,
  federationCommercialAttempts,
  federationCommercialSubmissions,
  federationMarketAttempts,
  federationMarketRequests,
  federationMarketSubmissions,
  federationReservationProposals,
  workflowExecutionDelegations,
  workflowRuns,
} from "@kuintessence/db";
import type { FederationAgreement } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialReservationSchema,
} from "@kuintessence/shared/federation/commercial";
import { desc, eq } from "drizzle-orm";
import { importPKCS8 } from "jose";
import { z } from "zod";
import { FederationAgreementExchange } from "../../packages/server/src/federation/agreement-exchange";
import { FederationAgreementService } from "../../packages/server/src/federation/agreements";
import { federationMaterialDigest } from "../../packages/server/src/federation/assets";
import { FederationCommercialAgreementService } from "../../packages/server/src/federation/commercial-agreements";
import { FederationCommercialApprovalExchange } from "../../packages/server/src/federation/commercial-approval-exchange";
import { FederationCommercialExecutionService } from "../../packages/server/src/federation/commercial-execution";
import { FederationCommercialSubmissionService } from "../../packages/server/src/federation/commercial-submissions";
import { UnixMarketClient } from "../../packages/server/src/federation/market-client";
import { FederationMarketRequestService } from "../../packages/server/src/federation/market-requests";
import { createFederationSender } from "../../packages/server/src/federation/outbound-client";
import { FederationPermissionService } from "../../packages/server/src/federation/permissions";
import { FederationReservationPolicyService } from "../../packages/server/src/federation/reservation-policy";
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
    const parties: {
      db: ReturnType<typeof createPgDb>;
      actor: { orgId: string; userId: string };
      key: FederationSigningKey;
      market: UnixMarketClient;
      execution: FederationCommercialExecutionService;
    }[] = [];
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
        market: client,
        execution: new FederationCommercialExecutionService(db, key, client),
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
    await wait(async () => {
      const source = await agreementA.get(a.actor, config.terms.agreementRevisionId);
      const provider = await agreementB.get(b.actor, config.terms.agreementRevisionId);
      for (const p of parties) {
        const status = await new FederationAgreementExchange(p.db, p.key).status(
          p.actor,
          config.terms.agreementRevisionId,
        );
        assert(
          status.sync?.state !== "needs_review",
          status.sync?.lastError ?? "Execution consent exchange failed",
        );
        if (status.sync?.state !== "complete") return false;
      }
      assert.equal(source.counterpartyApprovalJws, providerConsent.approvalJws);
      assert.equal(provider.counterpartyApprovalJws, sourceConsent.approvalJws);
      return true;
    }, "basic execution consent exchanged automatically over mTLS");
    const agreementEvidence = [];
    for (const p of parties) {
      const status = await new FederationAgreementExchange(p.db, p.key).status(
        p.actor,
        config.terms.agreementRevisionId,
      );
      agreementEvidence.push({
        siteId: p.key.siteId,
        revisionId: config.terms.agreementRevisionId,
        sync: status.sync,
      });
    }
    await Bun.write(`${root}/agreement-exchange.json`, JSON.stringify(agreementEvidence));
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
            allowMarketPublish: p === a,
            allowMarketClaim: p === b,
            allowActivation: p === a,
            allowExecutionConfirmation: true,
            validUntil: config.request.executionExpiresAt ?? config.request.expiresAt,
          },
        ),
      );
    const sourcePolicy = reservationPolicies[0],
      providerPolicy = reservationPolicies[1];
    assert(sourcePolicy && providerPolicy);
    let demandId: string, reservationId: string;
    if (process.env.LAB_SCENARIO === "workflow") {
      const origin = z.url().parse(process.env.LAB_SOURCE_HTTP);
      assert.equal(new URL(origin).hostname, "127.0.0.1");
      const login = await fetch(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "source-admin@test.invalid", role: "platform_admin" }),
      });
      assert(login.ok, "Source test login failed");
      const { token } = z.object({ token: z.string() }).parse(await login.json());
      const request = config.request;
      const workflow = {
        name: "Coordinated institutional workflow",
        spec: {
          nodeDrafts: [
            {
              id: "remote",
              name: "Remote calculation",
              type: "Federation",
              agreementRevisionId: request.agreementRevisionId,
              template: request.template,
              inputManifestDigest: request.inputManifestDigest,
              environmentLockDigest: request.environmentLockDigest,
              resources: request.resources,
              maxAmount: request.maxAmount,
              admissionWindowSec: 1200,
              executionExpiresAt: request.executionExpiresAt,
              market: {
                policyId: sourcePolicy.id,
                title: "Isolated file computation",
                description: "",
              },
              outputs: [
                {
                  descriptor: "result",
                  type: "File",
                  from: { nodeId: "consumer", descriptor: "result" },
                },
              ],
            },
            {
              id: "consume",
              name: "Receive verified result",
              type: "NoAction",
              inputSlots: [
                { descriptor: "input", type: "File", from: { node: "remote", output: "result" } },
              ],
            },
          ],
          nodeRelations: [{ fromId: "remote", toId: "consume", slotRelations: [] }],
        },
      };
      const submitted = await fetch(`${origin}/api/workflows`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ yaml: JSON.stringify(workflow) }),
      });
      assert.equal(submitted.status, 202, "Ordinary Workflow submission failed");
      const { runId } = z.object({ runId: z.uuid() }).parse(await submitted.json());
      await Bun.write(`${root}/source-workflow.json`, JSON.stringify({ runId, workflow }));
      await wait(async () => {
        const [run] = await a.db
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, runId));
        assert(
          !["failed", "cancelled", "cancelling"].includes(run?.status ?? ""),
          "Source workflow failed before market submission",
        );
        const [binding] = await a.db
          .select()
          .from(workflowExecutionDelegations)
          .where(eq(workflowExecutionDelegations.runId, runId));
        if (!binding) return false;
        const [intent] = await a.db
          .select()
          .from(federationMarketRequests)
          .where(eq(federationMarketRequests.reservationId, binding.operationId));
        if (!intent) return false;
        config.request = binding.request;
        await Bun.write(`${root}/source-init.json`, JSON.stringify(config));
        return true;
      }, "ordinary Workflow created its original market request automatically");
      const [intent] = await a.db.select().from(federationMarketRequests);
      assert(intent);
      demandId = intent.demandId;
      reservationId = intent.reservationId;
    } else {
      demandId = randomUUID();
      reservationId = config.request.operationId;
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
      const sourceRequests = new FederationMarketRequestService(
        a.db,
        a.key,
        createFederationSender({
          cert: await Bun.file(`${root}/peer.crt`).text(),
          key: await Bun.file(`${root}/peer.key`).text(),
          ca: await Bun.file(`${root}/ca/ca.crt`).text(),
        }),
        a.market,
      );
      await sourceRequests.submit(a.actor, config.terms.agreementRevisionId, sourcePolicy.id, {
        protocolVersion: 1,
        kind: "market-request",
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
          expiresAt: config.request.expiresAt,
        },
        proposal: reserve,
      });
    }
    await wait(async () => {
      for (const p of parties) {
        const [request] = await p.db.select().from(federationMarketRequests);
        assert(
          request?.state !== "needs_review",
          request?.lastError ?? "Automatic market request failed",
        );
        if (request?.state !== "complete") return false;
      }
      return true;
    }, "production workers automatically published, claimed and handed off the original task");
    const marketEvidence = [];
    for (const p of parties) {
      const [request] = await p.db.select().from(federationMarketRequests);
      const policyId: string = p === a ? sourcePolicy.id : providerPolicy.id;
      assert(request?.marketSubmissionId);
      assert.equal(request.reservationId, config.request.operationId);
      assert.equal(request.policyId, policyId);
      const [submission] = await p.db
        .select()
        .from(federationMarketSubmissions)
        .where(eq(federationMarketSubmissions.id, request.marketSubmissionId));
      assert(submission?.state === "committed" && submission.authorizationPolicyId === policyId);
      const history = await p.db
        .select()
        .from(federationMarketAttempts)
        .where(eq(federationMarketAttempts.submissionId, submission.id))
        .orderBy(desc(federationMarketAttempts.number));
      assert(
        history[0]?.stage === "committed" &&
          history[0]?.validationCode === 0 &&
          history[0]?.blockNumber !== null,
      );
      assert.equal(submission.input.operation, p === a ? "publish-demand" : "claim-demand");
      if (submission.input.operation === "publish-demand")
        assert.deepEqual(Object.keys(submission.input).sort(), ["demand", "operation"]);
      marketEvidence.push({ siteId: p.key.siteId, request, submission, history });
    }
    await Bun.write(`${root}/market-requests.json`, JSON.stringify(marketEvidence, null, 2));
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
    await wait(async () => {
      for (const p of parties) {
        const [proposal] = await p.db.select().from(federationReservationProposals);
        assert(
          proposal?.executionState !== "needs_review",
          proposal?.executionError ?? "Automatic execution approval failed",
        );
        if (proposal?.executionState !== "complete") return false;
      }
      return true;
    }, "automatic activation and both VALID execution confirmations");
    const automationEvidence = [];
    let activationId: string | null = null;
    for (const p of parties) {
      const [proposal] = await p.db.select().from(federationReservationProposals);
      assert(proposal?.confirmationId);
      if (p === a) activationId = proposal.activationId;
      const records = [];
      for (const id of [proposal.activationId, proposal.confirmationId].filter(
        (id): id is string => !!id,
      )) {
        const [submission] = await p.db
          .select()
          .from(federationMarketSubmissions)
          .where(eq(federationMarketSubmissions.id, id));
        const [attempt] = await p.db
          .select()
          .from(federationMarketAttempts)
          .where(eq(federationMarketAttempts.submissionId, id))
          .orderBy(desc(federationMarketAttempts.number))
          .limit(1);
        assert(
          submission?.state === "committed" &&
            submission.authorizationPolicyId === proposal.policyId,
        );
        assert(
          attempt?.stage === "committed" &&
            attempt.validationCode === 0 &&
            attempt.blockNumber !== null,
        );
        records.push({
          id,
          operation: submission.input.operation,
          policyId: submission.authorizationPolicyId,
          state: submission.state,
          transactionId: attempt.transactionId,
          validationCode: attempt.validationCode,
          blockNumber: attempt.blockNumber,
        });
      }
      automationEvidence.push({
        siteId: p.key.siteId,
        policyId: proposal.policyId,
        executionState: proposal.executionState,
        records,
      });
    }
    assert(activationId);
    await Bun.write(
      `${root}/execution-automation.json`,
      JSON.stringify(automationEvidence, null, 2),
    );
    await Bun.write(
      `${root}/ledger-proof.json`,
      JSON.stringify({ demandId, reservationId, activationId }),
    );
  } finally {
    await dbA.$client.end();
    await dbB.$client.end();
  }
}
