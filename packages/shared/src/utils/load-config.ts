import type { z } from "zod";

/**
 * Parse `env` against `schema`, throwing a formatted error listing every
 * failed field. Shared by each package's `load*Config`. `label` names the
 * component in the thrown message (e.g. "Server", "Agent", "Registry").
 */
export function loadConfig<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv, label: string): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${label} configuration:\n${issues}`);
  }
  return result.data;
}
