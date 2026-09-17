import { z } from "zod";

/** Template-internal reference key — a CEL-safe identifier (F1). */
export const SlugSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
  message: "must be a CEL-safe slug: ^[a-zA-Z_][a-zA-Z0-9_]*$",
});
export type Slug = z.infer<typeof SlugSchema>;

/** Global business identifier assigned by the surrounding system. */
export const UuidSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, {
    message: "must be a UUID",
  });
export type Uuid = z.infer<typeof UuidSchema>;

/** Where a node may run. */
export const SchedulingStrategySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("Manual"), queues: z.array(UuidSchema).length(1) }),
  z.strictObject({ type: z.literal("Auto") }),
  z.strictObject({ type: z.literal("Prefer"), queues: z.array(UuidSchema).min(1) }),
]);
export type SchedulingStrategy = z.infer<typeof SchedulingStrategySchema>;

/** How a slot edge moves its payload between sites. */
export const TransferStrategySchema = z.strictObject({
  type: z.enum(["Network", "Disk"]),
});
export type TransferStrategy = z.infer<typeof TransferStrategySchema>;

/** Physical resource request / override. All fields optional. */
export const RequirementsSchema = z.strictObject({
  cpuCores: z.number().int().nonnegative().nullish(),
  nodeCount: z.number().int().nonnegative().nullish(),
  maxWallTime: z.number().int().nonnegative().nullish(),
  maxCpuTime: z.number().int().nonnegative().nullish(),
  stopTime: z.number().int().nonnegative().nullish(),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

/** A concrete file bound to a slot. */
export const FileInputSchema = z.strictObject({
  fileMetadataId: UuidSchema,
  fileMetadataName: z.string(),
  hash: z.string(),
  size: z.number().int().nonnegative(),
});
export type FileInput = z.infer<typeof FileInputSchema>;

export {
  type DataInputRef,
  DataInputRefSchema,
  type Dataset,
  DatasetSchema,
} from "../data-market";
