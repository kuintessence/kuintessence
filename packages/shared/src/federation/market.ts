import { z } from "zod";
import { FederationResourcesSchema } from "./index";
import { FabricEvidenceAdvanceResultSchema, FabricProposalCheckpointSchema } from "./ledger";
import { FederationDigestSchema } from "./references";

const Id = z.uuid();
const Version = z.number().int().min(1).max(2147483647);
/** Explicitly public fields only. Prices, usage, contracts and real user identities belong in PDC/off chain. */
export const MarketDemandSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    demandId: Id,
    sourceSiteId: Id,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(4096),
    platform: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
    architecture: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
    resources: FederationResourcesSchema,
  })
  .refine(
    (value) => Date.parse(value.createdAt) < Date.parse(value.expiresAt),
    "Invalid demand interval",
  );
export type MarketDemand = z.infer<typeof MarketDemandSchema>;
/** Explicit public disclosure for one workflow invocation; target is taken from its immutable lock. */
export const FederationWorkflowMarketSchema = z.strictObject({
  policyId: z.uuid(),
  title: MarketDemandSchema.shape.title,
  description: MarketDemandSchema.shape.description,
});
export type FederationWorkflowMarket = z.infer<typeof FederationWorkflowMarketSchema>;

export const MarketClaimSchema = z.strictObject({
  demandId: Id,
  claimId: Id,
  providerSiteId: Id,
  commercialDomainId: Id.optional(),
  expectedVersion: Version,
  expiresAt: z.iso.datetime(),
});
export type MarketClaim = z.infer<typeof MarketClaimSchema>;
export const MarketCancelOpenSchema = z.strictObject({
  demandId: Id,
  cancellationId: Id,
  expectedVersion: Version,
});
/** Public preimage of a private gate hash; contains no amount, price or contract body. */
export const MarketExecutionGateSchema = z
  .strictObject({
    domainId: Id,
    reservationId: Id,
    demandId: Id,
    claimVersion: Version,
    version: Version,
    state: z.enum(["READY", "REVOKED", "TERMINAL"]),
    reservationDigest: FederationDigestSchema,
    expiresAt: z.iso.datetime(),
    terminal: z
      .strictObject({
        terminalId: Id,
        activationId: Id,
        digest: FederationDigestSchema,
      })
      .optional(),
  })
  .refine(
    (value) => (value.state === "TERMINAL") === (value.terminal !== undefined),
    "Terminal gate requires its immutable acknowledgment",
  );
export const MarketActivationSchema = z.strictObject({
  demandId: Id,
  activationId: Id,
  expectedVersion: Version,
  gate: MarketExecutionGateSchema,
});
export const MARKET_EXECUTION_AUTHORIZATION_MS = 300_000;
/** A VALID transaction confirms current chain state; consumers must still enforce absolute expiry. */
export const MarketExecutionAuthorizationSchema = z
  .strictObject({
    demandId: Id,
    authorizationId: Id,
    issuerSiteId: Id,
    activationId: Id,
    gate: MarketExecutionGateSchema,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine((value) => {
    const duration = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
    return duration > 0 && duration <= MARKET_EXECUTION_AUTHORIZATION_MS;
  }, "Invalid execution authorization interval");
export type MarketExecutionAuthorization = z.infer<typeof MarketExecutionAuthorizationSchema>;
/** A participant's stop intent is public; it is not evidence of stopped compute or settled money. */
export const MarketExecutionStopSchema = z.strictObject({
  demandId: Id,
  stopId: Id,
  issuerSiteId: Id,
  activationId: Id,
  expectedVersion: Version,
});
export type MarketExecutionStop = z.infer<typeof MarketExecutionStopSchema>;
export const MarketClosureSchema = z
  .strictObject({
    demandId: Id,
    closureId: Id,
    expectedVersion: Version,
    gate: MarketExecutionGateSchema,
  })
  .refine(
    (value) =>
      value.demandId === value.gate.demandId &&
      ((value.gate.state === "TERMINAL" && value.closureId === value.gate.terminal?.terminalId) ||
        (value.gate.state === "REVOKED" &&
          value.gate.version === 2 &&
          value.expectedVersion === value.gate.claimVersion)),
    "Closure must bind a terminal or revoked gate",
  );
export type MarketClosure = z.infer<typeof MarketClosureSchema>;
export const MarketDemandStateSchema = z
  .strictObject({
    demand: MarketDemandSchema,
    digest: FederationDigestSchema,
    version: Version,
    status: z.enum(["OPEN", "CLAIMED", "CANCELLED", "ACTIVE", "STOPPING", "CLOSED"]),
    claim: MarketClaimSchema.nullable(),
    cancellation: MarketCancelOpenSchema.nullable(),
    activation: MarketActivationSchema.nullable().default(null),
    stopRequest: MarketExecutionStopSchema.optional(),
    closure: MarketClosureSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const stop = value.stopRequest;
    if (value.status === "STOPPING" && !stop)
      ctx.addIssue({ code: "custom", message: "Missing execution stop" });
    if (
      stop &&
      (!["STOPPING", "CLOSED"].includes(value.status) ||
        !value.activation ||
        !value.claim ||
        stop.demandId !== value.demand.demandId ||
        stop.activationId !== value.activation.activationId ||
        stop.expectedVersion !== value.activation.expectedVersion + 1 ||
        value.version !== stop.expectedVersion + (value.status === "CLOSED" ? 2 : 1) ||
        ![value.demand.sourceSiteId, value.claim.providerSiteId].includes(stop.issuerSiteId))
    )
      ctx.addIssue({ code: "custom", message: "Invalid execution stop binding" });
    const closure = value.closure;
    if (value.status !== "CLOSED") {
      if (closure) ctx.addIssue({ code: "custom", message: "Unexpected execution closure" });
      return;
    }
    if (closure?.gate.state === "REVOKED") {
      if (
        value.activation ||
        stop ||
        value.cancellation ||
        !value.claim ||
        closure.demandId !== value.demand.demandId ||
        closure.gate.reservationId !== value.claim.claimId ||
        closure.gate.domainId !== value.claim.commercialDomainId ||
        closure.expectedVersion !== value.claim.expectedVersion + 1 ||
        value.version !== closure.expectedVersion + 1
      )
        ctx.addIssue({ code: "custom", message: "Invalid pre-execution closure binding" });
      return;
    }
    if (
      !closure ||
      !value.activation ||
      !value.claim ||
      closure.demandId !== value.demand.demandId ||
      closure.gate.terminal?.activationId !== value.activation.activationId ||
      closure.expectedVersion !== value.activation.expectedVersion + 1 ||
      closure.gate.reservationId !== value.claim.claimId ||
      closure.gate.domainId !== value.claim.commercialDomainId ||
      closure.gate.claimVersion !== value.activation.expectedVersion ||
      closure.gate.reservationDigest !== value.activation.gate.reservationDigest ||
      closure.gate.version !== value.activation.gate.version + 1 ||
      closure.gate.expiresAt !== value.activation.gate.expiresAt ||
      value.version !== closure.expectedVersion + (stop ? 2 : 1)
    )
      ctx.addIssue({ code: "custom", message: "Invalid execution closure binding" });
  });
export const MarketReceiptSchema = z.strictObject({
  recordId: Id,
  digest: FederationDigestSchema,
});
export const FabricMarketTrustSchema = z
  .strictObject({
    version: z.literal(1),
    generationId: Id,
    organizations: z
      .array(
        z.strictObject({
          siteId: Id,
          mspId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
        }),
      )
      .min(2)
      .max(50),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.organizations.map((o) => o.siteId)).size !== value.organizations.length ||
      new Set(value.organizations.map((o) => o.mspId)).size !== value.organizations.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate market organization" });
  });
export type FabricMarketTrust = z.infer<typeof FabricMarketTrustSchema>;

export const MarketProposalInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("publish-demand"), demand: MarketDemandSchema }),
  z.strictObject({ operation: z.literal("claim-demand"), claim: MarketClaimSchema }),
  z.strictObject({
    operation: z.literal("cancel-open-demand"),
    cancellation: MarketCancelOpenSchema,
  }),
]);
export type MarketProposalInput = z.infer<typeof MarketProposalInputSchema>;
/** Internal transport includes privileged operations that generic market HTTP intents cannot submit. */
export const MarketAdapterProposalInputSchema = z.discriminatedUnion("operation", [
  ...MarketProposalInputSchema.options,
  z.strictObject({ operation: z.literal("activate-demand"), activation: MarketActivationSchema }),
  z.strictObject({
    operation: z.literal("authorize-execution"),
    authorization: MarketExecutionAuthorizationSchema,
  }),
  z.strictObject({
    operation: z.literal("request-execution-stop"),
    stop: MarketExecutionStopSchema,
  }),
  z.strictObject({ operation: z.literal("close-demand"), closure: MarketClosureSchema }),
]);
export type MarketAdapterProposalInput = z.infer<typeof MarketAdapterProposalInputSchema>;

export const FabricMarketAdvanceResultSchema = z.discriminatedUnion("state", [
  FabricProposalCheckpointSchema.extend({ state: z.literal("prepared") }),
  FabricProposalCheckpointSchema.extend({ state: z.literal("pending") }),
  z.strictObject({
    state: z.literal("committed"),
    transactionId: z.string().regex(/^[a-f0-9]{64}$/),
    blockNumber: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  }),
  FabricEvidenceAdvanceResultSchema.options[3],
]);
export type MarketAdvanceResult = z.infer<typeof FabricMarketAdvanceResultSchema>;

export const MarketPageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(50),
  bookmark: z.string().max(4096),
});
export const MarketQueryInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list-demands"), ...MarketPageRequestSchema.shape }),
  z.strictObject({ operation: z.literal("get-demand"), demandId: Id }),
]);
export type MarketQueryInput = z.infer<typeof MarketQueryInputSchema>;
export const MarketPageSchema = z.strictObject({
  demands: z.array(MarketDemandStateSchema).max(50),
  bookmark: z.string().max(4096),
});
export const MarketQueryResultSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("list-demands"), ...MarketPageSchema.shape }),
  z.strictObject({
    operation: z.literal("get-demand"),
    demand: MarketDemandStateSchema.nullable(),
  }),
]);
export type MarketQueryResult = z.infer<typeof MarketQueryResultSchema>;
