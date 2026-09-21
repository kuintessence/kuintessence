import { z } from "zod";

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
