import {
  FederationAmountSchema,
  type FederationExecutionTarget,
  FederationExecutionTargetSchema,
  FederationResourcesSchema,
} from "./execution-target";

export {
  FederationAmountSchema,
  type FederationExecutionTarget,
  FederationExecutionTargetSchema,
  FederationResourcesSchema,
} from "./execution-target";

import { FederationError } from "./errors";

export { FederationError } from "./errors";

import { z } from "zod";
import { FederationInputPolicySchema } from "./input-files";
import {
  type FederationAssetRef,
  FederationAssetRefSchema,
  FederationDigestSchema,
} from "./references";
import { FederationResultPolicySchema } from "./results";

export {
  type FederationAssetRef,
  FederationAssetRefSchema,
  FederationDigestSchema,
} from "./references";

export const FederationModeSchema = z.enum([
  "bilateral_direct",
  "bilateral_attested",
  "ledger_coordinated",
]);
export type FederationMode = z.infer<typeof FederationModeSchema>;

const Id = z.uuid();
const Time = z.iso.datetime();
const Unit = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/);

export const FederationAttestationLimitsSchema = z.strictObject({
  maxOutstandingTasks: z.number().int().min(1).max(100_000),
  maxOutstandingAmount: FederationAmountSchema,
  maxOutstandingAgeSec: z.number().int().min(1).max(31_536_000),
});

export const FederationAgreementSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    kind: z.literal("agreement"),
    agreementRevisionId: Id,
    sourceSiteId: Id,
    targetSiteId: Id,
    mode: FederationModeSchema,
    budgetDomainId: Id,
    epoch: Id,
    unit: Unit,
    budgetLimit: FederationAmountSchema,
    maxTaskAmount: FederationAmountSchema,
    maxReservations: z.number().int().min(1).max(100_000),
    attestationLimits: FederationAttestationLimitsSchema.optional(),
    validFrom: Time,
    validUntil: Time,
    templates: z.array(FederationAssetRefSchema).min(1).max(100),
    resourceLimit: FederationResourcesSchema,
    executionTargets: z.array(FederationExecutionTargetSchema).min(1).max(128).optional(),
    resultPolicy: FederationResultPolicySchema.optional(),
    inputPolicy: FederationInputPolicySchema.optional(),
    termsDigest: FederationDigestSchema,
  })
  .superRefine((value, ctx) => {
    if (value.attestationLimits && value.mode !== "bilateral_attested")
      ctx.addIssue({ code: "custom", message: "Attestation limits require attested cooperation" });
    if (value.sourceSiteId === value.targetSiteId)
      ctx.addIssue({ code: "custom", message: "Cooperation requires different sites" });
    if (Date.parse(value.validUntil) <= Date.parse(value.validFrom))
      ctx.addIssue({ code: "custom", message: "Agreement interval must be positive" });
    if (BigInt(value.maxTaskAmount) > BigInt(value.budgetLimit))
      ctx.addIssue({ code: "custom", message: "Task limit exceeds budget" });
    if (
      value.resultPolicy &&
      Date.parse(value.resultPolicy.availableUntil) <= Date.parse(value.validFrom)
    )
      ctx.addIssue({
        code: "custom",
        message: "Result release deadline must follow agreement start",
      });
    const targets = value.executionTargets ?? [];
    if (new Set(targets.map((target) => target.queueId)).size !== targets.length)
      ctx.addIssue({ code: "custom", message: "Execution queues must be unique" });
    if (value.templates.some((ref) => ref.kind !== "workflow" && ref.kind !== "script"))
      ctx.addIssue({
        code: "custom",
        message: "Executable templates must be workflows or scripts",
      });
  });
export type FederationAgreement = z.infer<typeof FederationAgreementSchema>;

export const FederationAttestationBacklogSchema = z.strictObject({
  agreementRevisionId: Id,
  unit: Unit,
  limits: FederationAttestationLimitsSchema.nullable(),
  outstandingTasks: z.number().int().nonnegative(),
  // The sum of many valid 38-digit reservations can exceed 38 digits.
  outstandingAmount: z.string().regex(/^(0|[1-9][0-9]*)$/),
  oldestPendingAt: Time.nullable(),
  oldestAgeSec: z.number().int().nonnegative().nullable(),
  observedAt: Time,
});

export const FederationAgreementApprovalSchema = z.object({
  sourceName: z.string().nullable().optional(),
  targetName: z.string().nullable().optional(),
  localSiteId: Id,
  revisionId: Id,
  localOrgId: Id,
  executionUserId: Id.nullable(),
  terms: FederationAgreementSchema,
  termsDigest: FederationDigestSchema,
  approvalJws: z.string().min(1),
  counterpartyApprovalJws: z.string().nullable(),
  approvedBy: Id,
  state: z.enum(["active", "suspended", "revoked"]),
  createdAt: Time,
});
export type FederationAgreementApproval = z.infer<typeof FederationAgreementApprovalSchema>;
export const FederationAgreementContextSchema = z.object({
  localSiteId: Id,
  supportedModes: z.array(FederationModeSchema),
});
export const FederationExecutionAccountsSchema = z.object({
  data: z.array(z.object({ userId: Id, email: z.string(), displayName: z.string().nullable() })),
  hasMore: z.boolean(),
});

const OperationFields = {
  protocolVersion: z.literal(1),
  operationId: Id,
  senderSiteId: Id,
  recipientSiteId: Id,
  agreementRevisionId: Id,
  mode: FederationModeSchema,
  budgetDomainId: Id,
  epoch: Id,
  taskId: Id,
  attempt: z.number().int().min(1).max(2_147_483_647),
};

export const FederationFileDeliverySchema = z.enum(["network", "media"]);

export const FederationArbitrationReferenceSchema = z.strictObject({
  policyId: Id,
  policyDigest: FederationDigestSchema,
});
export type FederationArbitrationReference = z.infer<typeof FederationArbitrationReferenceSchema>;
export const FederationArbitrationBindingSchema = FederationArbitrationReferenceSchema.extend({
  sourceJws: z.string().min(1).max(524288),
  targetJws: z.string().min(1).max(524288),
});

export const FederationDelegationSchema = z
  .strictObject({
    ...OperationFields,
    kind: z.literal("delegation"),
    issuedAt: Time,
    expiresAt: Time,
    // Signed deadline for preparation and new worker/submission permits after acceptance.
    executionExpiresAt: Time.optional(),
    template: FederationAssetRefSchema,
    // Parameters, software locks and input manifests are immutable, separately authorized assets.
    inputManifestDigest: FederationDigestSchema,
    inputFilesDigest: FederationDigestSchema.optional(),
    // Omission preserves legacy signed messages; it means network delivery.
    inputDelivery: FederationFileDeliverySchema.optional(),
    resultDelivery: FederationFileDeliverySchema.optional(),
    environmentLockDigest: FederationDigestSchema,
    executionTarget: FederationExecutionTargetSchema.optional(),
    managedPlacement: z.strictObject({ queueId: Id, profileId: Id }).optional(),
    resources: FederationResourcesSchema,
    maxAmount: FederationAmountSchema,
    unit: Unit,
    // Original policy signatures are part of the immutable request, never filled in after acceptance.
    arbitration: FederationArbitrationBindingSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const lifetime = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
    if (lifetime <= 0 || lifetime > 3_600_000)
      ctx.addIssue({ code: "custom", message: "Delegation lifetime must be within one hour" });
    if (
      value.executionExpiresAt &&
      Date.parse(value.executionExpiresAt) < Date.parse(value.expiresAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "Execution deadline must cover the admission window",
      });
    if (value.senderSiteId === value.recipientSiteId)
      ctx.addIssue({ code: "custom", message: "Delegation requires different sites" });
    if (value.inputDelivery === "media" && !value.inputFilesDigest)
      ctx.addIssue({ code: "custom", message: "Media inputs require a signed file inventory" });
  });
export type FederationDelegation = z.infer<typeof FederationDelegationSchema>;

export const FederationAcceptanceSchema = z.strictObject({
  ...OperationFields,
  kind: z.literal("acceptance"),
  requestDigest: FederationDigestSchema,
  reservationId: Id,
  reservedAmount: FederationAmountSchema,
  unit: Unit,
  acceptedAt: Time,
  status: z.literal("RESERVED"),
});
export type FederationAcceptance = z.infer<typeof FederationAcceptanceSchema>;

/** Legacy requests retain their original deadline; no implicit extension after acceptance. */
export function federationExecutionDeadline(request: FederationDelegation): number {
  return Date.parse(request.executionExpiresAt ?? request.expiresAt);
}

/** Execution phase requires a separately verified acceptance; local dispatch policy remains mandatory. */
export function assertDelegationPolicy(
  agreement: FederationAgreement,
  request: FederationDelegation,
  now: Date,
  phase: "admission" | "execution" = "admission",
): void {
  if (agreement.mode === "ledger_coordinated") throw new FederationError("LEDGER_REQUIRED");
  assertDelegationTerms(agreement, request, now, phase);
}

/** Terms validation only: callers still need mode-specific admission and execution authorization. */
export function assertDelegationTerms(
  agreement: FederationAgreement,
  request: FederationDelegation,
  now: Date,
  phase: "admission" | "execution" = "admission",
): void {
  if (
    request.agreementRevisionId !== agreement.agreementRevisionId ||
    request.senderSiteId !== agreement.sourceSiteId ||
    request.recipientSiteId !== agreement.targetSiteId ||
    request.mode !== agreement.mode ||
    request.budgetDomainId !== agreement.budgetDomainId ||
    request.epoch !== agreement.epoch ||
    request.unit !== agreement.unit
  )
    throw new FederationError("POLICY_DENIED");
  if (
    now.getTime() < Date.parse(agreement.validFrom) ||
    now.getTime() >= Date.parse(agreement.validUntil) ||
    now.getTime() >=
      (phase === "execution"
        ? federationExecutionDeadline(request)
        : Date.parse(request.expiresAt)) ||
    Date.parse(request.issuedAt) > now.getTime() + 60_000 ||
    Date.parse(request.expiresAt) > Date.parse(agreement.validUntil) ||
    federationExecutionDeadline(request) > Date.parse(agreement.validUntil)
  )
    throw new FederationError("AUTHORIZATION_EXPIRED");
  const templateAllowed = agreement.templates.some((ref) =>
    (Object.keys(ref) as (keyof FederationAssetRef)[]).every(
      (field) => ref[field] === request.template[field],
    ),
  );
  if (
    request.executionTarget &&
    !agreement.executionTargets?.some((target) =>
      (Object.keys(target) as (keyof FederationExecutionTarget)[]).every(
        (key) => target[key] === request.executionTarget?.[key],
      ),
    )
  )
    throw new FederationError("POLICY_DENIED");
  if (
    (request.inputFilesDigest && !agreement.inputPolicy) ||
    !templateAllowed ||
    BigInt(request.maxAmount) > BigInt(agreement.maxTaskAmount) ||
    request.resources.cpus > agreement.resourceLimit.cpus ||
    request.resources.memoryMb > agreement.resourceLimit.memoryMb ||
    request.resources.gpus > agreement.resourceLimit.gpus ||
    request.resources.wallTimeSec > agreement.resourceLimit.wallTimeSec
  )
    throw new FederationError("POLICY_DENIED");
}

export * from "./accounting";
export * from "./assets";
export * from "./cancellation";
export * from "./cluster-queues";
export * from "./dataset-use";
export * from "./input-files";
export * from "./input-transfer";
export * from "./material-exchange";
export * from "./media";
export * from "./media-export-task";
export * from "./media-import-task";
export * from "./media-keys";
export * from "./media-logistics";
export * from "./media-object";
export * from "./media-receipts";
export * from "./media-upload-task";
export * from "./media-views";
export * from "./permissions";
export * from "./result-receipts";
export * from "./result-transfer";
export * from "./results";
export * from "./status";
export * from "./storage-reconciliation";
export * from "./terminal-evidence";
export * from "./trust";
