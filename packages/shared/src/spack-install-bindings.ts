import { z } from "zod";
import { SpackMaterialBindingSchema } from "./spack-materials";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value.trim() === value &&
        [...value].every((character) => character.charCodeAt(0) >= 32 && character !== "\x7f"),
    );

export const SpackInstallBindingQuerySchema = z.strictObject({
  scope: z.union([z.literal("platform"), z.string().uuid().toLowerCase()]),
  spec: text(500),
});

const change = {
  ...SpackInstallBindingQuerySchema.shape,
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  reason: text(1000),
};
export const SpackInstallBindingChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...change, action: z.literal("bind"), binding: SpackMaterialBindingSchema }),
  z.strictObject({ ...change, action: z.literal("disable") }),
]);

const event = z.strictObject({
  revision: z.number().int().positive(),
  state: z.enum(["enabled", "disabled"]),
  binding: SpackMaterialBindingSchema.nullable(),
  source: z.enum(["config", "web"]),
  operatorId: z.string().uuid().nullable(),
  reason: z.string(),
  createdAt: z.string().datetime(),
});
export const SpackInstallBindingViewSchema = z.strictObject({
  ...SpackInstallBindingQuerySchema.shape,
  revision: z.number().int().nonnegative(),
  state: z.enum(["absent", "enabled", "disabled"]),
  binding: SpackMaterialBindingSchema.nullable(),
  history: z.array(event).max(100),
  historyTruncated: z.boolean(),
});

export type SpackInstallBindingQuery = z.infer<typeof SpackInstallBindingQuerySchema>;
export type SpackInstallBindingChange = z.infer<typeof SpackInstallBindingChangeSchema>;
export type SpackInstallBindingView = z.infer<typeof SpackInstallBindingViewSchema>;
