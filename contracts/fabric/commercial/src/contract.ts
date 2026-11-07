import { createHash } from "node:crypto";
import {
  assertDelegationTerms,
  FederationAmountSchema,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import {
  assertCommercialBill,
  assertCommercialDiscount,
  assertCommercialSettlement,
} from "@kuintessence/shared/federation/billing";
import {
  CommercialAgreementEnvelopeSchema,
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialReceiptSchema,
  CommercialRecordTypeSchema,
  CommercialReleaseSchema,
  CommercialReservationSchema,
  CommercialSettlementSchema,
  CommercialTerminalSchema,
  CommercialUsageEnvelopeSchema,
  CommercialUsageSchema,
  type FabricCommercialTrust,
  FabricCommercialTrustSchema,
} from "@kuintessence/shared/federation/commercial";
import {
  MarketDemandStateSchema,
  MarketExecutionGateSchema,
} from "@kuintessence/shared/federation/market";
import {
  federationMessageKeyId,
  parseFederationPublicKey,
  verifyFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import type { ChaincodeInterface, ChaincodeStub } from "fabric-shim";
import shim from "fabric-shim";
import { z } from "zod";

const ConfigKey = "kq.commercial.trust.v1";
const Args = z.tuple([z.uuid(), z.uuid()]);
const StoredAgreement = z.strictObject({
  receipt: CommercialReceiptSchema,
  envelope: CommercialAgreementEnvelopeSchema,
  terms: CommercialAgreementSchema,
});
const StoredUsage = z.strictObject({
  receipt: CommercialReceiptSchema,
  envelope: CommercialUsageEnvelopeSchema,
  report: CommercialUsageSchema,
});
const StoredDiscount = z.strictObject({
  receipt: CommercialReceiptSchema,
  envelope: CommercialUsageEnvelopeSchema,
  terms: CommercialDiscountSchema,
});
const StoredBill = z.strictObject({
  receipt: CommercialReceiptSchema,
  envelope: CommercialAgreementEnvelopeSchema,
  terms: CommercialBillSchema,
});
const StoredSettlement = z.strictObject({
  receipt: CommercialReceiptSchema,
  envelope: CommercialAgreementEnvelopeSchema,
  terms: CommercialSettlementSchema,
});
const StoredReservation = z.strictObject({
  receipt: CommercialReceiptSchema,
  envelope: CommercialAgreementEnvelopeSchema,
  reservation: CommercialReservationSchema,
  state: z.enum(["locked", "released", "terminal", "settled"]),
  settlement: StoredSettlement.optional(),
  terminal: z
    .strictObject({
      receipt: CommercialReceiptSchema,
      envelope: CommercialAgreementEnvelopeSchema,
      terms: CommercialTerminalSchema,
    })
    .optional(),
  release: z
    .strictObject({
      receipt: CommercialReceiptSchema,
      envelope: CommercialAgreementEnvelopeSchema,
      terms: CommercialReleaseSchema,
    })
    .nullable(),
});
const Budget = z.strictObject({
  sourceSiteId: z.uuid(),
  targetSiteId: z.uuid(),
  unit: z.string(),
  limit: FederationAmountSchema,
  locked: FederationAmountSchema,
  spent: FederationAmountSchema,
  maxReservations: z.number().int().positive(),
  reservations: z.number().int().nonnegative(),
  salt: z.string().regex(/^[a-f0-9]{64}$/),
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const fail = (code: ConstructorParameters<typeof FederationError>[0]): never => {
  throw new FederationError(code);
};
type Stub = Pick<
  ChaincodeStub,
  | "getFunctionAndParameters"
  | "invokeChaincode"
  | "getChannelID"
  | "getState"
  | "putState"
  | "setStateValidationParameter"
  | "createCompositeKey"
  | "getPrivateData"
  | "getPrivateDataHash"
  | "putPrivateData"
  | "getTransient"
  | "getDateTimestamp"
>;
interface Identity {
  getMSPID(): string;
  getAttributeValue(name: string): string | null;
}

export class CommercialLedger {
  readonly trust: FabricCommercialTrust;
  private readonly configBytes: Buffer;
  constructor(input: FabricCommercialTrust) {
    this.trust = FabricCommercialTrustSchema.parse(input);
    this.configBytes = encode(this.trust);
  }
  private organization(identity: Identity, role: "commercial" | "trust-admin" | "market") {
    const org = this.trust.organizations.find(
      (org) =>
        org.mspId === identity.getMSPID() &&
        org.siteId === identity.getAttributeValue("kq.federation.site"),
    );
    if (!org || identity.getAttributeValue("kq.federation.role") !== role)
      return fail("UNTRUSTED_IDENTITY");
    return org;
  }
  private endorsement(msps: string[]) {
    const policy = new shim.KeyEndorsementPolicy();
    policy.addOrgs("PEER", ...msps);
    return policy.getPolicy();
  }
  private keyState(stub: Stub, siteId: string, keyId: string) {
    return stub.createCompositeKey("revoked", [siteId, keyId]);
  }
  private async privateValue(stub: Stub, collection: string, key: string) {
    const hash = await stub.getPrivateDataHash(collection, key);
    const bytes = await stub.getPrivateData(collection, key);
    if (
      (hash.length && !createHash("sha256").update(bytes).digest().equals(Buffer.from(hash))) ||
      (!hash.length && bytes.length)
    )
      return fail("DATA_WAITING");
    return bytes;
  }
  private async verify<T extends { kind: string }>(
    stub: Stub,
    schema: z.ZodType<T>,
    jws: string,
    siteId: string,
    now: Date,
  ) {
    const keyId = federationMessageKeyId(jws);
    const key = this.trust.organizations
      .find((org) => org.siteId === siteId)
      ?.keys.find((key) => key.keyId === keyId);
    const purpose = this.trust.keyPurposes.find(
      (item) => item.siteId === siteId && item.keyId === keyId,
    );
    if (
      !key ||
      !purpose ||
      Buffer.from(await stub.getState(this.keyState(stub, siteId, keyId))).toString() !== "active"
    )
      return fail("UNTRUSTED_IDENTITY");
    return verifyFederationMessage(
      schema,
      jws,
      {
        siteId,
        keyId,
        publicKey: await parseFederationPublicKey(key.publicKeyPem),
        validFrom: new Date(key.validFrom),
        validUntil: new Date(key.validUntil),
        revoked: false,
        allowedKinds: purpose.kinds,
      },
      now,
    );
  }
  private input<T>(stub: Stub, schema: z.ZodType<T>): T {
    const transient = stub.getTransient();
    const bytes = transient.get("commercial");
    if (transient.size !== 1 || !bytes || bytes.length > 1048576) return fail("INVALID_MESSAGE");
    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }
  private async market(stub: Stub, demandId: string) {
    const response = await stub.invokeChaincode(
      "kq-market",
      ["GetDemand", demandId],
      stub.getChannelID(),
    );
    if (response.status !== 200 || !response.payload) return fail("LEDGER_REQUIRED");
    return MarketDemandStateSchema.parse(JSON.parse(Buffer.from(response.payload).toString()));
  }
  private async reserve(
    stub: Stub,
    domain: FabricCommercialTrust["domains"][number],
    recordId: string,
  ) {
    const envelope = this.input(stub, CommercialAgreementEnvelopeSchema),
      now = stub.getDateTimestamp();
    if (
      !domain.siteIds.includes(envelope.sourceSiteId) ||
      !domain.siteIds.includes(envelope.targetSiteId) ||
      envelope.sourceSiteId === envelope.targetSiteId
    )
      return fail("POLICY_DENIED");
    const signed = await this.verify(
      stub,
      CommercialReservationSchema,
      envelope.sourceJws,
      envelope.sourceSiteId,
      now,
    );
    const other = await this.verify(
      stub,
      CommercialReservationSchema,
      envelope.targetJws,
      envelope.targetSiteId,
      now,
    );
    if (signed.digest !== other.digest) return fail("OPERATION_CONFLICT");
    const reservation = signed.payload,
      request = reservation.request;
    if (
      reservation.domainId !== domain.domainId ||
      reservation.reservationId !== recordId ||
      request.senderSiteId !== envelope.sourceSiteId ||
      request.recipientSiteId !== envelope.targetSiteId ||
      request.mode !== "ledger_coordinated"
    )
      return fail("POLICY_DENIED");
    const key = stub.createCompositeKey("reservation", [domain.domainId, recordId]);
    const priorBytes = await this.privateValue(stub, domain.collection, key);
    if (priorBytes.length) {
      const prior = StoredReservation.parse(JSON.parse(Buffer.from(priorBytes).toString()));
      if (prior.receipt.digest !== signed.digest) return fail("OPERATION_CONFLICT");
      // Retain the collection AND policy on idempotent submissions without resetting funds or the gate.
      await stub.putPrivateData(domain.collection, key, priorBytes);
      return encode(prior.receipt);
    }
    const agreementBytes = await this.privateValue(
      stub,
      domain.collection,
      stub.createCompositeKey("agreement", [domain.domainId, request.agreementRevisionId]),
    );
    if (!agreementBytes.length) return fail("AGREEMENT_UNAVAILABLE");
    const agreement = StoredAgreement.parse(JSON.parse(Buffer.from(agreementBytes).toString()));
    if (
      agreement.receipt.digest !== reservation.agreementDigest ||
      agreement.terms.agreement.mode !== "ledger_coordinated" ||
      (agreement.terms.consideration === "charity" && request.maxAmount !== "0")
    )
      return fail("POLICY_DENIED");
    assertDelegationTerms(agreement.terms.agreement, request, now);
    const market = await this.market(stub, reservation.demandId);
    if (
      market.status !== "CLAIMED" ||
      market.version !== reservation.claimVersion ||
      market.claim?.claimId !== recordId ||
      market.claim.commercialDomainId !== domain.domainId ||
      market.claim.providerSiteId !== request.recipientSiteId ||
      market.demand.sourceSiteId !== request.senderSiteId ||
      federationCanonicalJson(market.demand.resources) !==
        federationCanonicalJson(request.resources)
    )
      return fail("OPERATION_CONFLICT");
    if (Date.parse(market.claim.expiresAt) < Date.parse(request.expiresAt))
      return fail("AUTHORIZATION_EXPIRED");
    const markerKeys = [
      stub.createCompositeKey("reservation-task", [
        domain.domainId,
        request.taskId,
        String(request.attempt),
      ]),
      stub.createCompositeKey("reservation-operation", [domain.domainId, request.operationId]),
    ];
    for (const marker of markerKeys)
      if ((await this.privateValue(stub, domain.collection, marker)).length)
        return fail("OPERATION_CONFLICT");
    const terms = agreement.terms.agreement;
    const budgetKey = stub.createCompositeKey("budget", [
      domain.domainId,
      request.budgetDomainId,
      request.epoch,
    ]);
    const budgetBytes = await this.privateValue(stub, domain.collection, budgetKey);
    const budget = budgetBytes.length
      ? Budget.parse(JSON.parse(Buffer.from(budgetBytes).toString()))
      : Budget.parse({
          sourceSiteId: request.senderSiteId,
          targetSiteId: request.recipientSiteId,
          unit: terms.unit,
          limit: terms.budgetLimit,
          maxReservations: terms.maxReservations,
          locked: "0",
          spent: "0",
          reservations: 0,
          salt: reservation.salt,
        });
    if (
      budget.sourceSiteId !== request.senderSiteId ||
      budget.targetSiteId !== request.recipientSiteId ||
      budget.unit !== terms.unit ||
      budget.limit !== terms.budgetLimit ||
      budget.maxReservations !== terms.maxReservations
    )
      return fail("OPERATION_CONFLICT");
    const locked = BigInt(budget.locked) + BigInt(request.maxAmount);
    if (
      locked + BigInt(budget.spent) > BigInt(budget.limit) ||
      budget.reservations >= budget.maxReservations
    )
      return fail("BUDGET_EXHAUSTED");
    const receipt = { recordId, digest: signed.digest };
    const gate = MarketExecutionGateSchema.parse({
      domainId: domain.domainId,
      reservationId: recordId,
      demandId: reservation.demandId,
      claimVersion: reservation.claimVersion,
      version: 1,
      state: "READY",
      reservationDigest: signed.digest,
      expiresAt: request.expiresAt,
    });
    await stub.putPrivateData(
      domain.collection,
      budgetKey,
      encode({ ...budget, locked: locked.toString(), reservations: budget.reservations + 1 }),
    );
    await stub.putPrivateData(
      domain.collection,
      key,
      encode({ receipt, envelope, reservation, state: "locked", release: null }),
    );
    await stub.putPrivateData(
      domain.collection,
      stub.createCompositeKey("execution-gate", [domain.domainId, recordId]),
      encode(gate),
    );
    for (const marker of markerKeys)
      await stub.putPrivateData(
        domain.collection,
        marker,
        encode({ reservationId: recordId, salt: reservation.salt }),
      );
    return encode(receipt);
  }
  private async release(
    stub: Stub,
    domain: FabricCommercialTrust["domains"][number],
    recordId: string,
  ) {
    const envelope = this.input(stub, CommercialAgreementEnvelopeSchema),
      now = stub.getDateTimestamp();
    if (
      !domain.siteIds.includes(envelope.sourceSiteId) ||
      !domain.siteIds.includes(envelope.targetSiteId) ||
      envelope.sourceSiteId === envelope.targetSiteId
    )
      return fail("POLICY_DENIED");
    const signed = await this.verify(
      stub,
      CommercialReleaseSchema,
      envelope.sourceJws,
      envelope.sourceSiteId,
      now,
    );
    const other = await this.verify(
      stub,
      CommercialReleaseSchema,
      envelope.targetJws,
      envelope.targetSiteId,
      now,
    );
    if (signed.digest !== other.digest) return fail("OPERATION_CONFLICT");
    const release = signed.payload;
    if (
      release.releaseId !== recordId ||
      release.domainId !== domain.domainId ||
      release.sourceSiteId !== envelope.sourceSiteId ||
      release.targetSiteId !== envelope.targetSiteId ||
      Date.parse(release.issuedAt) > now.getTime() + 60000
    )
      return fail("POLICY_DENIED");
    const key = stub.createCompositeKey("reservation", [domain.domainId, release.reservationId]);
    const bytes = await this.privateValue(stub, domain.collection, key);
    if (!bytes.length) return fail("ASSET_UNAVAILABLE");
    const stored = StoredReservation.parse(JSON.parse(Buffer.from(bytes).toString()));
    const { reservation } = stored,
      { request } = reservation;
    if (
      stored.receipt.digest !== release.reservationDigest ||
      request.senderSiteId !== release.sourceSiteId ||
      request.recipientSiteId !== release.targetSiteId
    )
      return fail("POLICY_DENIED");
    if (stored.release) {
      if (stored.release.receipt.digest !== signed.digest) return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(domain.collection, key, bytes);
      return encode(stored.release.receipt);
    }
    const releaseKey = stub.createCompositeKey("release", [domain.domainId, release.releaseId]);
    if ((await this.privateValue(stub, domain.collection, releaseKey)).length)
      return fail("OPERATION_CONFLICT");
    const gateKey = stub.createCompositeKey("execution-gate", [
      domain.domainId,
      release.reservationId,
    ]);
    const gate = MarketExecutionGateSchema.parse(
      JSON.parse(Buffer.from(await this.privateValue(stub, domain.collection, gateKey)).toString()),
    );
    if (
      stored.state !== "locked" ||
      gate.state !== "READY" ||
      gate.version !== release.expectedGateVersion ||
      gate.reservationDigest !== stored.receipt.digest
    )
      return fail("OPERATION_CONFLICT");
    const market = await this.market(stub, reservation.demandId);
    // ACTIVE needs a separately confirmed stop/terminal path; expiry is never evidence that execution stopped.
    if (
      market.status !== "CLAIMED" ||
      market.version !== reservation.claimVersion ||
      market.claim?.claimId !== release.reservationId ||
      market.claim.commercialDomainId !== domain.domainId
    )
      return fail("OPERATION_CONFLICT");
    const budgetKey = stub.createCompositeKey("budget", [
      domain.domainId,
      request.budgetDomainId,
      request.epoch,
    ]);
    const budget = Budget.parse(
      JSON.parse(
        Buffer.from(await this.privateValue(stub, domain.collection, budgetKey)).toString(),
      ),
    );
    if (budget.reservations < 1 || BigInt(budget.locked) < BigInt(request.maxAmount))
      return fail("OPERATION_CONFLICT");
    const receipt = { recordId, digest: signed.digest };
    await stub.putPrivateData(
      domain.collection,
      budgetKey,
      encode({
        ...budget,
        locked: (BigInt(budget.locked) - BigInt(request.maxAmount)).toString(),
        reservations: budget.reservations - 1,
      }),
    );
    await stub.putPrivateData(
      domain.collection,
      gateKey,
      encode({ ...gate, version: gate.version + 1, state: "REVOKED" }),
    );
    await stub.putPrivateData(
      domain.collection,
      key,
      encode({ ...stored, state: "released", release: { receipt, envelope, terms: release } }),
    );
    await stub.putPrivateData(
      domain.collection,
      releaseKey,
      encode({
        reservationId: release.reservationId,
        receipt,
        salt: release.salt,
      }),
    );
    return encode(receipt);
  }
  private async terminal(
    stub: Stub,
    domain: FabricCommercialTrust["domains"][number],
    recordId: string,
  ) {
    const envelope = this.input(stub, CommercialAgreementEnvelopeSchema),
      now = stub.getDateTimestamp();
    if (
      envelope.sourceSiteId === envelope.targetSiteId ||
      !domain.siteIds.includes(envelope.sourceSiteId) ||
      !domain.siteIds.includes(envelope.targetSiteId)
    )
      return fail("POLICY_DENIED");
    const signed = await this.verify(
      stub,
      CommercialTerminalSchema,
      envelope.sourceJws,
      envelope.sourceSiteId,
      now,
    );
    const other = await this.verify(
      stub,
      CommercialTerminalSchema,
      envelope.targetJws,
      envelope.targetSiteId,
      now,
    );
    if (signed.digest !== other.digest) return fail("OPERATION_CONFLICT");
    const terms = signed.payload;
    if (
      terms.terminalId !== recordId ||
      terms.domainId !== domain.domainId ||
      terms.sourceSiteId !== envelope.sourceSiteId ||
      terms.targetSiteId !== envelope.targetSiteId ||
      Date.parse(terms.issuedAt) > now.getTime() + 60000
    )
      return fail("POLICY_DENIED");
    const key = stub.createCompositeKey("reservation", [domain.domainId, terms.reservationId]);
    const bytes = await this.privateValue(stub, domain.collection, key);
    if (!bytes.length) return fail("ASSET_UNAVAILABLE");
    const stored = StoredReservation.parse(JSON.parse(Buffer.from(bytes).toString()));
    const { reservation } = stored;
    if (
      stored.receipt.digest !== terms.reservationDigest ||
      reservation.request.senderSiteId !== terms.sourceSiteId ||
      reservation.request.recipientSiteId !== terms.targetSiteId ||
      Date.parse(terms.observedAt) < Date.parse(reservation.request.issuedAt)
    )
      return fail("POLICY_DENIED");
    if (stored.terminal) {
      if (stored.terminal.receipt.digest !== signed.digest) return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(domain.collection, key, bytes);
      return encode(stored.terminal.receipt);
    }
    const terminalKey = stub.createCompositeKey("terminal", [domain.domainId, recordId]);
    if ((await this.privateValue(stub, domain.collection, terminalKey)).length)
      return fail("OPERATION_CONFLICT");
    const gateKey = stub.createCompositeKey("execution-gate", [
      domain.domainId,
      terms.reservationId,
    ]);
    const gate = MarketExecutionGateSchema.parse(
      JSON.parse(Buffer.from(await this.privateValue(stub, domain.collection, gateKey)).toString()),
    );
    const market = await this.market(stub, reservation.demandId);
    if (
      stored.state !== "locked" ||
      stored.release ||
      gate.state !== "READY" ||
      gate.version !== terms.expectedGateVersion ||
      gate.reservationDigest !== stored.receipt.digest ||
      !["ACTIVE", "STOPPING"].includes(market.status) ||
      market.activation?.activationId !== terms.activationId ||
      market.activation.expectedVersion !== reservation.claimVersion ||
      market.claim?.claimId !== reservation.reservationId ||
      market.claim.commercialDomainId !== domain.domainId ||
      market.claim.providerSiteId !== terms.targetSiteId ||
      market.demand.sourceSiteId !== terms.sourceSiteId ||
      federationCanonicalJson(market.activation.gate) !== federationCanonicalJson(gate)
    )
      return fail("OPERATION_CONFLICT");
    const receipt = { recordId, digest: signed.digest };
    const terminal = { receipt, envelope, terms };
    // This hashed write invalidates uncommitted renewals; terminal acknowledgment never changes money.
    const closedGate = MarketExecutionGateSchema.parse({
      ...gate,
      version: gate.version + 1,
      state: "TERMINAL",
      terminal: { terminalId: recordId, activationId: terms.activationId, digest: signed.digest },
    });
    await stub.putPrivateData(domain.collection, gateKey, encode(closedGate));
    await stub.putPrivateData(
      domain.collection,
      key,
      encode({ ...stored, state: "terminal", terminal }),
    );
    await stub.putPrivateData(
      domain.collection,
      terminalKey,
      encode({ reservationId: terms.reservationId, receipt, salt: terms.salt }),
    );
    return encode(receipt);
  }
  private async billingOriginals(
    stub: Stub,
    domain: FabricCommercialTrust["domains"][number],
    reportId: string,
  ) {
    const usageBytes = await this.privateValue(
      stub,
      domain.collection,
      stub.createCompositeKey("usage", [domain.domainId, reportId]),
    );
    if (!usageBytes.length) return fail("ASSET_UNAVAILABLE");
    const usage = StoredUsage.parse(JSON.parse(Buffer.from(usageBytes).toString()));
    const agreementBytes = await this.privateValue(
      stub,
      domain.collection,
      stub.createCompositeKey("agreement", [domain.domainId, usage.report.agreementRevisionId]),
    );
    if (!agreementBytes.length) return fail("ASSET_UNAVAILABLE");
    return {
      usage,
      agreement: StoredAgreement.parse(JSON.parse(Buffer.from(agreementBytes).toString())),
    };
  }
  private async discount(
    stub: Stub,
    domain: FabricCommercialTrust["domains"][number],
    recordId: string,
    siteId: string,
  ) {
    const envelope = this.input(stub, CommercialUsageEnvelopeSchema);
    const now = stub.getDateTimestamp();
    const signed = await this.verify(
      stub,
      CommercialDiscountSchema,
      envelope.providerJws,
      siteId,
      now,
    );
    const terms = signed.payload;
    if (
      terms.discountId !== recordId ||
      terms.domainId !== domain.domainId ||
      terms.targetSiteId !== siteId ||
      !domain.siteIds.includes(terms.sourceSiteId) ||
      terms.sourceSiteId === terms.targetSiteId ||
      Date.parse(terms.issuedAt) > now.getTime() + 60000
    )
      return fail("POLICY_DENIED");
    const key = stub.createCompositeKey("discount", [domain.domainId, recordId]);
    const bytes = await this.privateValue(stub, domain.collection, key);
    if (bytes.length) {
      const prior = StoredDiscount.parse(JSON.parse(Buffer.from(bytes).toString()));
      if (prior.receipt.digest !== signed.digest) return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(domain.collection, key, bytes);
      return encode(prior.receipt);
    }
    const { usage, agreement } = await this.billingOriginals(stub, domain, terms.reportId);
    assertCommercialDiscount(
      terms,
      agreement.terms,
      agreement.receipt.digest,
      usage.report,
      usage.receipt.digest,
    );
    // A later concession must use an adjustment, never mutate an already confirmed bill.
    if (
      (
        await this.privateValue(
          stub,
          domain.collection,
          stub.createCompositeKey("bill", [domain.domainId, terms.billId]),
        )
      ).length
    )
      return fail("OPERATION_CONFLICT");
    const receipt = { recordId, digest: signed.digest };
    await stub.putPrivateData(domain.collection, key, encode({ receipt, envelope, terms }));
    return encode(receipt);
  }
  private async bill(
    stub: Stub,
    domain: FabricCommercialTrust["domains"][number],
    recordId: string,
  ) {
    const envelope = this.input(stub, CommercialAgreementEnvelopeSchema);
    const now = stub.getDateTimestamp();
    if (
      envelope.sourceSiteId === envelope.targetSiteId ||
      !domain.siteIds.includes(envelope.sourceSiteId) ||
      !domain.siteIds.includes(envelope.targetSiteId)
    )
      return fail("POLICY_DENIED");
    const signed = await this.verify(
      stub,
      CommercialBillSchema,
      envelope.sourceJws,
      envelope.sourceSiteId,
      now,
    );
    const other = await this.verify(
      stub,
      CommercialBillSchema,
      envelope.targetJws,
      envelope.targetSiteId,
      now,
    );
    if (signed.digest !== other.digest) return fail("OPERATION_CONFLICT");
    const terms = signed.payload;
    if (
      terms.billId !== recordId ||
      terms.domainId !== domain.domainId ||
      terms.request.senderSiteId !== envelope.sourceSiteId ||
      terms.request.recipientSiteId !== envelope.targetSiteId ||
      Date.parse(terms.issuedAt) > now.getTime() + 60000
    )
      return fail("POLICY_DENIED");
    const key = stub.createCompositeKey("bill", [domain.domainId, recordId]);
    const bytes = await this.privateValue(stub, domain.collection, key);
    if (bytes.length) {
      const prior = StoredBill.parse(JSON.parse(Buffer.from(bytes).toString()));
      if (prior.receipt.digest !== signed.digest) return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(domain.collection, key, bytes);
      return encode(prior.receipt);
    }
    const { usage, agreement } = await this.billingOriginals(stub, domain, terms.reportId);
    const scope = [
      domain.domainId,
      terms.request.agreementRevisionId,
      terms.request.taskId,
      String(terms.request.attempt),
    ];
    const headKey = stub.createCompositeKey("bill-head", scope);
    if ((await this.privateValue(stub, domain.collection, headKey)).length)
      return fail("OPERATION_CONFLICT");
    const usageHead = z
      .object({ reportId: z.uuid() })
      .parse(
        JSON.parse(
          Buffer.from(
            await this.privateValue(
              stub,
              domain.collection,
              stub.createCompositeKey("usage-head", scope),
            ),
          ).toString(),
        ),
      );
    if (usageHead.reportId !== terms.reportId) return fail("OPERATION_CONFLICT");
    let concession: z.infer<typeof StoredDiscount> | undefined;
    if (terms.discount) {
      const discountBytes = await this.privateValue(
        stub,
        domain.collection,
        stub.createCompositeKey("discount", [domain.domainId, terms.discount.discountId]),
      );
      if (!discountBytes.length) return fail("ASSET_UNAVAILABLE");
      concession = StoredDiscount.parse(JSON.parse(Buffer.from(discountBytes).toString()));
    }
    assertCommercialBill(
      terms,
      agreement.terms,
      agreement.receipt.digest,
      usage.report,
      usage.receipt.digest,
      concession ? { terms: concession.terms, digest: concession.receipt.digest } : undefined,
    );
    if (terms.reservationId) {
      const reservationBytes = await this.privateValue(
        stub,
        domain.collection,
        stub.createCompositeKey("reservation", [domain.domainId, terms.reservationId]),
      );
      if (!reservationBytes.length) return fail("ASSET_UNAVAILABLE");
      const stored = StoredReservation.parse(JSON.parse(Buffer.from(reservationBytes).toString()));
      if (
        stored.state !== "terminal" ||
        !stored.terminal ||
        stored.release ||
        stored.reservation.agreementDigest !== terms.agreementDigest ||
        Date.parse(usage.report.periodEnd) > Date.parse(stored.terminal.terms.observedAt) ||
        federationCanonicalJson(stored.reservation.request) !==
          federationCanonicalJson(terms.request)
      )
        return fail("OPERATION_CONFLICT");
    }
    const receipt = { recordId, digest: signed.digest };
    await stub.putPrivateData(domain.collection, key, encode({ receipt, envelope, terms }));
    await stub.putPrivateData(
      domain.collection,
      headKey,
      encode({ billId: recordId, salt: terms.salt }),
    );
    return encode(receipt);
  }
  private async settle(
    stub: Stub,
    domain: FabricCommercialTrust["domains"][number],
    recordId: string,
  ) {
    const envelope = this.input(stub, CommercialAgreementEnvelopeSchema),
      now = stub.getDateTimestamp();
    if (
      envelope.sourceSiteId === envelope.targetSiteId ||
      !domain.siteIds.includes(envelope.sourceSiteId) ||
      !domain.siteIds.includes(envelope.targetSiteId)
    )
      return fail("POLICY_DENIED");
    const signed = await this.verify(
      stub,
      CommercialSettlementSchema,
      envelope.sourceJws,
      envelope.sourceSiteId,
      now,
    );
    const other = await this.verify(
      stub,
      CommercialSettlementSchema,
      envelope.targetJws,
      envelope.targetSiteId,
      now,
    );
    if (signed.digest !== other.digest) return fail("OPERATION_CONFLICT");
    const terms = signed.payload;
    if (
      terms.settlementId !== recordId ||
      terms.domainId !== domain.domainId ||
      terms.sourceSiteId !== envelope.sourceSiteId ||
      terms.targetSiteId !== envelope.targetSiteId ||
      Date.parse(terms.issuedAt) > now.getTime() + 60000
    )
      return fail("POLICY_DENIED");
    const key = stub.createCompositeKey("settlement", [domain.domainId, recordId]);
    const bytes = await this.privateValue(stub, domain.collection, key);
    if (bytes.length) {
      const original = StoredSettlement.parse(JSON.parse(Buffer.from(bytes).toString()));
      if (original.receipt.digest !== signed.digest) return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(domain.collection, key, bytes);
      return encode(original.receipt);
    }
    const billBytes = await this.privateValue(
      stub,
      domain.collection,
      stub.createCompositeKey("bill", [domain.domainId, terms.billId]),
    );
    if (!billBytes.length) return fail("ASSET_UNAVAILABLE");
    const bill = StoredBill.parse(JSON.parse(Buffer.from(billBytes).toString()));
    assertCommercialSettlement(terms, bill.terms, bill.receipt.digest);
    if (bill.terms.request.mode === "bilateral_direct") return fail("POLICY_DENIED");
    const headKey = stub.createCompositeKey("settlement-head", [domain.domainId, terms.billId]);
    if ((await this.privateValue(stub, domain.collection, headKey)).length)
      return fail("OPERATION_CONFLICT");
    const receipt = { recordId, digest: signed.digest },
      settlement = { receipt, envelope, terms };
    if (terms.reservationId) {
      const reservationKey = stub.createCompositeKey("reservation", [
        domain.domainId,
        terms.reservationId,
      ]);
      const reservationBytes = await this.privateValue(stub, domain.collection, reservationKey);
      if (!reservationBytes.length) return fail("ASSET_UNAVAILABLE");
      const stored = StoredReservation.parse(JSON.parse(Buffer.from(reservationBytes).toString()));
      const gateKey = stub.createCompositeKey("execution-gate", [
        domain.domainId,
        terms.reservationId,
      ]);
      const gate = MarketExecutionGateSchema.parse(
        JSON.parse(
          Buffer.from(await this.privateValue(stub, domain.collection, gateKey)).toString(),
        ),
      );
      if (
        stored.state !== "terminal" ||
        stored.release ||
        stored.settlement ||
        !stored.terminal ||
        !terms.terminal ||
        !gate.terminal ||
        stored.terminal.receipt.recordId !== terms.terminal?.terminalId ||
        stored.terminal.receipt.digest !== terms.terminal.digest ||
        gate.state !== "TERMINAL" ||
        gate.terminal?.terminalId !== terms.terminal.terminalId ||
        gate.terminal.digest !== terms.terminal.digest ||
        gate.reservationDigest !== stored.receipt.digest ||
        gate.reservationId !== terms.reservationId ||
        federationCanonicalJson(stored.reservation.request) !==
          federationCanonicalJson(bill.terms.request)
      )
        return fail("OPERATION_CONFLICT");
      const request = stored.reservation.request;
      const budgetKey = stub.createCompositeKey("budget", [
        domain.domainId,
        request.budgetDomainId,
        request.epoch,
      ]);
      const budget = Budget.parse(
        JSON.parse(
          Buffer.from(await this.privateValue(stub, domain.collection, budgetKey)).toString(),
        ),
      );
      const reserved = BigInt(terms.reservedAmount),
        locked = BigInt(budget.locked),
        spent = BigInt(budget.spent);
      if (
        budget.sourceSiteId !== terms.sourceSiteId ||
        budget.targetSiteId !== terms.targetSiteId ||
        budget.unit !== terms.unit ||
        budget.reservations < 1 ||
        locked < reserved ||
        locked + spent > BigInt(budget.limit)
      )
        return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(
        domain.collection,
        budgetKey,
        encode({
          ...budget,
          locked: (locked - reserved).toString(),
          spent: (spent + BigInt(terms.chargedAmount)).toString(),
          reservations: budget.reservations - 1,
        }),
      );
      await stub.putPrivateData(
        domain.collection,
        reservationKey,
        encode({ ...stored, state: "settled", settlement }),
      );
      // The terminal gate remains immutable: settlement cannot authorize a new attempt.
    }
    // Attested mode records the approved local settlement without creating a second spendable budget.
    await stub.putPrivateData(domain.collection, key, encode(settlement));
    await stub.putPrivateData(
      domain.collection,
      headKey,
      encode({ settlementId: recordId, salt: terms.salt }),
    );
    return encode(receipt);
  }
  async initialize(stub: Stub, identity: Identity): Promise<Buffer> {
    this.organization(identity, "trust-admin");
    const { fcn, params } = stub.getFunctionAndParameters();
    if (fcn !== "Init" || params.length || stub.getTransient().size) return fail("INVALID_MESSAGE");
    if ((await stub.getState(ConfigKey)).length) return fail("OPERATION_CONFLICT");
    for (const org of this.trust.organizations)
      for (const key of org.keys) {
        await parseFederationPublicKey(key.publicKeyPem);
        const stateKey = this.keyState(stub, org.siteId, key.keyId);
        await stub.putState(stateKey, Buffer.from("active"));
        await stub.setStateValidationParameter(stateKey, this.endorsement([org.mspId]));
      }
    await stub.putState(ConfigKey, this.configBytes);
    await stub.setStateValidationParameter(
      ConfigKey,
      this.endorsement(this.trust.organizations.map((org) => org.mspId)),
    );
    return encode({
      digest: `sha256:${createHash("sha256").update(this.configBytes).digest("hex")}`,
    });
  }
  async invoke(stub: Stub, identity: Identity): Promise<Buffer> {
    if (!Buffer.from(await stub.getState(ConfigKey)).equals(this.configBytes))
      return fail("POLICY_DENIED");
    const { fcn, params } = stub.getFunctionAndParameters();
    if (fcn === "GetExecutionGateHash") {
      const role = identity.getAttributeValue("kq.federation.role");
      if (role !== "market" && role !== "commercial") return fail("UNTRUSTED_IDENTITY");
      this.organization(identity, role);
      const [domainId, reservationId] = Args.parse(params);
      const domain = this.trust.domains.find((value) => value.domainId === domainId);
      if (!domain) return fail("ASSET_UNAVAILABLE");
      // All channel members may read hashes. Never load or return the private gate body here.
      const hash = await stub.getPrivateDataHash(
        domain.collection,
        stub.createCompositeKey("execution-gate", [domainId, reservationId]),
      );
      if (!hash.length) return fail("ASSET_UNAVAILABLE");
      return encode({ hash: Buffer.from(hash).toString("hex") });
    }
    if (fcn === "RevokeKey") {
      const org = this.organization(identity, "trust-admin");
      const [siteId, keyId] = z
        .tuple([z.uuid(), z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)])
        .parse(params);
      if (
        stub.getTransient().size ||
        siteId !== org.siteId ||
        !org.keys.some((key) => key.keyId === keyId)
      )
        return fail("POLICY_DENIED");
      await stub.putState(this.keyState(stub, siteId, keyId), Buffer.from("revoked"));
      return encode({ revoked: true });
    }
    if (fcn === "GetRecordReceipt") {
      const org = this.organization(identity, "commercial");
      const [domainId, recordType, recordId] = z
        .tuple([z.uuid(), CommercialRecordTypeSchema, z.uuid()])
        .parse(params);
      const domain = this.trust.domains.find((value) => value.domainId === domainId);
      if (!domain?.siteIds.includes(org.siteId)) return fail("POLICY_DENIED");
      if (stub.getTransient().size) return fail("INVALID_MESSAGE");
      const bytes = await this.privateValue(
        stub,
        domain.collection,
        stub.createCompositeKey(recordType, [domainId, recordId]),
      );
      if (!bytes.length) return encode({ receipt: null });
      const { receipt } = z
        .object({ receipt: CommercialReceiptSchema })
        .parse(JSON.parse(Buffer.from(bytes).toString()));
      if (receipt.recordId !== recordId) return fail("OPERATION_CONFLICT");
      return encode({ receipt });
    }
    if (
      ![
        "RegisterAgreement",
        "RecordUsage",
        "GetAgreementReceipt",
        "GetUsageReceipt",
        "ReserveExecution",
        "ReleaseExecution",
        "RecordExecutionTerminal",
        "RecordDiscount",
        "ConfirmBill",
        "SettleBill",
      ].includes(fcn)
    )
      return fail("INVALID_MESSAGE");
    const org = this.organization(identity, "commercial");
    const [domainId, recordId] = Args.parse(params);
    const domain = this.trust.domains.find((domain) => domain.domainId === domainId);
    if (!domain?.siteIds.includes(org.siteId)) return fail("POLICY_DENIED");
    if (fcn === "RecordDiscount") return this.discount(stub, domain, recordId, org.siteId);
    if (fcn === "SettleBill") return this.settle(stub, domain, recordId);
    if (fcn === "ConfirmBill") return this.bill(stub, domain, recordId);
    if (fcn === "ReserveExecution") return this.reserve(stub, domain, recordId);
    if (fcn === "ReleaseExecution") return this.release(stub, domain, recordId);
    if (fcn === "RecordExecutionTerminal") return this.terminal(stub, domain, recordId);
    const agreementOperation = fcn === "RegisterAgreement" || fcn === "GetAgreementReceipt";
    const key = stub.createCompositeKey(agreementOperation ? "agreement" : "usage", [
      domainId,
      recordId,
    ]);
    const priorBytes = await this.privateValue(stub, domain.collection, key);
    const prior = priorBytes.length
      ? (agreementOperation ? StoredAgreement : StoredUsage).parse(
          JSON.parse(Buffer.from(priorBytes).toString()),
        )
      : undefined;
    if (fcn.startsWith("Get")) {
      if (stub.getTransient().size) return fail("INVALID_MESSAGE");
      if (!prior) return fail("ASSET_UNAVAILABLE");
      // Never return plaintext contracts or reports: even a read function may be submitted as a transaction.
      return encode(prior.receipt);
    }
    const now = stub.getDateTimestamp();
    if (fcn === "RegisterAgreement") {
      const envelope = this.input(stub, CommercialAgreementEnvelopeSchema);
      if (
        envelope.sourceSiteId === envelope.targetSiteId ||
        !domain.siteIds.includes(envelope.sourceSiteId) ||
        !domain.siteIds.includes(envelope.targetSiteId)
      )
        return fail("POLICY_DENIED");
      const source = await this.verify(
        stub,
        CommercialAgreementSchema,
        envelope.sourceJws,
        envelope.sourceSiteId,
        now,
      );
      const terms = source.payload;
      if (
        terms.domainId !== domainId ||
        terms.agreement.agreementRevisionId !== recordId ||
        !domain.siteIds.includes(terms.agreement.sourceSiteId) ||
        !domain.siteIds.includes(terms.agreement.targetSiteId)
      )
        return fail("POLICY_DENIED");
      if (
        terms.agreement.sourceSiteId !== envelope.sourceSiteId ||
        terms.agreement.targetSiteId !== envelope.targetSiteId
      )
        return fail("POLICY_DENIED");
      const target = await this.verify(
        stub,
        CommercialAgreementSchema,
        envelope.targetJws,
        terms.agreement.targetSiteId,
        now,
      );
      if (source.digest !== target.digest) return fail("OPERATION_CONFLICT");
      if (Date.parse(terms.createdAt) > now.getTime() + 60000) return fail("INVALID_MESSAGE");
      if (!prior && Date.parse(terms.agreement.validUntil) <= now.getTime())
        return fail("AUTHORIZATION_EXPIRED");
      const receipt = { recordId, digest: source.digest };
      if (prior && prior.receipt.digest !== receipt.digest) return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(
        domain.collection,
        key,
        prior ? priorBytes : encode({ receipt, envelope, terms }),
      );
      return encode(receipt);
    }
    const envelope = this.input(stub, CommercialUsageEnvelopeSchema);
    const report = await this.verify(
      stub,
      CommercialUsageSchema,
      envelope.providerJws,
      org.siteId,
      now,
    );
    const usage = report.payload;
    if (
      usage.domainId !== domainId ||
      usage.reportId !== recordId ||
      usage.targetSiteId !== org.siteId ||
      !domain.siteIds.includes(usage.sourceSiteId) ||
      Date.parse(usage.reportedAt) > now.getTime() + 60000
    )
      return fail("POLICY_DENIED");
    const agreementKey = stub.createCompositeKey("agreement", [
      domainId,
      usage.agreementRevisionId,
    ]);
    const agreementBytes = await this.privateValue(stub, domain.collection, agreementKey);
    if (!agreementBytes.length) return fail("ASSET_UNAVAILABLE");
    const stored = StoredAgreement.parse(JSON.parse(Buffer.from(agreementBytes).toString()));
    // Previously committed approvals remain historical facts when their signing keys later expire.
    const terms = stored.terms;
    if (
      usage.agreementDigest !== stored.receipt.digest ||
      terms.agreement.sourceSiteId !== usage.sourceSiteId ||
      terms.agreement.targetSiteId !== usage.targetSiteId ||
      Date.parse(usage.periodStart) < Date.parse(terms.agreement.validFrom) ||
      Date.parse(usage.periodEnd) > Date.parse(terms.agreement.validUntil) ||
      usage.measurements.some(
        (item) =>
          !terms.prices.some(
            (price) => price.metric === item.metric && price.quantityUnit === item.quantityUnit,
          ),
      )
    )
      return fail("POLICY_DENIED");
    const receipt = { recordId, digest: report.digest };
    if (prior) {
      if (prior.receipt.digest !== receipt.digest) return fail("OPERATION_CONFLICT");
      await stub.putPrivateData(domain.collection, key, priorBytes);
      return encode(receipt);
    }
    const headKey = stub.createCompositeKey("usage-head", [
      domainId,
      usage.agreementRevisionId,
      usage.taskId,
      String(usage.attempt),
    ]);
    const headBytes = await this.privateValue(stub, domain.collection, headKey);
    const head = headBytes.length
      ? z
          .strictObject({ reportId: z.uuid(), salt: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(JSON.parse(Buffer.from(headBytes).toString()))
      : null;
    if (
      (usage.correctionOf && head?.reportId !== usage.correctionOf) ||
      (!usage.correctionOf && head)
    )
      return fail("OPERATION_CONFLICT");
    if (usage.correctionOf) {
      const originalBytes = await this.privateValue(
        stub,
        domain.collection,
        stub.createCompositeKey("usage", [domainId, usage.correctionOf]),
      );
      if (!originalBytes.length) return fail("ASSET_UNAVAILABLE");
      const original = StoredUsage.parse(JSON.parse(Buffer.from(originalBytes).toString()));
      if (
        original.report.agreementRevisionId !== usage.agreementRevisionId ||
        original.report.taskId !== usage.taskId ||
        original.report.attempt !== usage.attempt ||
        Date.parse(original.report.reportedAt) > Date.parse(usage.reportedAt)
      )
        return fail("POLICY_DENIED");
    }
    await stub.putPrivateData(domain.collection, key, encode({ receipt, envelope, report: usage }));
    await stub.putPrivateData(
      domain.collection,
      headKey,
      encode({ reportId: usage.reportId, salt: usage.salt }),
    );
    return encode(receipt);
  }
}

export class CommercialChaincode implements ChaincodeInterface {
  private readonly ledger: CommercialLedger;
  constructor(trust: FabricCommercialTrust) {
    this.ledger = new CommercialLedger(trust);
  }
  async Init(stub: ChaincodeStub) {
    return this.respond(() => this.ledger.initialize(stub, new shim.ClientIdentity(stub)));
  }
  async Invoke(stub: ChaincodeStub) {
    return this.respond(() => this.ledger.invoke(stub, new shim.ClientIdentity(stub)));
  }
  private async respond(call: () => Promise<Buffer>) {
    try {
      return shim.success(await call());
    } catch (error) {
      return shim.error(error instanceof FederationError ? error.code : "INVALID_MESSAGE");
    }
  }
}
