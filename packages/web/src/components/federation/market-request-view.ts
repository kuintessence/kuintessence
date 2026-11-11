import type {
  CommercialAgreementApproval,
  ReservationPolicy,
} from "@kuintessence/shared/federation/commercial";
import {
  type MarketRequest,
  MarketRequestSchema,
} from "@kuintessence/shared/federation/market-request";
import { z } from "zod";

export const MarketRequestProgressSchema = z.object({
  reservationId: z.uuid(),
  demandId: z.uuid(),
  agreementRevisionId: z.uuid(),
  policyId: z.uuid(),
  direction: z.enum(["inbound", "outbound"]),
  state: z.enum(["pending", "complete", "needs_review", "closed"]),
  lastError: z.string().nullable(),
  marketSubmissionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
});
export const MarketRequestDetailSchema = MarketRequestProgressSchema.extend({
  request: MarketRequestSchema,
});
export type MarketRequestProgress = z.infer<typeof MarketRequestProgressSchema>;
export function checkRequestScope(
  row: MarketRequestProgress,
  approval: CommercialAgreementApproval,
) {
  if (row.agreementRevisionId !== approval.revisionId)
    throw new Error("Market request contract mismatch");
  return row;
}
export function policyUsable(
  policy: ReservationPolicy,
  approval: CommercialAgreementApproval,
  now = Date.now(),
) {
  return (
    policy.localOrgId === approval.localOrgId &&
    policy.localSiteId === approval.localSiteId &&
    policy.agreementRevisionId === approval.revisionId &&
    policy.agreementDigest === approval.digest &&
    policy.allowMarketPublish &&
    !policy.revokedAt &&
    Date.parse(policy.validFrom) <= now &&
    Date.parse(policy.validUntil) > now &&
    policy.authorizedTasks < policy.maxTasks &&
    (policy.marketAuthorizedTasks ?? 0) < policy.maxTasks
  );
}
export function buildMarketRequest(
  approval: CommercialAgreementApproval,
  policy: ReservationPolicy,
  form: FormData,
): MarketRequest {
  const terms = approval.terms.agreement,
    now = Date.now();
  const expires = new Date(String(form.get("expiresAt"))).getTime();
  const executionExpires = expires + Number(form.get("wallTimeSec")) * 1000;
  const id = crypto.randomUUID(),
    demandId = crypto.randomUUID();
  const resources = Object.fromEntries(
    ["cpus", "memoryMb", "gpus", "wallTimeSec"].map((name) => [name, Number(form.get(name))]),
  );
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  const request = MarketRequestSchema.parse({
    protocolVersion: 1,
    kind: "market-request",
    demand: {
      protocolVersion: 1,
      demandId,
      sourceSiteId: approval.localSiteId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      title: form.get("title"),
      description: form.get("description"),
      platform: form.get("platform"),
      architecture: form.get("architecture"),
      resources,
    },
    proposal: {
      protocolVersion: 1,
      kind: "commercial-reservation",
      domainId: approval.terms.domainId,
      reservationId: id,
      demandId,
      claimVersion: 2,
      agreementDigest: approval.digest,
      salt,
      request: {
        protocolVersion: 1,
        kind: "delegation",
        operationId: id,
        taskId: crypto.randomUUID(),
        attempt: 1,
        senderSiteId: approval.localSiteId,
        recipientSiteId: terms.targetSiteId,
        agreementRevisionId: approval.revisionId,
        mode: terms.mode,
        budgetDomainId: terms.budgetDomainId,
        epoch: terms.epoch,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(expires).toISOString(),
        executionExpiresAt: new Date(executionExpires).toISOString(),
        template: terms.templates[Number(form.get("template"))],
        inputManifestDigest: form.get("inputs"),
        environmentLockDigest: form.get("environment-lock"),
        resources,
        maxAmount: form.get("maxAmount"),
        unit: terms.unit,
      },
    },
  });
  const amount = BigInt(request.proposal.request.maxAmount);
  if (
    !approval.counterpartyJws ||
    terms.mode !== "ledger_coordinated" ||
    terms.sourceSiteId !== approval.localSiteId ||
    Date.parse(terms.validFrom) > now ||
    Date.parse(terms.validUntil) < executionExpires ||
    !policyUsable(policy, approval, now) ||
    Date.parse(policy.validUntil) < executionExpires ||
    amount > BigInt(policy.maxTaskAmount) ||
    amount > BigInt(terms.maxTaskAmount) ||
    amount + BigInt(policy.marketAuthorizedAmount ?? "0") > BigInt(policy.maxTotalAmount) ||
    amount + BigInt(policy.authorizedAmount) > BigInt(policy.maxTotalAmount) ||
    (approval.terms.consideration === "charity" && amount !== 0n) ||
    Object.entries(request.demand.resources).some(
      ([name, value]) => value > terms.resourceLimit[name as keyof typeof terms.resourceLimit],
    )
  )
    throw new Error("Market request outside authorized limits");
  return request;
}
