import { type MeCapabilities, RecipeRepositoryNameSchema } from "@kuintessence/shared/browser";

export function canWriteRecipeRepository(
  repository: string,
  access: {
    canManage: boolean;
    organizationId: string | null;
    capabilities: MeCapabilities | null;
  },
): boolean {
  const { canManage, organizationId, capabilities } = access;
  if (
    !canManage ||
    !capabilities?.capabilities.includes("software.publish") ||
    !RecipeRepositoryNameSchema.safeParse(repository).success
  ) {
    return false;
  }
  const [kind, owner] = repository.split("/");
  const role = capabilities.principal.role;
  if (kind !== "public" && kind !== "org") return false;
  if (role === "super_admin") return true;
  if (kind === "public") return role === "platform_admin";
  // Keep non-super-admin writes within the selected, verified organization.
  return (
    owner === organizationId &&
    (role === "org_admin" || role === "platform_admin") &&
    capabilities.contexts.some(
      (context) => context.type === "organization" && context.organizationId === owner,
    )
  );
}
