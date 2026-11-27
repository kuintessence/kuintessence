import { z } from "zod";
import { siteProtocolRangeSchema } from "./site-protocol";

export const siteReleaseDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const siteReleaseSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive(),
    serverRevision: z.string().regex(/^[a-f0-9]{40}$/),
    serverProtocolRange: siteProtocolRangeSchema.optional(),
    stateFormat: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
    architecture: z.enum(["x86_64", "aarch64"]),
    minGlibc: z.string().regex(/^\d+\.\d+$/),
    cpuFlags: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(128),
    redistribution: z.literal("unrestricted"),
    files: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
            role: z.enum(["agent", "cli", "runtime-sif", "site-profile", "spack", "tool"]),
            size: z
              .number()
              .int()
              .positive()
              .max(512 * 1024 ** 3),
            sha256: siteReleaseDigestSchema,
            executable: z.boolean(),
          })
          .strict(),
      )
      .min(2)
      .max(128),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (
      new Set(manifest.files.map((f) => f.name)).size !== manifest.files.length ||
      manifest.files.some(
        (f) =>
          ["manifest.json", "manifest.sig", "agent.env"].includes(f.name) ||
          ((f.role === "agent" || f.role === "cli" || f.role === "spack") && !f.executable),
      ) ||
      ["agent", "cli"].some((role) => manifest.files.filter((f) => f.role === role).length !== 1) ||
      ["runtime-sif", "site-profile", "spack"].some(
        (role) => manifest.files.filter((f) => f.role === role).length > 1,
      )
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate or missing site release artifacts" });
    }
  });
