import {
  type CommercialAdjustment,
  CommercialAdjustmentSchema,
  type CommercialAgreement,
  CommercialAgreementSchema,
  type CommercialBill,
  CommercialBillCalculationSchema,
  CommercialBillSchema,
  type CommercialDiscount,
  CommercialDiscountSchema,
  type CommercialSettlement,
  CommercialSettlementSchema,
  type CommercialUsage,
  CommercialUsageSchema,
} from "./commercial";
import {
  assertDelegationTerms,
  FederationAmountSchema,
  type FederationDelegation,
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
} from "./index";

/** Pure calculation shared by local billing and chain validation; never consumes a balance. */
export function calculateCommercialBill(
  rawTerms: CommercialAgreement,
  rawRequest: FederationDelegation,
  rawUsage: CommercialUsage,
  rawDiscount = "0",
) {
  const terms = CommercialAgreementSchema.parse(rawTerms);
  const request = FederationDelegationSchema.parse(rawRequest);
  const usage = CommercialUsageSchema.parse(rawUsage);
  const discount = BigInt(FederationAmountSchema.parse(rawDiscount));
  // A historical bill may be confirmed after execution authority expires.
  assertDelegationTerms(terms.agreement, request, new Date(request.issuedAt));
  if (
    usage.domainId !== terms.domainId ||
    usage.agreementRevisionId !== request.agreementRevisionId ||
    usage.taskId !== request.taskId ||
    usage.attempt !== request.attempt ||
    usage.sourceSiteId !== request.senderSiteId ||
    usage.targetSiteId !== request.recipientSiteId ||
    Date.parse(usage.periodStart) < Date.parse(request.issuedAt) ||
    Date.parse(usage.periodEnd) > Date.parse(terms.agreement.validUntil) ||
    usage.measurements.length !== terms.prices.length
  )
    throw new FederationError("POLICY_DENIED");
  const lines = terms.prices.map((price) => {
    const measured = usage.measurements.find((item) => item.metric === price.metric);
    if (!measured || measured.quantityUnit !== price.quantityUnit)
      throw new FederationError("POLICY_DENIED");
    const numerator = BigInt(measured.quantity) * BigInt(price.amount);
    const denominator = BigInt(price.perQuantity);
    return {
      metric: price.metric,
      quantityUnit: price.quantityUnit,
      quantity: measured.quantity,
      perQuantity: price.perQuantity,
      rateAmount: price.amount,
      amount: ((numerator + denominator - 1n) / denominator).toString(),
    };
  });
  const gross = lines.reduce((sum, line) => sum + BigInt(line.amount), 0n);
  const cap = BigInt(request.maxAmount);
  const capped = gross < cap ? gross : cap;
  if (discount > capped) throw new FederationError("POLICY_DENIED");
  // Reject unrepresentable original amounts even when a cap would hide the overflow.
  return CommercialBillCalculationSchema.parse({
    rounding: "ceil-per-line",
    lines,
    grossAmount: gross.toString(),
    capReduction: (gross - capped).toString(),
    discountAmount: discount.toString(),
    dueAmount: (capped - discount).toString(),
  });
}

export function assertCommercialDiscount(
  raw: CommercialDiscount,
  terms: CommercialAgreement,
  agreementDigest: string,
  usage: CommercialUsage,
  reportDigest: string,
) {
  const discount = CommercialDiscountSchema.parse(raw);
  if (
    discount.domainId !== terms.domainId ||
    discount.agreementRevisionId !== terms.agreement.agreementRevisionId ||
    discount.agreementDigest !== agreementDigest ||
    usage.agreementDigest !== agreementDigest ||
    usage.domainId !== terms.domainId ||
    usage.agreementRevisionId !== discount.agreementRevisionId ||
    usage.sourceSiteId !== terms.agreement.sourceSiteId ||
    usage.targetSiteId !== terms.agreement.targetSiteId ||
    discount.reportId !== usage.reportId ||
    discount.reportDigest !== reportDigest ||
    discount.taskId !== usage.taskId ||
    discount.attempt !== usage.attempt ||
    discount.sourceSiteId !== usage.sourceSiteId ||
    discount.targetSiteId !== usage.targetSiteId ||
    discount.unit !== terms.agreement.unit ||
    terms.consideration === "charity" ||
    Date.parse(discount.issuedAt) < Date.parse(usage.reportedAt)
  )
    throw new FederationError("POLICY_DENIED");
}

/** Callers supply authenticated immutable originals, not summaries received from the bill author. */
export function assertCommercialBill(
  raw: CommercialBill,
  terms: CommercialAgreement,
  agreementDigest: string,
  usage: CommercialUsage,
  reportDigest: string,
  concession?: { terms: CommercialDiscount; digest: string },
) {
  const bill = CommercialBillSchema.parse(raw);
  if (
    bill.domainId !== terms.domainId ||
    bill.agreementDigest !== agreementDigest ||
    usage.agreementDigest !== agreementDigest ||
    bill.priceVersionId !== terms.priceVersionId ||
    bill.reportId !== usage.reportId ||
    bill.reportDigest !== reportDigest ||
    Date.parse(bill.issuedAt) < Date.parse(usage.reportedAt) ||
    Boolean(bill.discount) !== Boolean(concession)
  )
    throw new FederationError("POLICY_DENIED");
  if (concession) {
    assertCommercialDiscount(concession.terms, terms, agreementDigest, usage, reportDigest);
    if (
      concession.terms.billId !== bill.billId ||
      concession.terms.discountId !== bill.discount?.discountId ||
      concession.digest !== bill.discount.digest ||
      Date.parse(concession.terms.issuedAt) > Date.parse(bill.issuedAt)
    )
      throw new FederationError("POLICY_DENIED");
  }
  const calculation = calculateCommercialBill(terms, bill.request, usage, concession?.terms.amount);
  if (federationCanonicalJson(calculation) !== federationCanonicalJson(bill.calculation))
    throw new FederationError("OPERATION_CONFLICT");
}

export function assertCommercialSettlement(
  raw: CommercialSettlement,
  original: CommercialBill,
  billDigest: string,
) {
  const value = CommercialSettlementSchema.parse(raw),
    bill = CommercialBillSchema.parse(original);
  if (
    value.domainId !== bill.domainId ||
    value.agreementRevisionId !== bill.request.agreementRevisionId ||
    value.billId !== bill.billId ||
    value.billDigest !== billDigest ||
    value.sourceSiteId !== bill.request.senderSiteId ||
    value.targetSiteId !== bill.request.recipientSiteId ||
    value.reservationId !== bill.reservationId ||
    value.unit !== bill.request.unit ||
    value.reservedAmount !== bill.request.maxAmount ||
    value.chargedAmount !== bill.calculation.dueAmount ||
    Date.parse(value.issuedAt) < Date.parse(bill.issuedAt)
  )
    throw new FederationError("POLICY_DENIED");
}

/** Originals must already be authenticated; callers supply the current head under their ledger lock. */
export function assertCommercialAdjustment(
  raw: CommercialAdjustment,
  originals: {
    agreement: CommercialAgreement;
    bill: { terms: CommercialBill; digest: string };
    settlement: { terms: CommercialSettlement; digest: string };
    previous?: { terms: CommercialAdjustment; digest: string };
  },
) {
  const value = CommercialAdjustmentSchema.parse(raw),
    agreement = CommercialAgreementSchema.parse(originals.agreement),
    bill = CommercialBillSchema.parse(originals.bill.terms),
    settlement = CommercialSettlementSchema.parse(originals.settlement.terms),
    previous = originals.previous
      ? CommercialAdjustmentSchema.parse(originals.previous.terms)
      : undefined;
  assertCommercialSettlement(settlement, bill, originals.bill.digest);
  if (
    value.domainId !== bill.domainId ||
    value.agreementRevisionId !== bill.request.agreementRevisionId ||
    value.billId !== bill.billId ||
    value.billDigest !== originals.bill.digest ||
    value.settlementId !== settlement.settlementId ||
    value.settlementDigest !== originals.settlement.digest ||
    value.sourceSiteId !== settlement.sourceSiteId ||
    value.targetSiteId !== settlement.targetSiteId ||
    value.unit !== settlement.unit ||
    agreement.domainId !== value.domainId ||
    agreement.agreement.agreementRevisionId !== value.agreementRevisionId ||
    agreement.agreement.sourceSiteId !== value.sourceSiteId ||
    agreement.agreement.targetSiteId !== value.targetSiteId ||
    agreement.agreement.unit !== value.unit ||
    (agreement.consideration === "charity" && value.chargedAmount !== "0") ||
    BigInt(value.chargedAmount) > BigInt(settlement.reservedAmount) ||
    Boolean(value.previous) !== Boolean(previous) ||
    Date.parse(value.issuedAt) < Date.parse(settlement.issuedAt)
  )
    throw new FederationError("POLICY_DENIED");
  if (
    previous &&
    (previous.domainId !== value.domainId ||
      previous.agreementRevisionId !== value.agreementRevisionId ||
      previous.billId !== value.billId ||
      previous.billDigest !== value.billDigest ||
      previous.settlementId !== value.settlementId ||
      previous.settlementDigest !== value.settlementDigest ||
      previous.sourceSiteId !== value.sourceSiteId ||
      previous.targetSiteId !== value.targetSiteId ||
      previous.unit !== value.unit ||
      value.previous?.adjustmentId !== previous.adjustmentId ||
      value.previous.digest !== originals.previous?.digest ||
      Date.parse(value.issuedAt) < Date.parse(previous.issuedAt))
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (value.previousChargedAmount !== (previous?.chargedAmount ?? settlement.chargedAmount))
    throw new FederationError("OPERATION_CONFLICT");
}
