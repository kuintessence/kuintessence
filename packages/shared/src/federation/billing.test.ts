import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { assertCommercialBill, assertCommercialDiscount, calculateCommercialBill } from "./billing";
import {
  CommercialAgreementSchema,
  CommercialBillSchema,
  CommercialDiscountSchema,
  CommercialUsageSchema,
} from "./commercial";
import { FederationDelegationSchema } from "./index";

function fixture() {
  const source = randomUUID(),
    target = randomUUID();
  const digest = `sha256:${"a".repeat(64)}`;
  const terms = CommercialAgreementSchema.parse({
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: randomUUID(),
    salt: "b".repeat(64),
    createdAt: "2027-01-01T00:00:00Z",
    agreement: {
      protocolVersion: 1,
      kind: "agreement",
      agreementRevisionId: randomUUID(),
      sourceSiteId: source,
      targetSiteId: target,
      mode: "bilateral_direct",
      budgetDomainId: randomUUID(),
      epoch: randomUUID(),
      unit: "credit.micro",
      budgetLimit: "99999999999999999999999999999999999999",
      maxTaskAmount: "9007199254740993",
      maxReservations: 10,
      validFrom: "2027-01-01T00:00:00Z",
      validUntil: "2027-02-01T00:00:00Z",
      templates: [
        { originSiteId: source, kind: "script", id: randomUUID(), revision: "1", digest },
      ],
      resourceLimit: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 60 },
      termsDigest: digest,
    },
    consideration: "paid",
    priceVersionId: randomUUID(),
    termsText: "agreed rates",
    prices: [
      { metric: "cpu.time", quantityUnit: "cpu-millisecond", perQuantity: "3", amount: "2" },
    ],
  });
  const request = FederationDelegationSchema.parse({
    protocolVersion: 1,
    kind: "delegation",
    operationId: randomUUID(),
    senderSiteId: source,
    recipientSiteId: target,
    agreementRevisionId: terms.agreement.agreementRevisionId,
    mode: terms.agreement.mode,
    budgetDomainId: terms.agreement.budgetDomainId,
    epoch: terms.agreement.epoch,
    taskId: randomUUID(),
    attempt: 1,
    issuedAt: "2027-01-02T00:00:00Z",
    expiresAt: "2027-01-02T01:00:00Z",
    template: terms.agreement.templates[0],
    inputManifestDigest: digest,
    environmentLockDigest: digest,
    resources: terms.agreement.resourceLimit,
    maxAmount: "8",
    unit: terms.agreement.unit,
  });
  const usage = CommercialUsageSchema.parse({
    protocolVersion: 1,
    kind: "commercial-usage",
    reportId: randomUUID(),
    domainId: terms.domainId,
    agreementRevisionId: request.agreementRevisionId,
    agreementDigest: digest,
    sourceSiteId: source,
    targetSiteId: target,
    taskId: request.taskId,
    attempt: 1,
    salt: "c".repeat(64),
    reportedAt: "2027-01-03T00:00:00Z",
    periodStart: request.issuedAt,
    periodEnd: request.expiresAt,
    measurements: [
      {
        metric: "cpu.time",
        quantityUnit: "cpu-millisecond",
        quantity: "13",
        evidenceDigest: digest,
      },
    ],
  });
  const bill = CommercialBillSchema.parse({
    protocolVersion: 1,
    kind: "commercial-bill",
    billId: randomUUID(),
    domainId: terms.domainId,
    agreementDigest: digest,
    priceVersionId: terms.priceVersionId,
    reportId: usage.reportId,
    reportDigest: digest,
    request,
    reservationId: null,
    discount: null,
    calculation: calculateCommercialBill(terms, request, usage),
    issuedAt: "2027-03-01T00:00:00Z",
    salt: "d".repeat(64),
  });
  const discount = CommercialDiscountSchema.parse({
    protocolVersion: 1,
    kind: "commercial-discount",
    discountId: randomUUID(),
    billId: bill.billId,
    domainId: terms.domainId,
    agreementRevisionId: request.agreementRevisionId,
    agreementDigest: digest,
    reportId: usage.reportId,
    reportDigest: digest,
    taskId: request.taskId,
    attempt: 1,
    sourceSiteId: source,
    targetSiteId: target,
    unit: request.unit,
    amount: "3",
    reason: "agreed concession",
    issuedAt: bill.issuedAt,
    salt: "e".repeat(64),
  });
  const measurement = usage.measurements[0],
    price = terms.prices[0];
  if (!measurement || !price) throw new Error("Missing fixture meter");
  return { terms, request, usage, bill, discount, digest, measurement, price };
}

test("integer arithmetic applies explicit per-line rounding, then cap, then a separate discount", () => {
  const f = fixture();
  expect(calculateCommercialBill(f.terms, f.request, f.usage, "3")).toMatchObject({
    rounding: "ceil-per-line",
    lines: [{ amount: "9" }],
    grossAmount: "9",
    capReduction: "1",
    discountAmount: "3",
    dueAmount: "5",
  });
  expect(f.usage.measurements[0]?.quantity).toBe("13");
  expect(f.terms.prices[0]?.amount).toBe("2");
});

test("large integers remain exact and explicit zero is valid but missing meters are not zero", () => {
  const f = fixture();
  f.request.maxAmount = "9007199254740993";
  f.terms.prices = [
    { metric: "cpu.time", quantityUnit: "cpu-millisecond", perQuantity: "1", amount: "1" },
  ];
  f.usage.measurements[0] = { ...f.measurement, quantity: "9007199254740993" };
  expect(calculateCommercialBill(f.terms, f.request, f.usage).dueAmount).toBe("9007199254740993");
  f.usage.measurements[0].quantity = "0";
  expect(calculateCommercialBill(f.terms, f.request, f.usage).dueAmount).toBe("0");
  f.terms.prices.push({
    metric: "job.elapsed",
    quantityUnit: "job-millisecond",
    perQuantity: "1",
    amount: "1",
  });
  expect(() => calculateCommercialBill(f.terms, f.request, f.usage)).toThrow("POLICY_DENIED");
});

test("neither a task cap nor a discount hides a 38 digit gross amount overflow", () => {
  const f = fixture();
  f.terms.prices[0] = { ...f.price, amount: "9".repeat(38), perQuantity: "1" };
  expect(() => calculateCommercialBill(f.terms, f.request, f.usage)).toThrow();
  f.terms.prices[0].amount = "2";
  expect(() => calculateCommercialBill(f.terms, f.request, f.usage, "9")).toThrow("POLICY_DENIED");
});

test("task, domain, epoch, unit, period and meter mismatches are denied", () => {
  const f = fixture();
  for (const patch of [
    { budgetDomainId: randomUUID() },
    { epoch: randomUUID() },
    { taskId: randomUUID() },
    { attempt: 2 },
    { mode: "ledger_coordinated" as const },
    { unit: "usd.cent" },
  ])
    expect(() => calculateCommercialBill(f.terms, { ...f.request, ...patch }, f.usage)).toThrow(
      "POLICY_DENIED",
    );
  for (const patch of [
    { domainId: randomUUID() },
    { periodStart: "2027-01-01T23:59:59Z" },
    { measurements: [{ ...f.measurement, quantityUnit: "cpu-second" }] },
    { measurements: [{ ...f.measurement, metric: "job.elapsed" }] },
  ])
    expect(() => calculateCommercialBill(f.terms, f.request, { ...f.usage, ...patch })).toThrow(
      "POLICY_DENIED",
    );
});

test("charity remains zero and cannot create credits or apply a monetary discount", () => {
  const f = fixture();
  f.terms.consideration = "charity";
  f.price.amount = "0";
  expect(calculateCommercialBill(f.terms, f.request, f.usage).dueAmount).toBe("0");
  expect(() => assertCommercialDiscount(f.discount, f.terms, f.digest, f.usage, f.digest)).toThrow(
    "POLICY_DENIED",
  );
});

test("expired execution authority permits a historical bill and does not grant new execution", () => {
  const f = fixture();
  expect(() => assertCommercialBill(f.bill, f.terms, f.digest, f.usage, f.digest)).not.toThrow();
  expect(f.bill.issuedAt > f.terms.agreement.validUntil).toBe(true);
  expect(f.bill.request.expiresAt).toBe("2027-01-02T01:00:00Z");
});

test("bill verifies original digests and recomputes every claimed amount", () => {
  const f = fixture();
  for (const patch of [
    { agreementDigest: `sha256:${"0".repeat(64)}` },
    { priceVersionId: randomUUID() },
    { reportId: randomUUID() },
    { reportDigest: `sha256:${"0".repeat(64)}` },
    { issuedAt: "2027-01-02T00:00:00Z" },
  ])
    expect(() =>
      assertCommercialBill({ ...f.bill, ...patch }, f.terms, f.digest, f.usage, f.digest),
    ).toThrow("POLICY_DENIED");
  for (const field of ["grossAmount", "capReduction", "discountAmount", "dueAmount"] as const)
    expect(() =>
      assertCommercialBill(
        {
          ...f.bill,
          calculation: {
            ...f.bill.calculation,
            [field]: (BigInt(f.bill.calculation[field]) + 1n).toString(),
          },
        },
        f.terms,
        f.digest,
        f.usage,
        f.digest,
      ),
    ).toThrow("OPERATION_CONFLICT");
  expect(
    CommercialBillSchema.safeParse({
      ...f.bill,
      calculation: { ...f.bill.calculation, rounding: "automatic" },
    }).success,
  ).toBe(false);
});

test("discount binds one bill, exact usage revision, institution, currency and signed timestamp", () => {
  const f = fixture();
  const bill = {
    ...f.bill,
    discount: { discountId: f.discount.discountId, digest: f.digest },
    calculation: calculateCommercialBill(f.terms, f.request, f.usage, f.discount.amount),
  };
  expect(() =>
    assertCommercialBill(bill, f.terms, f.digest, f.usage, f.digest, {
      terms: f.discount,
      digest: f.digest,
    }),
  ).not.toThrow();
  expect(() => assertCommercialBill(bill, f.terms, f.digest, f.usage, f.digest)).toThrow(
    "POLICY_DENIED",
  );
  for (const patch of [
    { billId: randomUUID() },
    { reportId: randomUUID() },
    { reportDigest: `sha256:${"0".repeat(64)}` },
    { targetSiteId: randomUUID() },
    { taskId: randomUUID() },
    { unit: "usd.cent" },
    { issuedAt: "2027-03-02T00:00:00Z" },
  ])
    expect(() =>
      assertCommercialBill(bill, f.terms, f.digest, f.usage, f.digest, {
        terms: { ...f.discount, ...patch },
        digest: f.digest,
      }),
    ).toThrow("POLICY_DENIED");
});
