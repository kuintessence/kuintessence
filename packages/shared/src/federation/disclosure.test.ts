import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CommercialDisclosureGrantSchema,
  CommercialDisclosureSchema,
  projectCommercialEvidence,
} from "./disclosure";

function fixture() {
  const sourceSiteId = randomUUID(),
    targetSiteId = randomUUID(),
    recipientSiteId = randomUUID();
  const domainId = randomUUID(),
    agreementRevisionId = randomUUID();
  const digest = `sha256:${"a".repeat(64)}`;
  const now = new Date("2027-01-10T00:00:00Z");
  const amount = "9007199254740993";
  const binding = { domainId, agreementRevisionId, sourceSiteId, targetSiteId };
  const dated = { protocolVersion: 1, issuedAt: "2027-01-03T00:00:00Z", salt: "b".repeat(64) };
  const agreement = {
    protocolVersion: 1,
    kind: "agreement",
    agreementRevisionId,
    sourceSiteId,
    targetSiteId,
    mode: "bilateral_direct",
    budgetDomainId: randomUUID(),
    epoch: randomUUID(),
    unit: "credit.micro",
    budgetLimit: amount,
    maxTaskAmount: amount,
    maxReservations: 10,
    validFrom: "2027-01-01T00:00:00Z",
    validUntil: "2027-02-01T00:00:00Z",
    templates: [
      { originSiteId: sourceSiteId, kind: "script", id: randomUUID(), revision: "1", digest },
    ],
    resourceLimit: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 60 },
    termsDigest: digest,
  };
  const request = {
    protocolVersion: 1,
    kind: "delegation",
    operationId: randomUUID(),
    senderSiteId: sourceSiteId,
    recipientSiteId: targetSiteId,
    agreementRevisionId,
    mode: agreement.mode,
    budgetDomainId: agreement.budgetDomainId,
    epoch: agreement.epoch,
    taskId: randomUUID(),
    attempt: 1,
    issuedAt: "2027-01-02T00:00:00Z",
    expiresAt: "2027-01-02T01:00:00Z",
    template: agreement.templates[0],
    inputManifestDigest: digest,
    environmentLockDigest: digest,
    resources: agreement.resourceLimit,
    maxAmount: amount,
    unit: agreement.unit,
  };
  const usage = {
    protocolVersion: 1,
    kind: "commercial-usage",
    ...binding,
    agreementDigest: digest,
    reportId: randomUUID(),
    taskId: request.taskId,
    attempt: 1,
    salt: dated.salt,
    reportedAt: dated.issuedAt,
    periodStart: request.issuedAt,
    periodEnd: request.expiresAt,
    measurements: [
      {
        metric: "job.elapsed",
        quantityUnit: "job-millisecond",
        quantity: "1000",
        evidenceDigest: digest,
      },
    ],
  };
  const bill = {
    ...dated,
    kind: "commercial-bill",
    domainId,
    billId: randomUUID(),
    agreementDigest: digest,
    priceVersionId: randomUUID(),
    reportId: usage.reportId,
    reportDigest: digest,
    request,
    reservationId: null,
    discount: null,
    calculation: {
      rounding: "ceil-per-line",
      lines: [
        {
          metric: "job.elapsed",
          quantityUnit: "job-millisecond",
          quantity: "1000",
          perQuantity: "1000",
          rateAmount: amount,
          amount,
        },
      ],
      grossAmount: amount,
      capReduction: "0",
      discountAmount: "0",
      dueAmount: amount,
    },
  };
  const settlement = {
    ...dated,
    ...binding,
    kind: "commercial-settlement",
    settlementId: randomUUID(),
    billId: bill.billId,
    billDigest: digest,
    reservationId: null,
    terminal: null,
    unit: agreement.unit,
    reservedAmount: amount,
    chargedAmount: amount,
    releasedAmount: "0",
  };
  const adjustment = {
    ...dated,
    ...binding,
    kind: "commercial-adjustment",
    adjustmentId: randomUUID(),
    billId: bill.billId,
    billDigest: digest,
    settlementId: settlement.settlementId,
    settlementDigest: digest,
    unit: agreement.unit,
    previous: null,
    previousChargedAmount: amount,
    chargedAmount: "0",
    reason: "PRIVATE_ADJUSTMENT_REASON",
    supportingEvidenceDigest: null,
  };
  const payment = {
    ...dated,
    ...binding,
    kind: "commercial-payment",
    receiptId: randomUUID(),
    paymentId: randomUUID(),
    agreementDigest: digest,
    billId: bill.billId,
    billDigest: digest,
    amount,
    unit: agreement.unit,
    occurredAt: request.issuedAt,
    evidenceDigest: digest,
    previous: null,
    reason: "PRIVATE_PAYMENT_REASON",
  };
  const originals = {
    agreement: {
      protocolVersion: 1,
      kind: "commercial-agreement",
      domainId,
      salt: dated.salt,
      createdAt: agreement.validFrom,
      agreement,
      consideration: "paid",
      priceVersionId: bill.priceVersionId,
      prices: [
        { metric: "job.elapsed", quantityUnit: "job-millisecond", perQuantity: "1000", amount },
      ],
      termsText: "PRIVATE_CONTRACT_TERMS",
    },
    usage,
    bill,
    settlement,
    adjustment,
    payment,
  };
  const samples = [
    {
      recordType: "agreement",
      recordId: agreementRevisionId,
      fields: ["consideration"],
      expected: { consideration: "paid" },
    },
    {
      recordType: "usage",
      recordId: usage.reportId,
      fields: ["periodStart"],
      expected: { periodStart: request.issuedAt },
    },
    {
      recordType: "bill",
      recordId: bill.billId,
      fields: ["dueAmount"],
      expected: { dueAmount: amount },
    },
    {
      recordType: "settlement",
      recordId: settlement.settlementId,
      fields: ["chargedAmount"],
      expected: { chargedAmount: amount },
    },
    {
      recordType: "adjustment",
      recordId: adjustment.adjustmentId,
      fields: ["chargedAmount"],
      expected: { chargedAmount: "0" },
    },
    {
      recordType: "payment",
      recordId: payment.receiptId,
      fields: ["amount"],
      expected: { amount },
    },
  ] as const;
  const grants = samples.map(({ expected: _, ...sample }) =>
    CommercialDisclosureGrantSchema.parse({
      ...binding,
      ...sample,
      protocolVersion: 1,
      kind: "commercial-disclosure-grant",
      grantId: randomUUID(),
      caseId: randomUUID(),
      policyId: randomUUID(),
      policyDigest: digest,
      recipientSiteId,
      recordDigest: digest,
      validFrom: dated.issuedAt,
      validUntil: agreement.validUntil,
      salt: "c".repeat(64),
    }),
  );
  const grant = grants.find((v) => v.recordType === "payment");
  if (!grant) throw new Error("Payment grant missing");
  return { originals, samples, grants, grant, recipientSiteId, digest, now, amount };
}

test("six original types disclose exactly selected fields and preserve integer precision", () => {
  const f = fixture();
  for (const grant of f.grants) {
    const disclosure = projectCommercialEvidence(
      grant,
      { payload: f.originals[grant.recordType], digest: f.digest },
      f.recipientSiteId,
      f.now,
    );
    const sample = f.samples.find((v) => v.recordType === grant.recordType);
    if (!sample) throw new Error("Expected projection missing");
    expect(disclosure.evidence.values).toEqual(sample.expected);
    const text = JSON.stringify(disclosure);
    for (const probe of [
      "PRIVATE_CONTRACT_TERMS",
      "PRIVATE_ADJUSTMENT_REASON",
      "PRIVATE_PAYMENT_REASON",
      "prices",
      "measurements",
      "lines",
      "approvalJws",
    ])
      expect(text).not.toContain(probe);
    expect(CommercialDisclosureSchema.parse(disclosure)).toEqual(disclosure);
  }
});

test("bill total does not implicitly authorize rate lines; an explicit line grant does", () => {
  const f = fixture();
  const grant = f.grants.find((v) => v.recordType === "bill");
  if (!grant) throw new Error("Bill grant missing");
  const result = projectCommercialEvidence(
    { ...grant, fields: ["lines"] },
    { payload: f.originals.bill, digest: f.digest },
    f.recipientSiteId,
    f.now,
  );
  expect(result.evidence.values).toEqual({ lines: f.originals.bill.calculation.lines });
  expect(JSON.stringify(result)).not.toContain("dueAmount");
});

test("projection is deterministic, detached and does not modify the authenticated original", () => {
  const f = fixture();
  const grant = f.grants.find((v) => v.recordType === "agreement");
  if (!grant) throw new Error("Agreement grant missing");
  const input = { ...grant, fields: ["prices"] as ["prices"] };
  const verified = { payload: f.originals.agreement, digest: f.digest };
  const a = projectCommercialEvidence(input, verified, f.recipientSiteId, f.now);
  const b = projectCommercialEvidence(
    input,
    verified,
    f.recipientSiteId,
    new Date(f.now.getTime() + 1),
  );
  expect(a).toEqual(b);
  if (a.evidence.recordType !== "agreement" || !a.evidence.values.prices?.[0])
    throw new Error("Missing prices");
  a.evidence.values.prices[0].amount = "0";
  expect(f.originals.agreement.prices[0]?.amount).toBe(f.amount);
  expect(a).not.toEqual(b);
});

test("different recipient, original reference, contract or institution is rejected", () => {
  const f = fixture();
  const verified = { payload: f.originals.payment, digest: f.digest };
  for (const key of [
    "domainId",
    "agreementRevisionId",
    "sourceSiteId",
    "targetSiteId",
    "recordId",
  ] as const)
    expect(() =>
      projectCommercialEvidence(
        { ...f.grant, [key]: randomUUID() },
        verified,
        f.recipientSiteId,
        f.now,
      ),
    ).toThrow("POLICY_DENIED");
  expect(() => projectCommercialEvidence(f.grant, verified, randomUUID(), f.now)).toThrow(
    "POLICY_DENIED",
  );
  expect(() =>
    projectCommercialEvidence(
      f.grant,
      { ...verified, digest: `sha256:${"f".repeat(64)}` },
      f.recipientSiteId,
      f.now,
    ),
  ).toThrow("POLICY_DENIED");
  expect(() =>
    projectCommercialEvidence(
      f.grant,
      { ...verified, payload: f.originals.adjustment },
      f.recipientSiteId,
      f.now,
    ),
  ).toThrow("POLICY_DENIED");
});

test("expired, future or invalid time and a future original cannot be disclosed", () => {
  const f = fixture();
  for (const now of [
    new Date(f.grant.validUntil),
    new Date(Date.parse(f.grant.validFrom) - 1),
    new Date("invalid"),
  ])
    expect(() =>
      projectCommercialEvidence(
        f.grant,
        { payload: f.originals.payment, digest: f.digest },
        f.recipientSiteId,
        now,
      ),
    ).toThrow("POLICY_DENIED");
  expect(() =>
    projectCommercialEvidence(
      f.grant,
      { payload: { ...f.originals.payment, issuedAt: "2027-01-11T00:00:00Z" }, digest: f.digest },
      f.recipientSiteId,
      f.now,
    ),
  ).toThrow("POLICY_DENIED");
});

test("invalid grants reject duplicate, empty, cross-type and arbitrary field names", () => {
  const f = fixture();
  for (const fields of [
    [],
    ["amount", "amount"],
    ["prices"],
    ["*"],
    ["__proto__"],
    ["approvalJws"],
    ["$.amount"],
  ])
    expect(CommercialDisclosureGrantSchema.safeParse({ ...f.grant, fields }).success).toBe(false);
  for (const changed of [
    { recipientSiteId: f.grant.sourceSiteId },
    { targetSiteId: f.grant.sourceSiteId },
    { validUntil: f.grant.validFrom },
    { approvalJws: "PRIVATE_ORIGINAL_JWS" },
  ])
    expect(CommercialDisclosureGrantSchema.safeParse({ ...f.grant, ...changed }).success).toBe(
      false,
    );
});

test("receiving schema rejects extra or missing values, whole signatures and type substitution", () => {
  const f = fixture();
  const value = projectCommercialEvidence(
    f.grant,
    { payload: f.originals.payment, digest: f.digest },
    f.recipientSiteId,
    f.now,
  );
  for (const values of [
    {},
    { amount: undefined },
    { amount: f.amount, reason: "PRIVATE_PAYMENT_REASON" },
    { amount: Number(f.amount) },
    { amount: f.amount, approvalJws: "PRIVATE_ORIGINAL_JWS" },
  ])
    expect(
      CommercialDisclosureSchema.safeParse({ ...value, evidence: { ...value.evidence, values } })
        .success,
    ).toBe(false);
  expect(
    CommercialDisclosureSchema.safeParse({ ...value, approvalJws: "PRIVATE_ORIGINAL_JWS" }).success,
  ).toBe(false);
  expect(
    CommercialDisclosureSchema.safeParse({
      ...value,
      evidence: { recordType: "settlement", values: { chargedAmount: f.amount } },
    }).success,
  ).toBe(false);
});

test("nested groups reject undeclared data and parser errors do not expose private input", () => {
  const f = fixture();
  const grant = f.grants.find((v) => v.recordType === "bill");
  if (!grant) throw new Error("Bill grant missing");
  const value = projectCommercialEvidence(
    { ...grant, fields: ["lines"] },
    { payload: f.originals.bill, digest: f.digest },
    f.recipientSiteId,
    f.now,
  );
  expect(
    CommercialDisclosureSchema.safeParse({
      ...value,
      evidence: {
        recordType: "bill",
        values: {
          lines: [
            { ...f.originals.bill.calculation.lines[0], originalJws: "PRIVATE_ORIGINAL_JWS" },
          ],
        },
      },
    }).success,
  ).toBe(false);
  expect(() =>
    projectCommercialEvidence(
      f.grant,
      {
        payload: { ...f.originals.payment, reason: { secret: "PRIVATE_ERROR_PROBE" } },
        digest: f.digest,
      },
      f.recipientSiteId,
      f.now,
    ),
  ).toThrow(/^POLICY_DENIED$/);
});
