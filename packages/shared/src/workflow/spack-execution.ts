import { z } from "zod";

// Older Agents must fail rather than execute a command without its managed environment.
export const SPACK_EXECUTION_PLACEHOLDER = "exit 125";

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
});

export type SpackExecution = z.infer<typeof SpackExecutionSchema>;
