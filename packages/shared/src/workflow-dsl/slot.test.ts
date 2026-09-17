import { describe, expect, test } from "bun:test";
import { NodeInputSlotSchema, NodeOutputSlotSchema, NodeRelationSchema } from "./slot";

describe("NodeInputSlotSchema", () => {
  test("accepts a Text slot bound to a loop.item expression", () => {
    const r = NodeInputSlotSchema.parse({
      type: "Text",
      descriptor: "caseParams",
      from: { expr: "loop.item" },
    });
    expect(r.type).toBe("Text");
  });

  test("accepts a File slot with consumer-side sources + select", () => {
    const r = NodeInputSlotSchema.parse({
      type: "File",
      descriptor: "solverOut",
      isBatch: false,
      sources: [
        { node: "small", output: "result" },
        { node: "large", output: "result" },
      ],
      select: "RequireExactlyOne",
    });
    expect(r.type).toBe("File");
  });

  test("accepts a Dataset slot with an immutable DataInputRef", () => {
    const r = NodeInputSlotSchema.parse({
      type: "Dataset",
      descriptor: "trainingData",
      contents: {
        source: "data-market",
        assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        manifestDigest: `sha256:${"a".repeat(64)}`,
        selectedEntries: ["train/data.parquet"],
        targetPath: "inputs/training",
      },
    });

    expect(r).toMatchObject({
      type: "Dataset",
      descriptor: "trainingData",
      contents: {
        source: "data-market",
        selectedEntries: ["train/data.parquet"],
        targetPath: "inputs/training",
      },
    });
  });

  test("rejects dynamic bindings on Dataset input slots", () => {
    expect(() =>
      NodeInputSlotSchema.parse({
        type: "Dataset",
        descriptor: "trainingData",
        from: { node: "prepare", output: "dataset" },
      }),
    ).toThrow("Dataset input slots only support static `contents` bindings");
    expect(() =>
      NodeInputSlotSchema.parse({
        type: "Dataset",
        descriptor: "trainingData",
        sources: [{ node: "prepare", output: "dataset" }],
        select: "FirstAvailable",
      }),
    ).toThrow("Dataset input slots only support static `contents` bindings");
  });

  test("rejects an unknown slot type", () => {
    expect(() => NodeInputSlotSchema.parse({ type: "Blob", descriptor: "x" })).toThrow();
  });

  test("rejects an invalid select strategy", () => {
    expect(() =>
      NodeInputSlotSchema.parse({
        type: "File",
        descriptor: "x",
        sources: [{ node: "a", output: "o" }],
        select: "Whatever",
      }),
    ).toThrow();
  });

  test("rejects select without sources", () => {
    expect(() =>
      NodeInputSlotSchema.parse({
        type: "Text",
        descriptor: "x",
        select: "FirstAvailable",
      }),
    ).toThrow();
  });

  test("rejects empty sources", () => {
    expect(() =>
      NodeInputSlotSchema.parse({
        type: "Text",
        descriptor: "x",
        sources: [],
      }),
    ).toThrow();
  });

  test("rejects from and sources on the same input slot", () => {
    expect(() =>
      NodeInputSlotSchema.parse({
        type: "Text",
        descriptor: "x",
        from: { expr: "params.x" },
        sources: [{ node: "a", output: "o" }],
      }),
    ).toThrow();
  });

  test("rejects contents with a dynamic binding on the same input slot", () => {
    expect(() =>
      NodeInputSlotSchema.parse({
        type: "File",
        descriptor: "x",
        isBatch: false,
        from: { node: "a", output: "o" },
        contents: [
          {
            fileMetadataId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            fileMetadataName: "input.dat",
            hash: "sha256:abc",
            size: 12,
          },
        ],
      }),
    ).toThrow();
  });

  test("rejects Dataset contents with consumer-side sources", () => {
    expect(() =>
      NodeInputSlotSchema.parse({
        type: "Dataset",
        descriptor: "trainingData",
        contents: {
          source: "data-market",
          assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          manifestDigest: `sha256:${"a".repeat(64)}`,
        },
        sources: [{ node: "prepare", output: "dataset" }],
      }),
    ).toThrow("input slot must use only one of `from`, `sources`, or `contents`");
  });
});

describe("NodeOutputSlotSchema", () => {
  test("accepts a File output with origin + isBatch", () => {
    const r = NodeOutputSlotSchema.parse({
      type: "File",
      descriptor: "result",
      origin: "UsecaseOut",
      isBatch: false,
    });
    expect(r.type).toBe("File");
  });

  test("rejects a File output missing origin", () => {
    expect(() =>
      NodeOutputSlotSchema.parse({ type: "File", descriptor: "result", isBatch: false }),
    ).toThrow();
  });
});

describe("NodeRelationSchema", () => {
  test("accepts an edge with slot relations and an optional when", () => {
    const r = NodeRelationSchema.parse({
      fromId: "gen",
      toId: "solve",
      when: { expr: "true" },
      slotRelations: [{ fromSlot: "a", toSlot: "b", transferStrategy: { type: "Disk" } }],
    });
    expect(r.slotRelations.length).toBe(1);
  });

  test("accepts a dependency-only edge with empty slotRelations", () => {
    expect(
      NodeRelationSchema.parse({ fromId: "a", toId: "b", slotRelations: [] }).slotRelations.length,
    ).toBe(0);
  });
});
