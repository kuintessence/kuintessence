import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  federationMarketAttempts as attempts,
  auditLog,
  federationCommercialAgreements as contracts,
  type PgDb,
  type PgTransaction,
  federationReservationPolicies as policies,
  federationReservationProposals as proposals,
  federationMarketRequests as requests,
  federationSites as sites,
  federationMarketSubmissions as submissions,
  workflowExecutionDelegations,
} from "@kuintessence/db";
import {
  type FederationDelegation,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { CommercialAgreementSchema } from "@kuintessence/shared/federation/commercial";
import {
  type FederationWorkflowMarket,
  FederationWorkflowMarketSchema,
  MarketClaimSchema,
  MarketQueryResultSchema,
} from "@kuintessence/shared/federation/market";
import {
  type MarketRequest,
  MarketRequestReceiptSchema,
  MarketRequestSchema,
} from "@kuintessence/shared/federation/market-request";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { FabricClientFailure } from "./fabric-client";
import type { MarketClient } from "./market-client";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  assertReservationPolicyActive,
  FederationReservationPolicyService,
} from "./reservation-policy";
import { FederationReservationProposalService } from "./reservation-proposals";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";
import { assertWorkflowDelegationBinding } from "./workflow-delegations";

type Request = typeof requests.$inferSelect;
class MarketRequestLeaseLost extends Error {}
const digest = (payload: MarketRequest) =>
  `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
const progress = (row: Request) => ({
  reservationId: row.reservationId,
  demandId: row.demandId,
  agreementRevisionId: row.agreementRevisionId,
  policyId: row.policyId,
  direction: row.direction,
  state: row.state,
  lastError: row.lastError,
  marketSubmissionId: row.marketSubmissionId,
  createdAt: row.createdAt,
  completedAt: row.completedAt,
  nextAttemptAt: row.nextAttemptAt,
});

/** Publishes only public demand fields; claim/reservation/actual dispatch remain distinct durable steps. */
export class FederationMarketRequestService {
  private readonly trust: FederationTrustRegistry;
  private readonly policies: FederationReservationPolicyService;
  private readonly proposals: FederationReservationProposalService;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send?: FederationSend,
    private readonly market?: Pick<MarketClient, "query">,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.policies = new FederationReservationPolicyService(db, signing.siteId);
    this.proposals = new FederationReservationProposalService(db, signing, send, market);
  }
  private key(id: string) {
    return and(eq(requests.localSiteId, this.signing.siteId), eq(requests.reservationId, id));
  }
  private same(row: Request, payload: MarketRequest, hash: string) {
    if (
      row.digest !== hash ||
      digest(MarketRequestSchema.parse(row.payload)) !== hash ||
      row.reservationId !== payload.proposal.reservationId ||
      row.demandId !== payload.demand.demandId ||
      row.agreementRevisionId !== payload.proposal.request.agreementRevisionId
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  private async contract(tx: PgTransaction, revisionId: string, orgId?: string) {
    const [row] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.revisionId, revisionId),
          orgId ? eq(contracts.localOrgId, orgId) : undefined,
        ),
      );
    if (!row) throw new FederationError("AGREEMENT_UNAVAILABLE");
    return row;
  }
  private async room(
    tx: PgTransaction,
    policy: typeof policies.$inferSelect,
    payload: MarketRequest,
  ) {
    const [used] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        amount: sql<string>`coalesce(sum((${requests.payload}->'proposal'->'request'->>'maxAmount')::numeric),0)::text`,
        pending: sql<number>`count(*) filter (where ${requests.state} <> 'complete')::int`,
      })
      .from(requests)
      .where(eq(requests.policyId, policy.id));
    if (
      (used?.count ?? 0) >= policy.maxTasks ||
      (used?.pending ?? 0) >= 128 ||
      BigInt(used?.amount ?? "0") + BigInt(payload.proposal.request.maxAmount) >
        BigInt(policy.maxTotalAmount)
    )
      throw new FederationError("POLICY_DENIED");
  }
  async submit(actor: FederationActor, revisionId: string, policyId: string, raw: MarketRequest) {
    return this.db.transaction((tx) => this.submitIntent(tx, actor, revisionId, policyId, raw));
  }
  private async submitIntent(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    policyId: string,
    raw: MarketRequest,
    workflow = false,
  ) {
    if (!this.send || !this.market) throw new FederationError("ASSET_UNAVAILABLE");
    const payload = MarketRequestSchema.parse(raw),
      hash = digest(payload);
    if (
      payload.proposal.request.senderSiteId !== this.signing.siteId ||
      payload.proposal.request.agreementRevisionId !== revisionId
    )
      throw new FederationError("POLICY_DENIED");
    const [binding] = await tx
      .select({ runId: workflowExecutionDelegations.runId })
      .from(workflowExecutionDelegations)
      .where(
        and(
          eq(workflowExecutionDelegations.localSiteId, this.signing.siteId),
          eq(workflowExecutionDelegations.operationId, payload.proposal.request.operationId),
        ),
      );
    if (binding && !workflow) throw new FederationError("POLICY_DENIED");
    await requireFederationCapability(tx, actor, "delegation.submit");
    await this.contract(tx, revisionId, actor.orgId);
    const existing = async () => {
      const [row] = await tx
        .select()
        .from(requests)
        .where(this.key(payload.proposal.reservationId));
      if (row) {
        this.same(row, payload, hash);
        if (
          row.localOrgId !== actor.orgId ||
          row.policyId !== policyId ||
          row.direction !== "outbound"
        )
          throw new FederationError("OPERATION_CONFLICT");
      }
      return row;
    };
    const prior = await existing();
    if (prior) return progress(prior);
    const policy = await this.policies.authorizeMarket(tx, policyId, actor.orgId, payload.proposal);
    const duplicate = await existing();
    if (duplicate) return progress(duplicate);
    if (Date.parse(payload.demand.createdAt) > Date.now() + 60000)
      throw new FederationError("INVALID_MESSAGE");
    await this.room(tx, policy, payload);
    const own = await this.trust.resolveKey(
      this.signing.siteId,
      this.signing.keyId,
      new Date(),
      tx,
    );
    if (!own.allowedKinds.includes("market-request"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const [row] = await tx
      .insert(requests)
      .values({
        localSiteId: this.signing.siteId,
        reservationId: payload.proposal.reservationId,
        demandId: payload.demand.demandId,
        agreementRevisionId: revisionId,
        localOrgId: actor.orgId,
        policyId,
        direction: "outbound",
        payload,
        digest: hash,
        requestedBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const duplicate = await existing();
      if (!duplicate) throw new FederationError("OPERATION_CONFLICT");
      return progress(duplicate);
    }
    await tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: "federation.market_request.submit",
      target: row.reservationId,
      diff: { after: { policyId, digest: hash } },
    });
    return progress(row);
  }

  /** Caller holds the live workflow lease and revalidates its resolved materials in this transaction. */
  async prepareWorkflow(
    tx: PgTransaction,
    actor: FederationActor,
    runId: string,
    request: FederationDelegation,
    raw: FederationWorkflowMarket,
    target: { platform: string; architecture: string },
  ) {
    const selection = FederationWorkflowMarketSchema.parse(raw);
    const binding = await assertWorkflowDelegationBinding(
      tx,
      runId,
      actor,
      this.signing.siteId,
      request.operationId,
    );
    if (
      request.mode !== "ledger_coordinated" ||
      federationCanonicalJson(binding.request) !== federationCanonicalJson(request)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [prior] = await tx.select().from(requests).where(this.key(request.operationId));
    const contract = await this.contract(tx, request.agreementRevisionId, actor.orgId);
    const terms = CommercialAgreementSchema.parse(contract.terms);
    const demandId = prior?.demandId ?? randomUUID();
    const payload =
      prior?.payload ??
      MarketRequestSchema.parse({
        protocolVersion: 1,
        kind: "market-request",
        demand: {
          protocolVersion: 1,
          demandId,
          sourceSiteId: request.senderSiteId,
          createdAt: request.issuedAt,
          expiresAt: request.expiresAt,
          title: selection.title,
          description: selection.description,
          ...target,
          resources: request.resources,
        },
        proposal: {
          protocolVersion: 1,
          kind: "commercial-reservation",
          domainId: terms.domainId,
          reservationId: request.operationId,
          demandId,
          claimVersion: 2,
          agreementDigest: contract.digest,
          salt: randomBytes(32).toString("hex"),
          request,
        },
      });
    // demandId is allocated once with the original private intent, under the workflow lease.
    if (
      prior &&
      (prior.policyId !== selection.policyId ||
        prior.localOrgId !== actor.orgId ||
        prior.requestedBy !== actor.userId ||
        prior.direction !== "outbound" ||
        federationCanonicalJson(payload.proposal.request) !== federationCanonicalJson(request) ||
        payload.demand.title !== selection.title ||
        payload.demand.description !== selection.description ||
        payload.demand.platform !== target.platform ||
        payload.demand.architecture !== target.architecture)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const policy = await this.policies.authorizeMarket(
      tx,
      selection.policyId,
      actor.orgId,
      payload.proposal,
    );
    if (!policy.allowActivation || !policy.allowExecutionConfirmation)
      throw new FederationError("POLICY_DENIED");
    const progress = await this.submitIntent(
      tx,
      actor,
      request.agreementRevisionId,
      selection.policyId,
      payload,
      true,
    );
    if (progress.state === "needs_review") throw new FederationError("POLICY_DENIED");
    if (progress.state !== "complete") return false;
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.localSiteId, this.signing.siteId),
          eq(proposals.reservationId, request.operationId),
        ),
      );
    if (proposal?.state === "needs_review" || proposal?.executionState === "needs_review")
      throw new FederationError("POLICY_DENIED");
    return proposal?.executionState === "complete";
  }
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(fingerprint, federationMessageKeyId(jws), new Date());
    const verified = await verifyFederationMessage(MarketRequestSchema, jws, peer, new Date());
    const payload = verified.payload,
      request = payload.proposal.request;
    if (
      request.senderSiteId !== peer.siteId ||
      request.recipientSiteId !== this.signing.siteId ||
      digest(payload) !== verified.digest
    )
      throw new FederationError("UNTRUSTED_IDENTITY");
    return this.db.transaction(async (tx) => {
      for (const site of [peer.siteId, this.signing.siteId].sort()) {
        if (site === peer.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, peer.keyId, new Date());
        else await this.trust.assertKey(tx, site, this.signing.keyId, new Date());
      }
      const current = await this.trust.resolveKey(peer.siteId, peer.keyId, new Date(), tx);
      await verifyFederationMessage(MarketRequestSchema, jws, current, new Date());
      let [row] = await tx.select().from(requests).where(this.key(payload.proposal.reservationId));
      if (!row) {
        const contract = await this.contract(tx, request.agreementRevisionId);
        const [selected] = await tx
          .select()
          .from(policies)
          .where(
            and(
              eq(policies.localSiteId, this.signing.siteId),
              eq(policies.localOrgId, contract.localOrgId),
              eq(policies.agreementRevisionId, contract.revisionId),
              isNull(policies.revokedAt),
            ),
          );
        if (!selected) throw new FederationError("POLICY_DENIED");
        const policy = await this.policies.authorizeMarket(
          tx,
          selected.id,
          contract.localOrgId,
          payload.proposal,
        );
        [row] = await tx.select().from(requests).where(this.key(payload.proposal.reservationId));
        if (!row) {
          await this.room(tx, policy, payload);
          [row] = await tx
            .insert(requests)
            .values({
              localSiteId: this.signing.siteId,
              reservationId: payload.proposal.reservationId,
              demandId: payload.demand.demandId,
              agreementRevisionId: request.agreementRevisionId,
              localOrgId: contract.localOrgId,
              policyId: policy.id,
              direction: "inbound",
              payload,
              digest: verified.digest,
              sourceJws: jws,
              sourceFingerprint: fingerprint,
            })
            .onConflictDoNothing()
            .returning();
          if (!row) throw new FederationError("OPERATION_CONFLICT");
          await tx.insert(auditLog).values({
            actor: `market-request:${payload.proposal.reservationId}`,
            orgId: contract.localOrgId,
            action: "federation.market_request.receive",
            target: payload.proposal.reservationId,
            diff: { after: { policyId: policy.id, digest: verified.digest } },
          });
        }
      }
      if (!row || row.direction !== "inbound" || row.sourceJws !== jws)
        throw new FederationError("OPERATION_CONFLICT");
      this.same(row, payload, verified.digest);
      const receipt = MarketRequestReceiptSchema.parse({
        protocolVersion: 1,
        kind: "market-request-receipt",
        senderSiteId: this.signing.siteId,
        recipientSiteId: peer.siteId,
        reservationId: row.reservationId,
        requestDigest: row.digest,
        state: row.state === "complete" ? "claimed" : "received",
        observedAt: new Date().toISOString(),
      });
      const own = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      const response = await signFederationMessage(
        MarketRequestReceiptSchema,
        receipt,
        this.signing,
      );
      await verifyFederationMessage(MarketRequestReceiptSchema, response, own, new Date());
      return response;
    });
  }
  private async lock(tx: PgTransaction, claim: Request) {
    if (!claim.leaseToken) throw new MarketRequestLeaseLost();
    const [row] = await tx
      .select()
      .from(requests)
      .where(
        and(
          this.key(claim.reservationId),
          eq(requests.state, "pending"),
          eq(requests.leaseToken, claim.leaseToken),
          sql`${requests.leaseUntil} > clock_timestamp()`,
        ),
      )
      .for("update");
    if (!row) throw new MarketRequestLeaseLost();
    this.same(row, claim.payload, claim.digest);
    if (
      row.policyId !== claim.policyId ||
      row.direction !== claim.direction ||
      row.localOrgId !== claim.localOrgId
    )
      throw new FederationError("OPERATION_CONFLICT");
    return row;
  }
  private async scope(tx: PgTransaction, row: Request, endpoint?: string) {
    this.same(row, MarketRequestSchema.parse(row.payload), row.digest);
    const request = row.payload.proposal.request;
    if (
      (row.direction === "outbound" ? request.senderSiteId : request.recipientSiteId) !==
      this.signing.siteId
    )
      throw new FederationError("POLICY_DENIED");
    const policy = await this.policies.authorizeMarket(
      tx,
      row.policyId,
      row.localOrgId,
      row.payload.proposal,
    );
    const other = row.direction === "outbound" ? request.recipientSiteId : request.senderSiteId;
    const [peer] = await tx.select().from(sites).where(eq(sites.id, other)).for("share");
    if (peer?.state !== "active" || (endpoint && endpoint !== peer.endpoint))
      throw new FederationError("UNTRUSTED_IDENTITY");
    if (row.direction === "inbound") {
      if (!row.sourceJws || !row.sourceFingerprint) throw new FederationError("UNTRUSTED_IDENTITY");
      const keyId = federationMessageKeyId(row.sourceJws);
      await this.trust.assertPeer(tx, row.sourceFingerprint, other, keyId, new Date());
      const key = await this.trust.resolveKey(other, keyId, new Date(), tx);
      const verified = await verifyFederationMessage(
        MarketRequestSchema,
        row.sourceJws,
        key,
        new Date(),
      );
      if (verified.digest !== row.digest) throw new FederationError("OPERATION_CONFLICT");
    } else {
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, new Date());
      const key = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        new Date(),
        tx,
      );
      if (!key.allowedKinds.includes("market-request"))
        throw new FederationError("UNTRUSTED_IDENTITY");
    }
    return { policy, endpoint: peer.endpoint, other };
  }
  private claimInput(row: Request) {
    return MarketClaimSchema.parse({
      demandId: row.demandId,
      claimId: row.reservationId,
      providerSiteId: row.payload.proposal.request.recipientSiteId,
      commercialDomainId: row.payload.proposal.domainId,
      expectedVersion: 1,
      expiresAt: row.payload.proposal.request.expiresAt,
    });
  }
  private async chain(row: Request, claimed: boolean) {
    if (!this.market) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const raw = await this.market.query({ operation: "get-demand", demandId: row.demandId });
    const parsed = MarketQueryResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.operation !== "get-demand")
      throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
    const state = parsed.data.demand;
    if (!state) throw new FabricClientFailure("LEDGER_PENDING");
    const expected = federationMaterialDigest(row.payload.demand);
    if (federationMaterialDigest(state.demand) !== expected || state.digest !== expected)
      throw new FederationError("OPERATION_CONFLICT");
    if (
      state.status === "OPEN" &&
      state.version === 1 &&
      !state.claim &&
      !state.cancellation &&
      !state.activation
    ) {
      if (claimed) throw new FabricClientFailure("LEDGER_PENDING");
      return;
    }
    if (
      state.status !== "CLAIMED" ||
      state.version !== row.payload.proposal.claimVersion ||
      !state.claim ||
      state.cancellation ||
      state.activation ||
      federationMaterialDigest(state.claim) !== federationMaterialDigest(this.claimInput(row))
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  private async enqueue(claim: Request) {
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim),
        scope = await this.scope(tx, row);
      const input =
        row.direction === "outbound"
          ? { operation: "publish-demand" as const, demand: row.payload.demand }
          : { operation: "claim-demand" as const, claim: this.claimInput(row) };
      const id = row.direction === "outbound" ? row.demandId : row.reservationId,
        hash = federationMaterialDigest(input);
      const [prior] = await tx.select().from(submissions).where(eq(submissions.id, id));
      if (prior) {
        if (
          prior.localSiteId !== this.signing.siteId ||
          prior.localOrgId !== row.localOrgId ||
          prior.digest !== hash ||
          federationMaterialDigest(prior.input) !== hash
        )
          throw new FederationError("OPERATION_CONFLICT");
      } else {
        assertReservationPolicyActive(scope.policy, new Date());
        await tx.insert(submissions).values({
          id,
          localSiteId: this.signing.siteId,
          localOrgId: row.localOrgId,
          requestedBy: scope.policy.grantedBy,
          authorizationPolicyId: scope.policy.id,
          demandId: row.demandId,
          input,
          digest: hash,
        });
        await tx.insert(auditLog).values({
          actor: `reservation-policy:${scope.policy.id}`,
          orgId: row.localOrgId,
          action: "federation.market.enqueue",
          target: id,
          diff: { after: { operation: input.operation, demandId: row.demandId, digest: hash } },
        });
      }
      await tx.update(requests).set({ marketSubmissionId: id }).where(this.key(row.reservationId));
      return id;
    });
  }
  private async committed(row: Request, id: string) {
    const [record] = await this.db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.id, id),
          eq(submissions.localSiteId, this.signing.siteId),
          eq(submissions.localOrgId, row.localOrgId),
        ),
      );
    const input =
      row.direction === "outbound"
        ? { operation: "publish-demand", demand: row.payload.demand }
        : { operation: "claim-demand", claim: this.claimInput(row) };
    if (
      !record ||
      record.demandId !== row.demandId ||
      record.digest !== federationMaterialDigest(input) ||
      federationMaterialDigest(record.input) !== record.digest
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (record.state === "needs_review")
      throw new FabricClientFailure(record.lastError ?? "LEDGER_INVALID", true);
    if (record.state !== "committed") throw new FabricClientFailure("LEDGER_PENDING");
    const [attempt] = await this.db
      .select()
      .from(attempts)
      .where(eq(attempts.submissionId, id))
      .orderBy(desc(attempts.number))
      .limit(1);
    if (
      attempt?.stage !== "committed" ||
      attempt.validationCode !== 0 ||
      attempt.blockNumber === null
    )
      throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
  }
  private async complete(tx: PgTransaction, row: Request) {
    await tx
      .update(requests)
      .set({
        state: "complete",
        lastError: null,
        completedAt: new Date(),
        leaseToken: null,
        leaseUntil: null,
      })
      .where(this.key(row.reservationId));
    await tx.insert(auditLog).values({
      actor: `market-request:${row.reservationId}`,
      orgId: row.localOrgId,
      action: "federation.market_request.complete",
      target: row.reservationId,
      diff: { after: { policyId: row.policyId, direction: row.direction } },
    });
  }
  private async advance(claim: Request) {
    await this.db.transaction(async (tx) => {
      await this.scope(tx, await this.lock(tx, claim));
    });
    if (claim.direction === "inbound" && !claim.marketSubmissionId) await this.chain(claim, false);
    const id = claim.marketSubmissionId ?? (await this.enqueue(claim));
    await this.committed(claim, id);
    if (claim.direction === "inbound") {
      await this.chain(claim, true);
      await this.db.transaction(async (tx) => {
        const row = await this.lock(tx, claim);
        await this.scope(tx, row);
        await this.complete(tx, row);
      });
      return;
    }
    if (!this.send) throw new FederationError("ASSET_UNAVAILABLE");
    const outgoing = await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, claim),
        scope = await this.scope(tx, row);
      const jws =
        row.sourceJws ??
        (await signFederationMessage(MarketRequestSchema, row.payload, this.signing));
      const keyId = federationMessageKeyId(jws);
      await this.trust.assertKey(tx, this.signing.siteId, keyId, new Date());
      const key = await this.trust.resolveKey(this.signing.siteId, keyId, new Date(), tx);
      const verified = await verifyFederationMessage(MarketRequestSchema, jws, key, new Date());
      if (verified.digest !== row.digest) throw new FederationError("OPERATION_CONFLICT");
      if (!row.sourceJws)
        await tx.update(requests).set({ sourceJws: jws }).where(this.key(row.reservationId));
      return { ...scope, jws };
    });
    const response = await this.send(
      outgoing.endpoint,
      outgoing.jws,
      "/federation/v1/market-requests",
    );
    const keyId = federationMessageKeyId(response),
      peer = await this.trust.resolveKey(outgoing.other, keyId, new Date());
    const verified = await verifyFederationMessage(
      MarketRequestReceiptSchema,
      response,
      peer,
      new Date(),
    );
    const receipt = verified.payload;
    if (
      receipt.senderSiteId !== outgoing.other ||
      receipt.recipientSiteId !== this.signing.siteId ||
      receipt.reservationId !== claim.reservationId ||
      receipt.requestDigest !== claim.digest ||
      Date.parse(receipt.observedAt) > Date.now() + 60000 ||
      Date.parse(receipt.observedAt) < claim.createdAt.getTime() - 60000
    )
      throw new FederationError("OPERATION_CONFLICT");
    const authorize = async (tx: PgTransaction) => {
      const row = await this.lock(tx, claim);
      await this.scope(tx, row, outgoing.endpoint);
      if (row.sourceJws !== outgoing.jws) throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertKey(tx, outgoing.other, keyId, new Date());
      const current = await this.trust.resolveKey(outgoing.other, keyId, new Date(), tx);
      await verifyFederationMessage(MarketRequestReceiptSchema, response, current, new Date());
      await tx.update(requests).set({ receiptJws: response }).where(this.key(row.reservationId));
      return row;
    };
    if (receipt.state === "received") {
      await this.db.transaction(authorize);
      throw new FabricClientFailure("LEDGER_PENDING");
    }
    await this.chain(claim, true);
    if (!claim.requestedBy) throw new FederationError("POLICY_DENIED");
    await this.proposals.submitPrepared(
      { orgId: claim.localOrgId, userId: claim.requestedBy },
      claim.agreementRevisionId,
      claim.policyId,
      claim.payload.proposal,
      async (tx) => {
        await this.complete(tx, await authorize(tx));
      },
    );
  }
  async advanceNext() {
    const claim = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.localSiteId, this.signing.siteId),
            eq(requests.state, "pending"),
            this.send ? undefined : eq(requests.direction, "inbound"),
            sql`${requests.nextAttemptAt} <= clock_timestamp()`,
            sql`(${requests.leaseUntil} IS NULL OR ${requests.leaseUntil} <= clock_timestamp())`,
          ),
        )
        .orderBy(asc(requests.nextAttemptAt), asc(requests.reservationId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const [saved] = await tx
        .update(requests)
        .set({
          leaseToken: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(this.key(row.reservationId))
        .returning();
      return saved;
    });
    if (!claim) return false;
    try {
      await this.advance(claim);
    } catch (error) {
      if (error instanceof MarketRequestLeaseLost || !claim.leaseToken) return true;
      const waiting =
        error instanceof FabricClientFailure &&
        error.code === "LEDGER_PENDING" &&
        !error.needsReview;
      const review =
        error instanceof FederationError ||
        error instanceof z.ZodError ||
        (error instanceof FabricClientFailure && error.needsReview) ||
        (error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE");
      await this.db
        .update(requests)
        .set({
          state: review ? "needs_review" : "pending",
          lastError: waiting
            ? null
            : error instanceof FederationError ||
                error instanceof FabricClientFailure ||
                error instanceof FederationDeliveryError
              ? error.code
              : error instanceof z.ZodError
                ? "INVALID_MESSAGE"
                : "MARKET_REQUEST_RETRY",
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: waiting
            ? sql`clock_timestamp() + interval '10 seconds'`
            : sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(
          and(
            this.key(claim.reservationId),
            eq(requests.leaseToken, claim.leaseToken),
            sql`${requests.leaseUntil} > clock_timestamp()`,
          ),
        );
    }
    return true;
  }
  async list(actor: FederationActor, revisionId: string, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.contract(tx, revisionId, actor.orgId);
      const rows = await tx
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.localSiteId, this.signing.siteId),
            eq(requests.localOrgId, actor.orgId),
            eq(requests.agreementRevisionId, revisionId),
          ),
        )
        .orderBy(desc(requests.createdAt), desc(requests.reservationId))
        .limit(limit)
        .offset(offset);
      return { enabled: !!this.send && !!this.market, records: rows.map(progress) };
    });
  }
  async retry(actor: FederationActor, revisionId: string, reservationId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const [row] = await tx
        .select()
        .from(requests)
        .where(
          and(
            this.key(reservationId),
            eq(requests.localOrgId, actor.orgId),
            eq(requests.agreementRevisionId, revisionId),
          ),
        )
        .for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      if (row.state === "complete" || (row.leaseUntil && row.leaseUntil > new Date()))
        throw new FederationError("OPERATION_CONFLICT");
      await this.scope(tx, row);
      await tx
        .update(requests)
        .set({
          state: "pending",
          lastError: null,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(),
        })
        .where(this.key(reservationId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.market_request.retry",
        target: reservationId,
      });
    });
  }
}
