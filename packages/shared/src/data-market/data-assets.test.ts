import { describe, expect, test } from "bun:test";
import {
  bindingRequiresRestrictedNoEgress,
  DataAssetKindSchema,
  DataAssetLifecycleSchema,
  DataAssetVersionStatusSchema,
  DataInputRefSchema,
  DataLocationKindSchema,
  DataVisibilitySchema,
  ResolvedDataBindingSchema,
} from "./data-assets";

describe("data-market input references", () => {
  test("accepts an explicit data-market reference", () => {
    const input = DataInputRefSchema.parse({
      source: "data-market",
      assetId: "00000000-0000-4000-8000-000000000001",
      versionId: "00000000-0000-4000-8000-000000000002",
      manifestDigest: "sha256:manifest",
    });

    expect(input).toMatchObject({ source: "data-market" });
  });

  test("normalizes legacy file metadata inputs to netdrive", () => {
    expect(
      DataInputRefSchema.parse({
        fileMetadataId: "00000000-0000-4000-8000-000000000001",
        fileMetadataName: "reads.fastq.gz",
      }),
    ).toEqual({
      source: "netdrive",
      fileMetadataId: "00000000-0000-4000-8000-000000000001",
      fileMetadataName: "reads.fastq.gz",
    });
  });

  test("rejects Data Market delivery paths that can escape the managed job root", () => {
    for (const targetPath of [
      "/absolute/POTCAR",
      "inputs\\POTCAR",
      "inputs//POTCAR",
      "../POTCAR",
    ]) {
      expect(() =>
        DataInputRefSchema.parse({
          source: "data-market",
          assetId: "00000000-0000-4000-8000-000000000001",
          versionId: "00000000-0000-4000-8000-000000000002",
          manifestDigest: "sha256:manifest",
          targetPath,
        }),
      ).toThrow();
    }
  });

  test("rejects non-canonical immutable manifest entry selections", () => {
    for (const selectedEntry of [
      "/POTCAR",
      "inputs\\POTCAR",
      "inputs//POTCAR",
      "./POTCAR",
      "../POTCAR",
    ]) {
      expect(() =>
        DataInputRefSchema.parse({
          source: "data-market",
          assetId: "00000000-0000-4000-8000-000000000001",
          versionId: "00000000-0000-4000-8000-000000000002",
          manifestDigest: "sha256:manifest",
          selectedEntries: [selectedEntry],
        }),
      ).toThrow();
    }
  });

  test("requires full resolved data-market bindings", () => {
    expect(() =>
      ResolvedDataBindingSchema.parse({
        input: {
          source: "data-market",
          assetId: "00000000-0000-4000-8000-000000000001",
          versionId: "00000000-0000-4000-8000-000000000002",
          manifestDigest: "sha256:manifest",
        },
        assetId: null,
        versionId: null,
        manifestDigest: null,
        allowedLocationIds: [],
        deliveryPolicy: {},
        stagePath: "inputs/data.csv",
      }),
    ).toThrow();
  });

  test("uses the confirmed data-market enumerations", () => {
    expect(DataAssetKindSchema.options).toEqual([
      "training-dataset",
      "scientific-dataset",
      "reference-data",
      "model-artifact",
      "pseudopotential",
      "licensed-material",
    ]);
    expect(DataAssetLifecycleSchema.options).not.toContain("archived");
    expect(DataAssetVersionStatusSchema.options).toContain("validating");
    expect(DataLocationKindSchema.options).toEqual([
      "platform-object",
      "user-private-object",
      "cp-local",
    ]);
    expect(DataVisibilitySchema.options).toEqual(["public", "organization", "private"]);
  });

  test("requires no-egress for redistribution-denied licensed or restricted data", () => {
    const base = {
      input: {
        source: "data-market" as const,
        assetId: "00000000-0000-4000-8000-000000000001",
        versionId: "00000000-0000-4000-8000-000000000002",
        manifestDigest: "sha256:manifest",
        selectedEntries: [],
      },
      assetId: "00000000-0000-4000-8000-000000000001",
      versionId: "00000000-0000-4000-8000-000000000002",
      manifestDigest: "sha256:manifest",
      selectedEntries: [],
      allowedLocationIds: [],
      deliveryPolicy: {},
      stagePath: "inputs/data",
      egressPolicy: "deny" as const,
    };
    const licensed = ResolvedDataBindingSchema.parse({
      ...base,
      assetKind: "licensed-material",
      sensitivity: "internal",
    });
    const restricted = ResolvedDataBindingSchema.parse({
      ...base,
      assetKind: "scientific-dataset",
      sensitivity: "restricted",
    });
    const redistributable = ResolvedDataBindingSchema.parse({
      ...base,
      assetKind: "scientific-dataset",
      sensitivity: "restricted",
      egressPolicy: "allow",
    });

    expect(bindingRequiresRestrictedNoEgress(licensed)).toBe(true);
    expect(bindingRequiresRestrictedNoEgress(restricted)).toBe(true);
    expect(bindingRequiresRestrictedNoEgress(redistributable)).toBe(false);
  });
});
