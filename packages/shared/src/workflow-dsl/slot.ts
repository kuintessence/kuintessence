import { z } from "zod";
import {
  DatasetSchema,
  FileInputSchema,
  SlugSchema,
  TransferStrategySchema,
  UuidSchema,
} from "./common";
import { ExprSchema } from "./expr";
import { NodeOutputRefSchema } from "./refs";

/** Text input form rule. */
const TextInputSlotRuleSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("Json") }),
  z.strictObject({ type: z.literal("Number") }),
  z.strictObject({ type: z.literal("Regex"), regex: z.string() }),
  z.strictObject({ type: z.literal("AnyString") }),
]);

/** Bind a body/sub-workflow input to loop.item, a param, an upstream output, etc. (F5). */
export const InputBindingSchema = z.union([
  ExprSchema,
  NodeOutputRefSchema,
  z.strictObject({ param: SlugSchema }),
]);

/** Consumer-side branch-merge selection (D6 / D6a). */
export const SelectStrategySchema = z.union([
  z.enum(["FirstAvailable", "RequireExactlyOne"]),
  ExprSchema,
]);

const inputCommon = {
  descriptor: z.string(),
  description: z.string().nullish(),
  optional: z.boolean().default(false),
  from: InputBindingSchema.optional(),
  sources: z.array(NodeOutputRefSchema).optional(),
  select: SelectStrategySchema.optional(),
};

const NodeInputSlotBaseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("Text"),
    ...inputCommon,
    contents: z.array(UuidSchema).nullish(),
    rule: TextInputSlotRuleSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("File"),
    ...inputCommon,
    contents: z.array(FileInputSchema).nullish(),
    expectedFileName: z.string().nullish(),
    isBatch: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal("Dataset"),
    ...inputCommon,
    contents: DatasetSchema.nullish(),
  }),
]);

export const NodeInputSlotSchema = NodeInputSlotBaseSchema.superRefine((slot, ctx) => {
  const hasSources = slot.sources !== undefined;
  const hasNonEmptySources = (slot.sources?.length ?? 0) > 0;
  const hasContents = slot.contents !== undefined && slot.contents !== null;
  const bindingCount = [slot.from !== undefined, hasSources, hasContents].filter(Boolean).length;

  if (hasSources && !hasNonEmptySources) {
    ctx.addIssue({
      code: "custom",
      message: "`sources` must be non-empty when present",
      path: ["sources"],
    });
  }
  if (slot.select !== undefined && !hasNonEmptySources) {
    ctx.addIssue({
      code: "custom",
      message: "`select` requires non-empty `sources`",
      path: ["select"],
    });
  }
  if (bindingCount > 1) {
    ctx.addIssue({
      code: "custom",
      message: "input slot must use only one of `from`, `sources`, or `contents`",
    });
  }
  if (
    slot.type === "Dataset" &&
    (slot.from !== undefined || slot.sources !== undefined || slot.select !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Dataset input slots only support static `contents` bindings",
    });
  }
});
export type NodeInputSlot = z.infer<typeof NodeInputSlotSchema>;

export const NodeOutputSlotSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("File"),
    descriptor: z.string(),
    description: z.string().nullish(),
    optional: z.boolean().default(false),
    origin: z.enum(["CollectedOut", "UsecaseOut"]),
    isBatch: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("Text"),
    descriptor: z.string(),
    description: z.string().nullish(),
    optional: z.boolean().default(false),
  }),
]);
export type NodeOutputSlot = z.infer<typeof NodeOutputSlotSchema>;

export const SlotRelationSchema = z.strictObject({
  fromSlot: z.string(),
  toSlot: z.string(),
  transferStrategy: TransferStrategySchema,
  when: ExprSchema.optional(),
});
export type SlotRelation = z.infer<typeof SlotRelationSchema>;

export const NodeRelationSchema = z.strictObject({
  fromId: SlugSchema,
  toId: SlugSchema,
  when: ExprSchema.optional(),
  slotRelations: z.array(SlotRelationSchema),
});
export type NodeRelation = z.infer<typeof NodeRelationSchema>;
