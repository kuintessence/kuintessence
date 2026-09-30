import {
  baseOrganization,
  demoProvider,
  demoTemplates,
  demoUsers,
  type SeedMode,
  type SeedOrganization,
  type SeedTemplate,
  type SeedUser,
} from "./catalog";

export interface SeedTransaction {
  lock(): Promise<void>;
  completed(mode: SeedMode): Promise<boolean>;
  complete(mode: SeedMode): Promise<void>;
  organization(value: SeedOrganization): Promise<string>;
  user(value: SeedUser, orgId: string): Promise<{ id: string; role: string }>;
  membership(userId: string, orgId: string, role: "admin" | "member"): Promise<void>;
  template(value: SeedTemplate): Promise<void>;
}

export interface SeedStore {
  transaction<T>(callback: (tx: SeedTransaction) => Promise<T>): Promise<T>;
}

export type SeedResult = "applied" | "skipped";

export async function seedDatabase(store: SeedStore, mode: SeedMode): Promise<SeedResult> {
  return store.transaction(async (tx) => {
    await tx.lock();
    let result: SeedResult = "skipped";
    if (!(await tx.completed("minimal"))) {
      await tx.organization(baseOrganization);
      await tx.complete("minimal");
      result = "applied";
    }
    if (mode === "demo" && !(await tx.completed("demo"))) {
      const providerId = await tx.organization(demoProvider);
      for (const value of demoUsers) {
        const user = await tx.user(value, providerId);
        // Respect a pre-existing user's role rather than granting the catalog's role.
        const role =
          user.role === "org_admin" ||
          user.role === "platform_admin" ||
          user.role === "super_admin"
            ? "admin"
            : "member";
        await tx.membership(user.id, providerId, role);
      }
      for (const value of demoTemplates()) await tx.template(value);
      await tx.complete("demo");
      result = "applied";
    }
    return result;
  });
}
