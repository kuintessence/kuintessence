import { randomBytes, randomUUID } from "node:crypto";
import {
  federationCommercialExecutionApprovals as approvals,
  auditLog,
  federationCommercialAgreements as contracts,
  type PgDb,
  type PgTransaction,
  federationExecutionTerminals as terminals,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import {
  CommercialAgreementSchema,
  CommercialReservationSchema,
  CommercialTerminalSchema,
} from "@kuintessence/shared/federation/commercial";
import { MarketQueryResultSchema } from "@kuintessence/shared/federation/market";
import { and, eq } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { collectExecutionTerminalEvidence } from "./execution-terminal-evidence";
import { FabricClientFailure } from "./fabric-client";
import type { MarketClient } from "./market-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Provider statement only: no billing approval, settlement or ledger submission. */
export class FederationExecutionTerminalService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly market?: Pick<MarketClient, "query">,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  private filter(reservationId: string) {
    return and(
      eq(terminals.localSiteId, this.signing.siteId),
      eq(terminals.reservationId, reservationId),
    );
  }

  private async scope(
    tx: PgTransaction,
    actor: FederationActor,
    revisionId: string,
    reservationId: string,
    lock: boolean,
  ) {
    const [contract] = await tx
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.localSiteId, this.signing.siteId),
          eq(contracts.localOrgId, actor.orgId),
          eq(contracts.revisionId, revisionId),
        ),
      )
      .for("share");
    if (!contract) throw new FederationError("AGREEMENT_UNAVAILABLE");
    const query = tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.localSiteId, this.signing.siteId),
          eq(approvals.localOrgId, actor.orgId),
          eq(approvals.agreementRevisionId, revisionId),
          eq(approvals.recordId, reservationId),
        ),
      );
    const [approval] = await (lock ? query.for("update") : query);
    if (!approval) throw new FederationError("ASSET_UNAVAILABLE");
    if (approval.payload.kind !== "commercial-reservation")
      throw new FederationError("POLICY_DENIED");
    const reserve = CommercialReservationSchema.parse(approval.payload);
    const terms = CommercialAgreementSchema.parse(contract.terms);
    if (
      !approval.counterpartyJws ||
      !contract.counterpartyJws ||
      reserve.request.mode !== "ledger_coordinated" ||
      terms.agreement.mode !== "ledger_coordinated" ||
      reserve.request.recipientSiteId !== this.signing.siteId ||
      reserve.request.senderSiteId !== terms.agreement.sourceSiteId ||
      terms.agreement.targetSiteId !== this.signing.siteId ||
      reserve.request.agreementRevisionId !== revisionId ||
      reserve.reservationId !== reservationId ||
      reserve.domainId !== terms.domainId ||
      reserve.agreementDigest !== contract.digest
    )
      throw new FederationError("POLICY_DENIED");
    return { approval, reserve, terms };
  }

  async get(actor: FederationActor, revisionId: string, reservationId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.read");
      await this.scope(tx, actor, revisionId, reservationId, false);
      const [saved] = await tx.select().from(terminals).where(this.filter(reservationId));
      return saved ?? null;
    });
  }

  /** No caller-supplied digest, outcome or evidence can bypass local collection. */
  async approve(actor: FederationActor, revisionId: string, reservationId: string) {
    const initial = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const scope = await this.scope(tx, actor, revisionId, reservationId, false);
      const [saved] = await tx.select().from(terminals).where(this.filter(reservationId));
      return { ...scope, saved };
    });
    if (initial.saved) return initial.saved;
    if (!this.market) throw new FabricClientFailure("LEDGER_UNAVAILABLE");
    const response = MarketQueryResultSchema.safeParse(
      await this.market.query({ operation: "get-demand", demandId: initial.reserve.demandId }),
    );
    if (!response.success || response.data.operation !== "get-demand")
      throw new FabricClientFailure("INVALID_ADAPTER_RESPONSE", true);
    const state = response.data.demand;
    const activation = state?.activation;
    const reserve = initial.reserve;
    if (
      !state ||
      !["ACTIVE", "STOPPING"].includes(state.status) ||
      !activation ||
      state.demand.demandId !== reserve.demandId ||
      state.demand.sourceSiteId !== reserve.request.senderSiteId ||
      state.claim?.providerSiteId !== this.signing.siteId ||
      state.claim.claimId !== reservationId ||
      state.claim.commercialDomainId !== reserve.domainId ||
      activation.demandId !== reserve.demandId ||
      activation.expectedVersion !== reserve.claimVersion ||
      activation.gate.domainId !== reserve.domainId ||
      activation.gate.reservationId !== reservationId ||
      activation.gate.demandId !== reserve.demandId ||
      activation.gate.reservationDigest !== initial.approval.digest ||
      activation.gate.claimVersion !== reserve.claimVersion ||
      activation.gate.version !== 1 ||
      activation.gate.state !== "READY" ||
      activation.gate.expiresAt !== reserve.request.expiresAt
    )
      throw new FederationError("OPERATION_CONFLICT");
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "agreement.approve");
      const current = await this.scope(tx, actor, revisionId, reservationId, true);
      if (
        current.approval.digest !== initial.approval.digest ||
        federationMaterialDigest(current.reserve) !== federationMaterialDigest(reserve)
      )
        throw new FederationError("OPERATION_CONFLICT");
      const [prior] = await tx.select().from(terminals).where(this.filter(reservationId));
      if (prior) return prior;
      const now = this.clock();
      for (const { siteId, jws } of [
        { siteId: this.signing.siteId, jws: current.approval.approvalJws },
        { siteId: reserve.request.senderSiteId, jws: current.approval.counterpartyJws },
      ].sort((a, b) => a.siteId.localeCompare(b.siteId))) {
        if (!jws) throw new FederationError("OPERATION_CONFLICT");
        const keyId = federationMessageKeyId(jws);
        await this.trust.assertKey(tx, siteId, keyId, now);
        const key = await this.trust.resolveKey(siteId, keyId, now, tx);
        const verified = await verifyFederationMessage(CommercialReservationSchema, jws, key, now);
        if (
          verified.digest !== current.approval.digest ||
          federationMaterialDigest(verified.payload) !== federationMaterialDigest(reserve)
        )
          throw new FederationError("OPERATION_CONFLICT");
      }
      const evidence = await collectExecutionTerminalEvidence(
        tx,
        reserve,
        actor.orgId,
        activation.activationId,
        Boolean(current.terms.agreement.resultPolicy),
        this.trust,
        now,
      );
      const payload = CommercialTerminalSchema.parse({
        protocolVersion: 1,
        kind: "commercial-terminal",
        terminalId: randomUUID(),
        domainId: reserve.domainId,
        reservationId,
        reservationDigest: current.approval.digest,
        activationId: activation.activationId,
        sourceSiteId: reserve.request.senderSiteId,
        targetSiteId: this.signing.siteId,
        expectedGateVersion: 1,
        outcome: evidence.workflow.status,
        executionEvidenceDigest: federationMaterialDigest(evidence),
        resultManifestDigest: evidence.result?.receipt.manifestDigest ?? null,
        observedAt: evidence.observedAt,
        issuedAt: now.toISOString(),
        salt: randomBytes(32).toString("hex"),
      });
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, now);
      const key = await this.trust.resolveKey(this.signing.siteId, this.signing.keyId, now, tx);
      if (!key.allowedKinds.includes("commercial-terminal"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const approvalJws = await signFederationMessage(
        CommercialTerminalSchema,
        payload,
        this.signing,
      );
      const { digest } = await verifyFederationMessage(
        CommercialTerminalSchema,
        approvalJws,
        key,
        now,
      );
      const [saved] = await tx
        .insert(terminals)
        .values({
          localSiteId: this.signing.siteId,
          reservationId,
          terminalId: payload.terminalId,
          payload,
          digest,
          evidence,
          approvalJws,
          approvedBy: actor.userId,
        })
        .returning();
      if (!saved) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.execution.terminal",
        target: payload.terminalId,
        diff: {
          after: {
            reservationId,
            digest,
            executionEvidenceDigest: payload.executionEvidenceDigest,
          },
        },
      });
      return saved;
    });
  }
}
