import { z } from "zod";
import { SpackMaterialBindingSchema } from "./spack-materials";
import { RecipeRepositoryNameSchema } from "./spack-repositories";

export const SpackMaterialLifecycleChangeSchema = z.strictObject({
  action: z.enum(["withdraw", "restore"]),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  reason: z
    .string()
    .min(1)
    .max(1000)
    .refine(
      (value) =>
        value.trim() === value &&
        [...value].every((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127;
        }),
    ),
});
export type SpackMaterialLifecycleChange = z.infer<typeof SpackMaterialLifecycleChangeSchema>;

const revisionSchema = z.number().int().min(0).max(2_147_483_647);
const stateSchema = z.enum(["available", "withdrawn"]);
const auditSchema = z.strictObject({
  revision: revisionSchema.min(1),
  state: stateSchema,
  operatorId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
  reason: SpackMaterialLifecycleChangeSchema.shape.reason,
  epoch: z.string().uuid(),
  rolloutRevision: z.number().int().positive().max(2_147_483_647),
  createdAt: z.string().datetime(),
});

export const SpackMaterialLifecycleViewSchema = z
  .strictObject({
    binding: SpackMaterialBindingSchema,
    repository: RecipeRepositoryNameSchema,
    revision: revisionSchema,
    state: stateSchema,
    history: z.array(auditSchema).max(100),
    historyTruncated: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.history.length !== Math.min(value.revision, 100)) {
      ctx.addIssue({
        code: "custom",
        path: ["history"],
        message: "History must contain the latest revisions, up to 100 entries",
      });
    }
    if (value.historyTruncated !== value.revision > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["historyTruncated"],
        message: "History truncation must match the revision",
      });
    }
    if (
      (value.revision === 0 && value.state !== "available") ||
      (value.revision > 0 && value.history[0]?.state !== value.state)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: "State must match the initial state or newest audit entry",
      });
    }
    if (value.history.some((entry, index) => entry.revision !== value.revision - index)) {
      ctx.addIssue({
        code: "custom",
        path: ["history"],
        message: "History revisions must descend contiguously from the current revision",
      });
    }
  });
export type SpackMaterialLifecycleView = z.infer<typeof SpackMaterialLifecycleViewSchema>;
