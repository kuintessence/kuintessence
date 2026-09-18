import { z } from "zod";

const nameSegment = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const RecipeRepositoryNameSchema = z
  .string()
  .max(400)
  .refine((value) => {
    const parts = value.split("/");
    const head = parts[0];
    const expected = head === "public" ? 2 : head === "org" || head === "user" ? 3 : 0;
    return (
      expected > 0 &&
      parts.length === expected &&
      parts.slice(1).every((part) => nameSegment.test(part) && part !== ".git")
    );
  }, "Use public/<name>, org/<owner>/<name>, or user/<owner>/<name>");

export const RecipeRepositoryIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RecipeCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const RecipeDiagnosticSchema = z.strictObject({
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  package: z.string().optional(),
});
export type RecipeDiagnostic = z.infer<typeof RecipeDiagnosticSchema>;

export const RecipeRootSchema = z.strictObject({
  path: z.string(),
  namespace: z.string(),
  api: z.string(),
  packageCount: z.number().int().nonnegative(),
});
export type RecipeRoot = z.infer<typeof RecipeRootSchema>;

export const RecipeSnapshotSchema = z.strictObject({
  commit: RecipeCommitSchema,
  importedAt: z.string().datetime(),
  importedBy: z.string(),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  roots: z.array(RecipeRootSchema),
  diagnostics: z.array(RecipeDiagnosticSchema),
  validation: z.literal("static-only"),
});
export type RecipeSnapshot = z.infer<typeof RecipeSnapshotSchema>;

export const RecipeRepositorySchema = z.strictObject({
  id: RecipeRepositoryIdSchema,
  repository: RecipeRepositoryNameSchema,
  activeCommit: RecipeCommitSchema.nullable(),
  snapshots: z.array(RecipeSnapshotSchema),
});
export type RecipeRepository = z.infer<typeof RecipeRepositorySchema>;

export const RecipeActivationSchema = z.strictObject({
  commit: RecipeCommitSchema,
  expectedActiveCommit: RecipeCommitSchema.nullable(),
  acknowledgeExecutableRecipes: z.literal(true),
});
export type RecipeActivation = z.infer<typeof RecipeActivationSchema>;

export const RecipeDeactivationSchema = z.strictObject({
  expectedActiveCommit: RecipeCommitSchema,
});

export const RecipeBootstrapManifestSchema = z.strictObject({
  version: z.literal(1),
  repositories: z
    .array(
      z.strictObject({
        repository: RecipeRepositoryNameSchema,
        bundlePath: z.string().min(1),
      }),
    )
    .max(100),
});
