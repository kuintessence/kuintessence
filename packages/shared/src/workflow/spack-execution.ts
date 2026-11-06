import { z } from "zod";
import { SpackMaterialDigestSchema } from "../spack-materials";

// Older Agents must fail rather than execute a command without its managed environment.
export const SPACK_EXECUTION_PLACEHOLDER = "exit 125";
// Older Spack-aware Agents reject this sentinel even if protobuf drops the unknown pin field.
export const SPACK_PINNED_EXECUTION_PLACEHOLDER = "exit 126";
export const SPACK_ACTIVATION_FAILURE = "Workflow Spack activation failed";
export const SPACK_ACTIVATION_TIMEOUT = `${SPACK_ACTIVATION_FAILURE}: deadline exceeded`;

/** Exact managed installation selected from an authorized native lock/material release. */
export const SpackExecutionPinSchema = z.strictObject({
  dagHash: z.string().regex(/^[a-z2-7]{32}$/),
  manifestDigest: SpackMaterialDigestSchema,
  lockfileDigest: SpackMaterialDigestSchema,
  spackVersion: z.literal("1.0.0"),
  target: z
    .string()
    .min(1)
    .max(256)
    .regex(/^linux-[A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+$/),
});
export type SpackExecutionPin = z.infer<typeof SpackExecutionPinSchema>;

/** Internal workflow dispatch intent, never part of the public JobSubmit schema. */
export const SpackExecutionSchema = z.strictObject({
  spec: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => !/[\r\n\0]/.test(value), "Invalid Spack spec"),
  command: z
    .string()
    .min(1)
    .max(64 * 1024)
    .refine((value) => value.trim().length > 0 && !value.includes("\0"), "Invalid command"),
  pin: SpackExecutionPinSchema.optional(),
});

export type SpackExecution = z.infer<typeof SpackExecutionSchema>;
