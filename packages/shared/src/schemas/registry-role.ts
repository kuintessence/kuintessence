import { z } from "zod";

export const RegistryRoleSchema = z.enum([
  "super_admin",
  "platform_admin",
  "operator",
  "org_admin",
  "user",
  "guest",
]);

export type RegistryRole = z.infer<typeof RegistryRoleSchema>;

export const DEFAULT_REGISTRY_PUBLISHER_ROLES: RegistryRole[] = [
  "super_admin",
  "platform_admin",
  "org_admin",
];

export const registryPublisherRolesConfigSchema = z
  .string()
  .default(DEFAULT_REGISTRY_PUBLISHER_ROLES.join(","))
  .transform((raw, ctx) => {
    const roles = raw
      .split(",")
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
    const invalid = roles.filter((role) => !RegistryRoleSchema.safeParse(role).success);
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid Registry publisher role(s): ${invalid.join(", ")}`,
      });
      return z.NEVER;
    }
    return roles as RegistryRole[];
  });
