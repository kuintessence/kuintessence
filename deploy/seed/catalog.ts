import type { orgs, users, workflowTemplates } from "../../packages/db/src/pg/schema";
import { validateWorkflow, WorkflowSchema } from "../../packages/shared/src/workflow-dsl";

export type SeedMode = "minimal" | "demo";
export type SeedOrganization = Pick<typeof orgs.$inferInsert, "id" | "name"> & { id: string };
export type SeedUser = Pick<typeof users.$inferInsert, "id" | "email" | "displayName" | "role"> & {
  id: string;
  role: "user" | "org_admin";
};
export type SeedTemplate = Pick<
  typeof workflowTemplates.$inferInsert,
  "id" | "name" | "version" | "description" | "yamlContent" | "tags"
> & { id: string };

export const baseOrganization: SeedOrganization = {
  id: "9e5d7e00-3bf8-4f49-9aa1-000000000001",
  name: "Kuintessence",
};

export const demoProvider: SeedOrganization = {
  id: "9e5d7e00-3bf8-4f49-9aa1-000000000002",
  name: "Development Compute Provider",
};

export const demoUsers: readonly SeedUser[] = [
  {
    id: "9e5d7e00-3bf8-4f49-9aa1-000000000011",
    email: "demo-user@kuintessence.test",
    displayName: "Demo Researcher",
    role: "user",
  },
  {
    id: "9e5d7e00-3bf8-4f49-9aa1-000000000012",
    email: "demo-provider@kuintessence.test",
    displayName: "Demo Compute Provider",
    role: "org_admin",
  },
  {
    id: "9e5d7e00-3bf8-4f49-9aa1-000000000013",
    email: "scheduler-compose-seed@kuintessence.test",
    displayName: "Preview Scheduler",
    role: "org_admin",
  },
];

export const checkpoints: Record<SeedMode, string> = {
  minimal: "9e5d7e00-3bf8-4f49-9aa1-000000000091",
  demo: "9e5d7e00-3bf8-4f49-9aa1-000000000092",
};

function template(
  id: string,
  name: string,
  description: string,
  nodes: string[],
  edges: readonly (readonly [string, string])[],
): SeedTemplate {
  const workflow = WorkflowSchema.parse({
    name,
    description,
    parameters: [],
    spec: {
      nodeDrafts: nodes.map((nodeId) => ({ type: "NoAction", id: nodeId, name: nodeId })),
      nodeRelations: edges.map(([fromId, toId]) => ({ fromId, toId, slotRelations: [] })),
    },
  });
  if (validateWorkflow(workflow).length > 0) throw new Error("Invalid seed workflow");
  return {
    id,
    name,
    version: "1.0.0",
    description,
    // JSON is valid YAML and keeps the seed independent of a second serializer.
    yamlContent: JSON.stringify(workflow, null, 2),
    tags: ["demo", "no-compute"],
  };
}

export function demoTemplates(): SeedTemplate[] {
  return [
    template(
      "9e5d7e00-3bf8-4f49-9aa1-000000000021",
      "preview-noaction-smoke",
      "Two-step workflow that requires no scheduler or software installation.",
      ["start", "done"],
      [["start", "done"]],
    ),
    template(
      "9e5d7e00-3bf8-4f49-9aa1-000000000022",
      "preview-noaction-fanout",
      "Parallel branches joining at a final step, without compute resources.",
      ["start", "left", "right", "done"],
      [
        ["start", "left"],
        ["start", "right"],
        ["left", "done"],
        ["right", "done"],
      ],
    ),
  ];
}
