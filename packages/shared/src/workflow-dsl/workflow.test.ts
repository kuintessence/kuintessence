import { describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";
import { ParameterSchema, WorkflowSchema } from "./workflow";

const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const suc = (id: string) => ({
  type: "SoftwareUsecaseComputing",
  id,
  name: id,
  usecaseVersionId: UUID,
  softwareVersionId: UUID,
});

describe("WorkflowSchema", () => {
  test("accepts a minimal workflow and defaults parameters to []", () => {
    const r = WorkflowSchema.parse({
      name: "w",
      spec: { nodeDrafts: [suc("a")] },
    });
    expect(r.parameters).toEqual([]);
  });

  test("rejects an empty workflow name", () => {
    expect(() => WorkflowSchema.parse({ name: "", spec: { nodeDrafts: [suc("a")] } })).toThrow();
  });

  test("rejects unknown top-level fields", () => {
    expect(() =>
      WorkflowSchema.parse({
        name: "w",
        spec: { nodeDrafts: [suc("a")] },
        bogus: 1,
      }),
    ).toThrow();
  });

  test("round-trips a node-level Dataset binding through YAML", () => {
    const yaml = `name: dataset-workflow
spec:
  nodeDrafts:
    - type: SoftwareUsecaseComputing
      id: train
      name: Train
      usecaseVersionId: ${UUID}
      softwareVersionId: ${UUID}
      inputSlots:
        - type: Dataset
          descriptor: trainingData
          contents:
            source: data-market
            assetId: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
            versionId: cccccccc-cccc-4ccc-8ccc-cccccccccccc
            manifestDigest: sha256:${"a".repeat(64)}
            selectedEntries:
              - train/data.parquet
            targetPath: inputs/training
`;

    const parsed = WorkflowSchema.parse(parse(yaml));
    const roundTripped = WorkflowSchema.parse(parse(stringify(parsed)));
    const firstNode = roundTripped.spec.nodeDrafts[0];
    const slot =
      firstNode?.type === "SoftwareUsecaseComputing" ? firstNode.inputSlots?.[0] : undefined;

    expect(slot).toMatchObject({
      type: "Dataset",
      descriptor: "trainingData",
      contents: {
        source: "data-market",
        assetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        versionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        selectedEntries: ["train/data.parquet"],
        targetPath: "inputs/training",
      },
    });
  });
});

describe("ParameterSchema", () => {
  test("accepts a typed parameter with a default", () => {
    const r = ParameterSchema.parse({ name: "maxIter", type: "int", default: 200 });
    expect(r.name).toBe("maxIter");
  });

  test("rejects a hyphenated parameter name", () => {
    expect(() => ParameterSchema.parse({ name: "max-iter", type: "int" })).toThrow();
  });
});
