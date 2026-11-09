import { z } from "zod";
import {
  FederationAmountSchema,
  FederationFileDeliverySchema,
  FederationResourcesSchema,
} from "../federation";
import { FederationParameterOverridesSchema } from "../federation/assets";
import { FederationWorkflowMarketSchema } from "../federation/market";
import { FederationAssetRefSchema, FederationDigestSchema } from "../federation/references";
import { RequirementsSchema, SchedulingStrategySchema, SlugSchema, UuidSchema } from "./common";
import { ExprSchema, IntOrExprSchema } from "./expr";
import { ValueOutputSchema } from "./extract";
import { GenOutputSchema, GenRuleSchema } from "./generate";
import { LoopCarrySchema, LoopOutputSchema } from "./loop";
import { ReduceOutputSchema, ReducerSchema } from "./reduce";
import {
  AssetSelectorSchema,
  FrozenUsecaseAssetRevisionsSchema,
  LoopOutputRefSchema,
} from "./refs";
import {
  ExecutionIdentitySchema,
  PlacementConstraintSchema,
  SandboxRuntimeContractRefSchema,
  ScriptInputSpecSchema,
  ScriptOutputSpecSchema,
  ScriptRefSchema,
  ScriptSourceSchema,
} from "./script";
import {
  InputBindingSchema,
  NodeInputSlotSchema,
  NodeOutputSlotSchema,
  NodeRelationSchema,
} from "./slot";

const nodeCommon = {
  id: SlugSchema,
  externalId: UuidSchema.nullish(),
  name: z.string(),
  description: z.string().nullish(),
  when: ExprSchema.optional(),
};

const NonDatasetInputSlotsSchema = z.array(NodeInputSlotSchema).superRefine((slots, ctx) => {
  for (const [index, slot] of slots.entries()) {
    if (slot.type === "Dataset") {
      ctx.addIssue({
        code: "custom",
        path: [index],
        message:
          "Dataset input slots are only supported on SoftwareUsecaseComputing or Script nodes",
      });
    }
  }
});

/**
 * Recursive boundary: a workflow spec holds nodes, and `Loop` / `SubWorkflow`
 * nodes hold a nested workflow spec. `z.lazy` breaks the definition cycle.
 */
export const WorkflowSpecSchema = z.strictObject({
  get nodeDrafts() {
    return z.array(WorkflowNodeSchema);
  },
  nodeRelations: z.array(NodeRelationSchema).default([]),
});
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

const SubWorkflowRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ByVersion"), workflowVersionId: UuidSchema }),
  z.strictObject({ kind: z.literal("Inline"), body: WorkflowSpecSchema }),
]);

const SubWorkflowInputSchema = z.strictObject({
  to: z.strictObject({ param: SlugSchema }),
  from: InputBindingSchema,
});

const SubWorkflowOutputSchema = z.strictObject({
  descriptor: z.string(),
  from: z.strictObject({ workflowOutput: z.string() }),
});

export const WorkflowNodeSchema = z.union([
  z.strictObject({
    ...nodeCommon,
    type: z.literal("Federation"),
    agreementRevisionId: UuidSchema,
    market: FederationWorkflowMarketSchema.optional(),
    template: FederationAssetRefSchema.refine(
      (ref) => ref.kind === "workflow" || ref.kind === "script",
    ),
    inputManifestDigest: FederationDigestSchema,
    inputDelivery: FederationFileDeliverySchema.optional(),
    resultDelivery: FederationFileDeliverySchema.optional(),
    environmentLockDigest: FederationDigestSchema,
    resources: FederationResourcesSchema,
    maxAmount: FederationAmountSchema,
    admissionWindowSec: z.number().int().min(1).max(3600).default(600),
    executionExpiresAt: z.iso.datetime().optional(),
    inputSlots: z
      .array(NodeInputSlotSchema)
      .superRefine((slots, ctx) => {
        if (new Set(slots.map((slot) => slot.descriptor)).size !== slots.length)
          ctx.addIssue({ code: "custom", message: "Federation input descriptors must be unique" });
        for (const [index, slot] of slots.entries()) {
          if (!FederationParameterOverridesSchema.keyType.safeParse(slot.descriptor).success)
            ctx.addIssue({
              code: "custom",
              path: [index, "descriptor"],
              message: "Invalid federation parameter descriptor",
            });
          if (
            slot.type === "Dataset" ||
            (slot.type === "Text" && (slot.contents != null || (!slot.from && !slot.sources))) ||
            (slot.type === "File" &&
              ((!slot.from && !slot.sources && slot.contents == null) ||
                (!slot.isBatch && slot.contents != null && slot.contents.length !== 1)))
          )
            ctx.addIssue({
              code: "custom",
              path: [index],
              message:
                "Federation inputs require scalar Text bindings or explicit File/FileBatch selections",
            });
        }
      })
      .optional(),
    outputs: z
      .array(
        z.strictObject({
          descriptor: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/),
          from: z.strictObject({
            nodeId: z.string().min(1).max(255),
            descriptor: z.string().min(1).max(255),
          }),
          type: z.enum(["File", "FileBatch"]),
        }),
      )
      .max(256)
      .default([]),
  }),
  z
    .strictObject({
      ...nodeCommon,
      type: z.literal("SoftwareUsecaseComputing"),
      usecaseVersionId: UuidSchema.optional(),
      softwareVersionId: UuidSchema.optional(),
      usecaseRef: AssetSelectorSchema.optional(),
      softwareRef: AssetSelectorSchema.optional(),
      frozenAssetRevisions: FrozenUsecaseAssetRevisionsSchema.optional(),
      schedulingStrategy: SchedulingStrategySchema.optional(),
      requirements: RequirementsSchema.nullish(),
      inputSlots: z.array(NodeInputSlotSchema).optional(),
      outputSlots: z.array(NodeOutputSlotSchema).optional(),
      valueOutputsOverride: z.array(ValueOutputSchema).optional(),
    })
    .superRefine((node, ctx) => {
      const hasUuid = node.usecaseVersionId !== undefined || node.softwareVersionId !== undefined;
      const hasNamed = node.usecaseRef !== undefined || node.softwareRef !== undefined;
      if (hasUuid && hasNamed) {
        ctx.addIssue({
          code: "custom",
          message: "UUID and named software references are mutually exclusive",
        });
      }
      if (
        hasUuid &&
        (node.usecaseVersionId === undefined || node.softwareVersionId === undefined)
      ) {
        ctx.addIssue({ code: "custom", message: "UUID usecase references require both UUIDs" });
      }
      if (hasNamed && (node.usecaseRef === undefined || node.softwareRef === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "named usecase references require both selectors",
        });
      }
      if (!hasUuid && !hasNamed) {
        ctx.addIssue({ code: "custom", message: "a software usecase requires a reference" });
      }
    }),
  z.strictObject({
    ...nodeCommon,
    type: z.literal("NoAction"),
    inputSlots: NonDatasetInputSlotsSchema.optional(),
    outputSlots: z.array(NodeOutputSlotSchema).optional(),
  }),
  z
    .strictObject({
      ...nodeCommon,
      type: z.literal("Script"),
      source: ScriptSourceSchema.optional(),
      scriptRef: ScriptRefSchema.optional(),
      runtimeProfileId: UuidSchema.optional(),
      runtimeContractRef: SandboxRuntimeContractRefSchema.optional(),
      executionIdentity: ExecutionIdentitySchema.default({ type: "Inherit" }),
      schedulingStrategy: SchedulingStrategySchema.default({ type: "Auto" }),
      requirements: RequirementsSchema.nullish(),
      placementConstraint: PlacementConstraintSchema.optional(),
      inputs: z.record(z.string().min(1), ScriptInputSpecSchema).default({}),
      outputs: z.record(z.string().min(1), ScriptOutputSpecSchema).default({}),
      inputSlots: z.array(NodeInputSlotSchema).optional(),
      outputSlots: z.array(NodeOutputSlotSchema).optional(),
    })
    .superRefine((node, ctx) => {
      for (const [index, slot] of (node.inputSlots ?? []).entries()) {
        if (slot.type === "Dataset" && node.inputs[slot.descriptor]?.type !== "FileBatch") {
          ctx.addIssue({
            code: "custom",
            path: ["inputSlots", index],
            message: "Script Dataset inputs require a declared FileBatch input",
          });
        }
      }
      const hasSource = node.source !== undefined;
      const hasNamedSource = node.scriptRef !== undefined;
      const hasRuntimeProfile = node.runtimeProfileId !== undefined;
      const hasRuntimeContract = node.runtimeContractRef !== undefined;
      if (hasSource === hasNamedSource) {
        ctx.addIssue({ code: "custom", message: "script requires exactly one source reference" });
      }
      if (hasRuntimeProfile === hasRuntimeContract) {
        ctx.addIssue({
          code: "custom",
          message: "script requires exactly one runtime reference",
        });
      }
    }),
  z.strictObject({
    ...nodeCommon,
    type: z.literal("Milestone"),
    url: z.string(),
    customMessage: z.string(),
  }),
  z.strictObject({
    ...nodeCommon,
    type: z.literal("Generate"),
    rule: GenRuleSchema,
    output: GenOutputSchema,
  }),
  z
    .strictObject({
      ...nodeCommon,
      type: z.literal("Loop"),
      mode: z.enum(["While", "ForEach"]),
      maxIterations: IntOrExprSchema,
      body: WorkflowSpecSchema,
      outputs: z.array(LoopOutputSchema).optional(),
      onExhausted: z.enum(["Fail", "SucceedWithLast"]).optional(),
      until: ExprSchema.optional(),
      carry: z.array(LoopCarrySchema).optional(),
      over: ExprSchema.optional(),
      maxParallel: z.number().int().positive().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.mode === "While" && v.until === undefined) {
        ctx.addIssue({ code: "custom", message: "While loop requires `until`" });
      }
      if (v.mode === "ForEach" && v.over === undefined) {
        ctx.addIssue({ code: "custom", message: "ForEach loop requires `over`" });
      }
    }),
  z.strictObject({
    ...nodeCommon,
    type: z.literal("Reduce"),
    from: LoopOutputRefSchema,
    ordering: z.enum(["ByIndex", "Unordered"]).optional(),
    reducer: ReducerSchema,
    output: ReduceOutputSchema,
  }),
  z.strictObject({
    ...nodeCommon,
    type: z.literal("Switch"),
    cases: z.array(z.strictObject({ when: ExprSchema, to: SlugSchema })).min(1),
    default: SlugSchema.optional(),
  }),
  z.strictObject({
    ...nodeCommon,
    type: z.literal("SubWorkflow"),
    ref: SubWorkflowRefSchema,
    maxDepth: z.number().int().positive(),
    onDepthExceeded: z.enum(["Fail", "SucceedWithLast"]).optional(),
    inputs: z.array(SubWorkflowInputSchema).optional(),
    outputs: z.array(SubWorkflowOutputSchema).optional(),
  }),
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
