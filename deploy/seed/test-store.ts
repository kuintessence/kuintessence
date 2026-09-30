import type { SeedMode, SeedOrganization, SeedTemplate, SeedUser } from "./catalog";
import type { SeedStore, SeedTransaction } from "./seed";

interface State {
  completed: SeedMode[];
  organizations: SeedOrganization[];
  users: (SeedUser & { orgId: string })[];
  memberships: { userId: string; orgId: string; role: string }[];
  templates: SeedTemplate[];
}

export class MemorySeedStore implements SeedStore {
  state: State = {
    completed: [],
    organizations: [],
    users: [],
    memberships: [],
    templates: [],
  };
  failTemplate = false;
  lockCount = 0;
  writes = 0;

  async transaction<T>(callback: (tx: SeedTransaction) => Promise<T>): Promise<T> {
    const draft = structuredClone(this.state);
    let locked = false;
    const write = () => {
      if (!locked) throw new Error("Seed must lock before writing");
      this.writes++;
    };
    const result = await callback({
      lock: async () => {
        locked = true;
        this.lockCount++;
      },
      completed: async (mode) => draft.completed.includes(mode),
      complete: async (mode) => {
        write();
        draft.completed.push(mode);
      },
      organization: async (value) => {
        const existing = draft.organizations.find(
          (row) => row.id === value.id || row.name === value.name,
        );
        if (existing) return existing.id;
        write();
        draft.organizations.push(structuredClone(value));
        return value.id;
      },
      user: async (value, orgId) => {
        const existing = draft.users.find(
          (row) => row.id === value.id || row.email === value.email,
        );
        if (existing) return existing;
        write();
        const created = { ...value, orgId };
        draft.users.push(created);
        return created;
      },
      membership: async (userId, orgId, role) => {
        if (draft.memberships.some((row) => row.userId === userId && row.orgId === orgId)) {
          return;
        }
        write();
        draft.memberships.push({ userId, orgId, role });
      },
      template: async (value) => {
        if (this.failTemplate) throw new Error("Simulated template failure");
        if (
          draft.templates.some(
            (row) =>
              row.id === value.id || (row.name === value.name && row.version === value.version),
          )
        ) {
          return;
        }
        write();
        draft.templates.push(structuredClone(value));
      },
    });
    this.state = draft;
    return result;
  }
}
