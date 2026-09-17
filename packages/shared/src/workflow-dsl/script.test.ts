import { describe, expect, test } from "bun:test";
import { WorkflowNodeSchema } from "./node";
import { ReducerSchema } from "./reduce";
import { ScriptOutputSpecSchema, ScriptSourceSchema } from "./script";

const ASSET_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MAPPING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function inlineScriptNode() {
  return {
    type: "Script",
    id: "transform",
    name: "Transform",
    source: { type: "Inline", language: "python", content: "pass" },
    runtimeProfileId: ASSET_ID,
  };
}

describe("Script canonical contract", () => {
  test("accepts inline source with an explicit runtime and canonical defaults", () => {
    expect(WorkflowNodeSchema.parse(inlineScriptNode())).toMatchObject({
      ...inlineScriptNode(),
      executionIdentity: { type: "Inherit" },
      schedulingStrategy: { type: "Auto" },
      inputs: {},
      outputs: {},
    });
  });

  test("accepts an asset revision with pinned hash and mapped account", () => {
    const node = WorkflowNodeSchema.parse({
      type: "Script",
      id: "transform",
      name: "Transform",
      source: {
        type: "AssetRevision",
        assetId: ASSET_ID,
        revision: 3,
        sha256: "a".repeat(64),
      },
      runtimeProfileId: ASSET_ID,
      executionIdentity: { type: "MappedAccount", mappingId: MAPPING_ID },
      schedulingStrategy: { type: "Auto" },
      inputs: { source: { type: "JSON" } },
      outputs: {
        result: {
          type: "File",
          locality: { type: "FollowConsumer" },
          durability: "Checkpoint",
          sizeHint: { type: "InputRatio", input: "source", ratio: 0.1 },
        },
      },
    });

    expect(node).toMatchObject({
      type: "Script",
      executionIdentity: { type: "MappedAccount", mappingId: MAPPING_ID },
      inputs: { source: { type: "JSON", required: true } },
      outputs: { result: { durability: "Checkpoint" } },
    });
  });

  test("defaults output governance fields", () => {
    expect(ScriptOutputSpecSchema.parse({ type: "Text" })).toEqual({
      type: "Text",
      required: true,
      validator: undefined,
      locality: { type: "Auto" },
      durability: "Ephemeral",
      sizeHint: { type: "SizeClass", value: "Unknown" },
    });
  });

  test("requires a lowercase digest for asset revisions", () => {
    expect(() =>
      ScriptSourceSchema.parse({
        type: "AssetRevision",
        assetId: ASSET_ID,
        revision: 1,
        sha256: "A".repeat(64),
      }),
    ).toThrow();
  });

  test("accepts logical script and runtime contract references", () => {
    const node = WorkflowNodeSchema.parse({
      type: "Script",
      id: "summary",
      name: "Summary",
      scriptRef: {
        source: "official-upstream",
        name: "gromacs-md-summary",
        version: "1.0.0",
      },
      runtimeContractRef: { name: "python-stdlib", version: "3.12-v1" },
      executionIdentity: { type: "MappedAuto" },
    });
    expect(node.type).toBe("Script");
    if (node.type === "Script" && "runtimeContractRef" in node) {
      expect(node.runtimeContractRef).toEqual({ name: "python-stdlib", version: "3.12-v1" });
    }
  });

  test("rejects a script node that mixes runtime contract and profile references", () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        type: "Script",
        id: "summary",
        name: "Summary",
        source: { type: "Inline", language: "python", content: "pass" },
        runtimeProfileId: ASSET_ID,
        runtimeContractRef: { name: "python-stdlib", version: "3.12-v1" },
      }),
    ).toThrow();
  });

  test.each(["kind", "origin", "inputPath", "outputPath"])("rejects unknown field %s", (field) => {
    expect(WorkflowNodeSchema.safeParse({ ...inlineScriptNode(), [field]: {} }).success).toBe(
      false,
    );
  });

  test.each(["source", "runtimeProfileId"])("rejects a missing canonical %s", (field) => {
    expect(
      WorkflowNodeSchema.safeParse({ ...inlineScriptNode(), [field]: undefined }).success,
    ).toBe(false);
  });

  test("rejects unknown inline source fields", () => {
    expect(
      ScriptSourceSchema.safeParse({ ...inlineScriptNode().source, provenance: {} }).success,
    ).toBe(false);
  });
});

describe("Reduce Command script origins", () => {
  test.each([
    { type: "Edit", content: "print('summary')" },
    { type: "Git", url: "https://git.example/research/reducer.git" },
  ])("preserves the current $type origin contract", (script) => {
    expect(ReducerSchema.parse({ kind: "Command", script })).toEqual({ kind: "Command", script });
  });
});
