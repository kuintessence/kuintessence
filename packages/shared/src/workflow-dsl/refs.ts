import { z } from "zod";
import { SlugSchema, UuidSchema } from "./common";

export const AssetSelectorSourceSchema = z.enum([
  "official-upstream",
  "platform-fork",
  "cp-private",
  "cp-shared",
  "sp-draft",
  "sp-published",
]);
export type AssetSelectorSource = z.infer<typeof AssetSelectorSourceSchema>;

/**
 * Stable logical reference for a published asset. Runtime resolvers must turn
 * this into a pinned asset revision before dispatching a run.
 */
export const AssetSelectorSchema = z
  .strictObject({
    source: AssetSelectorSourceSchema,
    name: z.string().min(1),
    version: z.string().min(1),
    providerOrgId: UuidSchema.optional(),
  })
  .superRefine((selector, ctx) => {
    if (selector.source === "cp-private" && selector.providerOrgId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["providerOrgId"],
        message: "CP-private assets require providerOrgId",
      });
    }
  });
export type AssetSelector = z.infer<typeof AssetSelectorSchema>;

/** Immutable asset revision selected at workflow submission time. */
export const FrozenAssetRevisionRefSchema = z.strictObject({
  assetId: UuidSchema,
  revisionId: UuidSchema,
  revision: z.number().int().positive(),
});
export type FrozenAssetRevisionRef = z.infer<typeof FrozenAssetRevisionRefSchema>;

/** Immutable provenance retained in a persisted run after logical refs resolve. */
export const FrozenUsecaseAssetRevisionsSchema = z.strictObject({
  usecase: FrozenAssetRevisionRefSchema,
  software: FrozenAssetRevisionRefSchema,
});
export type FrozenUsecaseAssetRevisions = z.infer<typeof FrozenUsecaseAssetRevisionsSchema>;

/** Reference to a node's slot output (by template-internal `id`). */
export const NodeOutputRefSchema = z.strictObject({
  node: SlugSchema,
  output: z.string(),
});
export type NodeOutputRef = z.infer<typeof NodeOutputRefSchema>;

/** Reference to a loop node's aggregated output. */
export const LoopOutputRefSchema = z.strictObject({
  loop: SlugSchema,
  output: z.string(),
});
export type LoopOutputRef = z.infer<typeof LoopOutputRefSchema>;
