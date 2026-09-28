import { describe, expect, test } from "bun:test";
import { validateWorkflow, WorkflowSchema } from "../../packages/shared/src/workflow-dsl";
import { baseOrganization, demoProvider, demoTemplates, demoUsers } from "./catalog";
import { seedDatabase } from "./seed";
import { MemorySeedStore } from "./test-store";

describe("deployment seed", () => {
  test("minimal creates only the base organization and its checkpoint", async () => {
    const store = new MemorySeedStore();
    expect(await seedDatabase(store, "minimal")).toBe("applied");
    expect(store.state).toEqual({
      completed: ["minimal"],
      organizations: [baseOrganization],
      users: [],
      memberships: [],
      templates: [],
    });
    const writes = store.writes;
    expect(await seedDatabase(store, "minimal")).toBe("skipped");
    expect(store.writes).toBe(writes);
    expect(store.lockCount).toBe(2);
  });

  test("demo has the scheduler identity, provider membership and runnable templates", async () => {
    const store = new MemorySeedStore();
    await seedDatabase(store, "demo");
    expect(store.state.organizations).toEqual([baseOrganization, demoProvider]);
    expect(store.state.users).toHaveLength(3);
    expect(store.state.templates).toHaveLength(2);
    const scheduler = store.state.users.find(
      (row) => row.email === "scheduler-compose-seed@kuintessence.test",
    );
    if (!scheduler) throw new Error("Missing seeded scheduler identity");
    expect(scheduler.role).toBe("org_admin");
    expect(store.state.memberships).toContainEqual({
      userId: scheduler.id,
      orgId: demoProvider.id,
      role: "admin",
    });
    for (const value of demoTemplates()) {
      const workflow = WorkflowSchema.parse(JSON.parse(value.yamlContent));
      expect(validateWorkflow(workflow)).toEqual([]);
      expect(workflow.advanced?.skipStaticValidation).not.toBe(true);
      expect(workflow.spec.nodeDrafts.every((node) => node.type === "NoAction")).toBe(true);
    }
  });

  test("minimal upgrades to demo; returning to minimal never removes data", async () => {
    const store = new MemorySeedStore();
    await seedDatabase(store, "minimal");
    expect(await seedDatabase(store, "demo")).toBe("applied");
    const state = structuredClone(store.state);
    const writes = store.writes;
    expect(await seedDatabase(store, "minimal")).toBe("skipped");
    expect(await seedDatabase(store, "demo")).toBe("skipped");
    expect(store.state).toEqual(state);
    expect(store.writes).toBe(writes);
  });

  test("reruns preserve edits, renamed natural keys and removed memberships", async () => {
    const store = new MemorySeedStore();
    await seedDatabase(store, "demo");
    for (const row of store.state.organizations) row.name = `Edited ${row.id}`;
    for (const row of store.state.users) {
      row.email = `edited-${row.id}@kuintessence.test`;
      row.role = "user";
    }
    for (const row of store.state.templates) row.yamlContent = "User-edited content";
    store.state.memberships = [];
    const edited = structuredClone(store.state);
    const writes = store.writes;
    expect(await seedDatabase(store, "demo")).toBe("skipped");
    expect(store.state).toEqual(edited);
    expect(store.writes).toBe(writes);
  });

  test("adopts natural identities without replacing existing data or membership roles", async () => {
    const store = new MemorySeedStore();
    store.state.organizations.push({ ...demoProvider, id: "existing-provider" });
    store.state.users.push(
      ...demoUsers.map((user) => ({
        ...user,
        id: `existing-${user.id}`,
        role: "user" as const,
        displayName: "Existing name",
        orgId: "existing-provider",
      })),
    );
    const existingUser = store.state.users[0];
    if (!existingUser) throw new Error("Missing test user");
    store.state.memberships.push({
      userId: existingUser.id,
      orgId: "existing-provider",
      role: "viewer",
    });
    await seedDatabase(store, "demo");
    expect(store.state.users.every((row) => row.displayName === "Existing name")).toBe(true);
    expect(store.state.users).toHaveLength(3);
    expect(store.state.memberships.map((row) => row.role)).toEqual([
      "viewer",
      "member",
      "member",
    ]);
  });

  test("a failed transaction rolls back checkpoints and data before retry", async () => {
    const store = new MemorySeedStore();
    const initial = structuredClone(store.state);
    store.failTemplate = true;
    await expect(seedDatabase(store, "demo")).rejects.toThrow("Simulated template failure");
    expect(store.state).toEqual(initial);
    store.failTemplate = false;
    expect(await seedDatabase(store, "demo")).toBe("applied");
    expect(store.state.completed).toEqual(["minimal", "demo"]);
  });

  test("preserves a pre-existing template with edited contents and a different ID", async () => {
    const store = new MemorySeedStore();
    store.state.templates = demoTemplates().map((value) => ({
      ...value,
      id: `existing-${value.id}`,
      yamlContent: "User-maintained template",
      tags: ["custom"],
    }));
    const templates = structuredClone(store.state.templates);
    await seedDatabase(store, "demo");
    expect(store.state.templates).toEqual(templates);
  });
});
