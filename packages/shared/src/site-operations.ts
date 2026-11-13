import { z } from "zod";
import { SpackAuditContextSchema } from "./spack-source-audit";

export const SiteChannelStateSchema = z.enum([
  "unknown",
  "disabled",
  "idle",
  "running",
  "ready",
  "blocked",
  "failed",
]);
export const SiteChannelSchema = z
  .object({ state: SiteChannelStateSchema, active: z.number().int().min(0).max(100000).default(0) })
  .strict();
export const SiteOperationsSchema = z
  .object({
    version: z.literal(1),
    observedAt: z.number().int().positive(),
    transport: z.enum(["ssh-forward", "http-proxy", "direct"]),
    auditContext: SpackAuditContextSchema.optional(),
    trust: z.enum(["single-user", "administrator"]),
    executor: z.enum(["slurm", "local"]),
    materials: SiteChannelSchema,
    installation: SiteChannelSchema,
    jobs: SiteChannelSchema,
    transfers: SiteChannelSchema,
    update: z
      .object({
        phase: z.enum(["unknown", "staged", "activated", "rolled-back", "failed"]),
        checkedAt: z.number().int().nonnegative().optional(),
        release: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type SiteOperations = z.infer<typeof SiteOperationsSchema>;
export type SiteChannel = z.infer<typeof SiteChannelSchema>;

/** Optional telemetry must never interrupt the control stream or accept free-form secrets. */
export function parseSiteOperations(value: string, now = Date.now()): SiteOperations | undefined {
  if (!value || new TextEncoder().encode(value).byteLength > 8192) return undefined;
  try {
    const parsed = SiteOperationsSchema.parse(JSON.parse(value));
    if (parsed.observedAt > now + 60_000 || parsed.observedAt < now - 300_000) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
