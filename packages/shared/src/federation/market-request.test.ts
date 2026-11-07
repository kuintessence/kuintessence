import { expect, test } from "bun:test";
import { MarketRequestReceiptSchema, MarketRequestSchema } from "./market-request";
import { FederationKeyInput } from "./trust";

const id = () => crypto.randomUUID();
const hash = `sha256:${"a".repeat(64)}`;
function fixture() {
  const source = id(),
    operation = id(),
    demand = id();
  const resources = { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 60 };
  const issuedAt = "2026-11-08T00:00:00Z",
    expiresAt = "2026-11-08T00:30:00Z";
  return MarketRequestSchema.parse({
    protocolVersion: 1,
    kind: "market-request",
    demand: {
      protocolVersion: 1,
      demandId: demand,
      sourceSiteId: source,
      createdAt: issuedAt,
      expiresAt,
      title: "Task",
      description: "",
      platform: "linux",
      architecture: "x86_64",
      resources,
    },
    proposal: {
      protocolVersion: 1,
      kind: "commercial-reservation",
      domainId: id(),
      reservationId: operation,
      demandId: demand,
      claimVersion: 2,
      agreementDigest: hash,
      salt: "b".repeat(64),
      request: {
        protocolVersion: 1,
        kind: "delegation",
        operationId: operation,
        senderSiteId: source,
        recipientSiteId: id(),
        agreementRevisionId: id(),
        mode: "ledger_coordinated",
        budgetDomainId: id(),
        epoch: id(),
        taskId: id(),
        attempt: 1,
        issuedAt,
        expiresAt,
        template: { originSiteId: source, kind: "workflow", id: id(), revision: "1", digest: hash },
        inputManifestDigest: hash,
        environmentLockDigest: hash,
        resources,
        maxAmount: "9007199254740993",
        unit: "credit",
      },
    },
  });
}
test("market request binds public demand to the initial private reservation and exact operation", () => {
  const valid = fixture();
  expect(valid.proposal.request.maxAmount).toBe("9007199254740993");
  for (const demand of [
    { ...valid.demand, demandId: id() },
    { ...valid.demand, sourceSiteId: id() },
    { ...valid.demand, expiresAt: "2026-11-08T00:31:00Z" },
    { ...valid.demand, resources: { ...valid.demand.resources, gpus: 1 } },
    { ...valid.demand, maxAmount: "1" },
    { ...valid.demand, contract: "private" },
  ])
    expect(MarketRequestSchema.safeParse({ ...valid, demand }).success).toBe(false);
  for (const proposal of [
    { ...valid.proposal, reservationId: id() },
    { ...valid.proposal, claimVersion: 3 },
    { ...valid.proposal, request: { ...valid.proposal.request, mode: "direct" } },
    { ...valid.proposal, request: { ...valid.proposal.request, maxAmount: 9007199254740992 } },
  ])
    expect(MarketRequestSchema.safeParse({ ...valid, proposal }).success).toBe(false);
});
test("market receipt records reception or claim without carrying private terms or approving execution", () => {
  const receipt = {
    protocolVersion: 1,
    kind: "market-request-receipt",
    senderSiteId: id(),
    recipientSiteId: id(),
    reservationId: id(),
    requestDigest: hash,
    state: "received",
    observedAt: "2026-11-08T00:01:00Z",
  };
  expect(MarketRequestReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(MarketRequestReceiptSchema.safeParse({ ...receipt, state: "claimed" }).success).toBe(true);
  for (const patch of [
    { state: "approved" },
    { amount: "100" },
    { approved: true },
    { requestDigest: "unknown" },
    { recipientSiteId: receipt.senderSiteId },
  ])
    expect(MarketRequestReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(false);
  const purposes = FederationKeyInput.shape.allowedKinds.element.options;
  expect(purposes).toContain("market-request");
  expect(purposes).toContain("market-request-receipt");
  expect(purposes).toHaveLength(36);
  expect(FederationKeyInput.shape.allowedKinds.safeParse(purposes).success).toBe(true);
});
