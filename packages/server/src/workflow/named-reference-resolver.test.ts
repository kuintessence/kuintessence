import { describe, expect, test } from "bun:test";
import { workflowDsl } from "@kuintessence/shared";
import {
  type WorkflowNamedReferenceRepository,
  WorkflowNamedReferenceResolver,
} from "./named-reference-resolver";

const USECASE_ASSET_ID = "11111111-1111-4111-8111-111111111111";
const USECASE_REVISION_ID = "11111111-1111-4111-8111-111111111112";
const SOFTWARE_ASSET_ID = "22222222-2222-4222-8222-222222222222";
const SOFTWARE_REVISION_ID = "22222222-2222-4222-8222-222222222223";

const principal = {
  sub: "user-sub",
  role: "user",
  email: "scientist@example.test",
  userId: "33333333-3333-4333-8333-333333333333",
  orgId: null,
  orgIds: [],
  memberships: [],
  capabilities: [],
};

const workflow: workflowDsl.Workflow = {
  name: "named-reference-workflow",
  parameters: [],
  spec: {
    nodeDrafts: [
      {
        type: "SoftwareUsecaseComputing",
        id: "compute",
        name: "compute",
        usecaseRef: { source: "official-upstream", name: "gromacs-md", version: "1.0.0" },
        softwareRef: { source: "official-upstream", name: "gromacs", version: "2025.2" },
      },
    ],
    nodeRelations: [],
  },
};

function repository(): WorkflowNamedReferenceRepository {
  return {
    findAssets: async (kind, selector) => {
      if (kind === "usecase") {
        return [
          {
            id: USECASE_ASSET_ID,
            kind,
            source: selector.source,
            name: selector.name,
            version: selector.version,
            providerOrgId: null,
            lifecycle: "published",
            visibility: "platform-public",
            payload: {},
          },
        ];
      }
      return [
        {
          id: SOFTWARE_ASSET_ID,
          kind,
          source: selector.source,
          name: selector.name,
          version: selector.version,
          providerOrgId: null,
          lifecycle: "published",
          visibility: "platform-public",
          payload: {},
        },
      ];
    },
    findLatestRevision: async (assetId) => {
      if (assetId === USECASE_ASSET_ID) {
        return {
          id: USECASE_REVISION_ID,
          assetId,
          revision: 7,
          payload: {
            kind: "usecase",
            spec: {
              usecase: { commandFile: "gmx", inputSlots: [] },
              software: { kind: "Spack", name: "gromacs", argumentList: [] },
              arguments: [],
              environments: [],
              filesomeInputs: [],
              filesomeOutputs: [],
              valueOutputs: [],
              description: "GROMACS molecular dynamics",
              domain: "molecular-simulation",
              tags: ["gromacs"],
              citations: [],
              softwareRef: {
                source: "official-upstream",
                name: "gromacs",
                version: "2025.2",
              },
              inputs: [],
              outputs: [],
              resources: {},
              materialMappings: [],
              licenseRequirements: [],
            },
          },
        };
      }
      return {
        id: SOFTWARE_REVISION_ID,
        assetId,
        revision: 3,
        payload: { kind: "spack-package", spack: { packageName: "gromacs" } },
      };
    },
  };
}

describe("WorkflowNamedReferenceResolver", () => {
  test("authorizes both assets and freezes immutable asset revision identifiers", async () => {
    const authorized: string[] = [];
    const resolver = new WorkflowNamedReferenceResolver(repository(), {
      assertUse: async (assetId) => {
        authorized.push(assetId);
      },
    });

    const resolved = await resolver.resolve(workflow, principal);
    const node = resolved.spec.nodeDrafts[0];
    if (!node || node.type !== "SoftwareUsecaseComputing") throw new Error("missing node");

    expect(authorized).toEqual([USECASE_ASSET_ID, SOFTWARE_ASSET_ID]);
    expect(node.usecaseVersionId).toBe(USECASE_REVISION_ID);
    expect(node.softwareVersionId).toBe(SOFTWARE_REVISION_ID);
    expect(node.frozenAssetRevisions).toEqual({
      usecase: { assetId: USECASE_ASSET_ID, revisionId: USECASE_REVISION_ID, revision: 7 },
      software: { assetId: SOFTWARE_ASSET_ID, revisionId: SOFTWARE_REVISION_ID, revision: 3 },
    });
    expect(node.usecaseRef).toBeUndefined();
    expect(node.softwareRef).toBeUndefined();
  });

  test("ignores an explicitly archived asset that shares the active selector identity", async () => {
    const repo = repository();
    const findAssets = repo.findAssets;
    repo.findAssets = async (kind, selector) => {
      const active = await findAssets(kind, selector);
      if (kind !== "spack-package" || !active[0]) return active;
      return [
        {
          ...active[0],
          id: "22222222-2222-4222-8222-222222222224",
          lifecycle: "archived",
          visibility: "hidden",
        },
        ...active,
      ];
    };
    const resolver = new WorkflowNamedReferenceResolver(repo, {
      assertUse: async () => undefined,
    });

    const resolved = await resolver.resolve(workflow, principal);
    const node = resolved.spec.nodeDrafts[0];
    if (!node || node.type !== "SoftwareUsecaseComputing") throw new Error("missing node");

    expect(node.softwareVersionId).toBe(SOFTWARE_REVISION_ID);
    expect(node.frozenAssetRevisions?.software.assetId).toBe(SOFTWARE_ASSET_ID);
  });

  test("rejects a named usecase whose pinned software selector differs from the workflow node", async () => {
    const repo = repository();
    const original = repo.findLatestRevision;
    repo.findLatestRevision = async (assetId) => {
      const revision = await original(assetId);
      if (assetId !== USECASE_ASSET_ID || !revision) return revision;
      return {
        ...revision,
        payload: {
          ...revision.payload,
          spec: {
            ...(revision.payload.spec as Record<string, unknown>),
            softwareRef: {
              source: "official-upstream",
              name: "lammps",
              version: "20250612",
            },
          },
        },
      };
    };
    const resolver = new WorkflowNamedReferenceResolver(repo, { assertUse: async () => undefined });

    await expect(resolver.resolve(workflow, principal)).rejects.toThrow(
      "does not match the node softwareRef",
    );
  });

  test("fails closed when the canonical principal lacks use permission", async () => {
    const resolver = new WorkflowNamedReferenceResolver(repository(), {
      assertUse: async () => {
        throw new Error("principal lacks use permission");
      },
    });

    await expect(resolver.resolve(workflow, principal)).rejects.toThrow(
      "principal lacks use permission",
    );
  });

  test("keeps the official runtime contract logical while freezing the script revision", async () => {
    const scriptId = "44444444-4444-4444-8444-444444444444";
    const scriptRevisionId = "44444444-4444-4444-8444-444444444445";
    const script = workflowDsl.WorkflowSchema.parse({
      name: "official-runtime-contract",
      parameters: [],
      spec: {
        nodeDrafts: [
          {
            type: "Script",
            id: "script",
            name: "script",
            scriptRef: { source: "official-upstream", name: "clean", version: "1.0.0" },
            runtimeContractRef: { name: "python-stdlib", version: "3.12-v1" },
          },
        ],
        nodeRelations: [],
      },
    });
    const resolver = new WorkflowNamedReferenceResolver(
      {
        ...repository(),
        findAssets: async (kind, selector) => [
          {
            id: scriptId,
            kind,
            source: selector.source,
            name: selector.name,
            version: selector.version,
            providerOrgId: null,
            lifecycle: "published",
            visibility: "platform-public",
            payload: {},
          },
        ],
        findLatestRevision: async () => ({
          id: scriptRevisionId,
          assetId: scriptId,
          revision: 2,
          payload: {
            kind: "sandbox-script",
            language: "python",
            entrypoint: "main.py",
            content: "print('ok')",
            sha256: "a".repeat(64),
            runtimeContractRef: { name: "python-stdlib", version: "3.12-v1" },
          },
        }),
      },
      { assertUse: async () => undefined },
    );

    const resolved = await resolver.resolve(script, principal);
    const node = resolved.spec.nodeDrafts[0];
    if (!node || node.type !== "Script") throw new Error("missing script node");

    expect(node.source).toMatchObject({
      type: "AssetRevision",
      assetId: scriptId,
      assetRevisionId: scriptRevisionId,
      revision: 2,
    });
    expect(node.runtimeContractRef).toEqual({ name: "python-stdlib", version: "3.12-v1" });
    expect(node.runtimeProfileId).toBeUndefined();
  });
});
