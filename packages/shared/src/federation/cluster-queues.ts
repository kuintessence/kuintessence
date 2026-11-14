import { z } from "zod";
import { SchedulerTypeEnum } from "../schemas/scheduler";
import { FederationAmountSchema, FederationExecutionTargetSchema } from "./execution-target";
import { FederationWorkflowMarketSchema } from "./market";
import { FederationAssetRefSchema, FederationDigestSchema } from "./references";

const Descriptor = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/);

/** An administrator-approved portable execution, pinned to its materials and source revision. */
export const FederationClusterProfileSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(255),
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("command"), commandParameter: Descriptor }),
    z
      .strictObject({
        kind: z.literal("usecase"),
        revisionId: z.uuid(),
        packageId: z.uuid().optional(),
        packageDigest: FederationDigestSchema.optional(),
      })
      .refine(
        (source) => !!source.packageId === !!source.packageDigest,
        "Package ID and digest must be pinned together",
      ),
    z.strictObject({ kind: z.literal("script"), revisionId: z.uuid() }),
  ]),
  template: FederationAssetRefSchema.refine((ref) => ["workflow", "script"].includes(ref.kind)),
  inputManifestDigest: FederationDigestSchema,
  environmentLockDigest: FederationDigestSchema,
  maxAmount: FederationAmountSchema,
  market: FederationWorkflowMarketSchema.optional(),
  outputs: z
    .array(
      z.strictObject({
        descriptor: Descriptor,
        from: z.strictObject({ nodeId: z.string().min(1), descriptor: z.string().min(1) }),
        type: z.enum(["File", "FileBatch"]),
      }),
    )
    .max(256)
    .default([]),
});
export type FederationClusterProfile = z.infer<typeof FederationClusterProfileSchema>;

export const FederationClusterQueueConfigSchema = z
  .strictObject({
    localOrgId: z.uuid(),
    name: z.string().trim().min(1).max(255),
    clusterName: z.string().trim().min(1).max(255),
    queueName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
      .max(255),
    schedulerType: SchedulerTypeEnum,
    agreementRevisionId: z.uuid(),
    executionTarget: FederationExecutionTargetSchema,
    // All-member access is explicit; an empty selection never widens authorization.
    allowAllMembers: z.boolean(),
    allowedUserIds: z.array(z.uuid()).max(1000).default([]),
    showPartnerLabel: z.boolean().default(true),
    enabled: z.boolean().default(true),
    profiles: z.array(FederationClusterProfileSchema).min(1).max(100),
  })
  .superRefine((config, ctx) => {
    const sources = config.profiles.map((p) =>
      p.source.kind === "command" ? "command" : `${p.source.kind}:${p.source.revisionId}`,
    );
    if (
      new Set(sources).size !== sources.length ||
      new Set(config.profiles.map((p) => p.id)).size !== config.profiles.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Execution profiles and source bindings must be unique",
      });
    if (config.allowedUserIds.length !== new Set(config.allowedUserIds).size)
      ctx.addIssue({ code: "custom", message: "User grants must be unique" });
  });
export type FederationClusterQueueConfig = z.infer<typeof FederationClusterQueueConfigSchema>;
export const FederationClusterQueueViewSchema = z.object({
  id: z.uuid(),
  config: FederationClusterQueueConfigSchema,
  partnerName: z.string(),
  targetSiteId: z.uuid(),
  updatedAt: z.iso.datetime(),
});
export type FederationClusterQueueView = z.infer<typeof FederationClusterQueueViewSchema>;
