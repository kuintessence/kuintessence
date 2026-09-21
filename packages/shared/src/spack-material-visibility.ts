import { z } from "zod";
import { SpackMaterialLifecycleChangeSchema } from "./spack-material-lifecycle";
import { SpackMaterialBindingSchema } from "./spack-materials";
import { RecipeRepositoryNameSchema } from "./spack-repositories";

const principalIds = z
  .array(z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/))
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "Principal IDs must be unique");
const policyInput = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("inherit") }),
  z.strictObject({
    mode: z.literal("allowlist"),
    userIds: principalIds,
    orgIds: principalIds,
  }),
]);

export const SpackMaterialVisibilityPolicySchema = policyInput.refine(
  (policy) =>
    policy.mode === "inherit" ||
    [policy.userIds, policy.orgIds].every((ids) =>
      ids.every((id, index) => index === 0 || (ids[index - 1] ?? "") < id),
    ),
  "Policy principal IDs must be sorted canonically",
);
export type SpackMaterialVisibilityPolicy = z.infer<typeof SpackMaterialVisibilityPolicySchema>;

export const SpackMaterialVisibilityChangeSchema = z.strictObject({
  policy: policyInput.transform(
    (policy): SpackMaterialVisibilityPolicy =>
      policy.mode === "inherit"
        ? policy
        : {
            mode: policy.mode,
            userIds: [...policy.userIds].sort(),
            orgIds: [...policy.orgIds].sort(),
          },
  ),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  reason: SpackMaterialLifecycleChangeSchema.shape.reason,
});
export type SpackMaterialVisibilityChange = z.infer<typeof SpackMaterialVisibilityChangeSchema>;

const revisionSchema = z.number().int().min(0).max(2_147_483_647);
const auditSchema = z.strictObject({
  revision: revisionSchema.min(1),
  policy: SpackMaterialVisibilityPolicySchema,
  operatorId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
  reason: SpackMaterialVisibilityChangeSchema.shape.reason,
  epoch: z.string().uuid(),
  rolloutRevision: z.number().int().positive().max(2_147_483_647),
  createdAt: z.string().datetime(),
});

export const SpackMaterialVisibilityViewSchema = z
  .strictObject({
    binding: SpackMaterialBindingSchema,
    repository: RecipeRepositoryNameSchema,
    revision: revisionSchema,
    policy: SpackMaterialVisibilityPolicySchema,
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
      (value.revision === 0 && value.policy.mode !== "inherit") ||
      (value.revision > 0 &&
        JSON.stringify(value.history[0]?.policy) !== JSON.stringify(value.policy))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["policy"],
        message: "Policy must match the initial policy or newest audit entry",
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
export type SpackMaterialVisibilityView = z.infer<typeof SpackMaterialVisibilityViewSchema>;
