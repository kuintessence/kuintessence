import { describe, expect, test } from "bun:test";
import {
  dataAssetGrantDeltaTuples,
  dataAssetGrantTuples,
  dataAssetPublicTuples,
} from "./projection";

describe("dataAssetGrantTuples", () => {
  test("maps every data capability to its SpiceDB relation", () => {
    expect(
      dataAssetGrantTuples({
        assetId: "asset-1",
        subjectKind: "user",
        subjectId: "user-1",
        capabilities: ["view", "use", "download", "derive", "manage"],
        operation: "create",
      }).map((tuple) => tuple.relation),
    ).toEqual(["viewer", "user", "downloader", "deriver", "manager"]);
  });
});

test("replaces data grant capabilities with a normalized delete/create delta", () => {
  expect(
    dataAssetGrantDeltaTuples({
      assetId: "asset-1",
      subjectKind: "user",
      subjectId: "user-1",
      previousCapabilities: ["view", "view", "unknown"],
      nextCapabilities: ["use", "use"],
    }),
  ).toEqual([
    {
      operation: "delete",
      resource: { type: "data_asset", id: "asset-1" },
      relation: "viewer",
      subject: { type: "user", id: "user-1" },
    },
    {
      operation: "create",
      resource: { type: "data_asset", id: "asset-1" },
      relation: "user",
      subject: { type: "user", id: "user-1" },
    },
  ]);
});

test("only projects provider-org data grants with the manage capability", () => {
  expect(
    dataAssetGrantTuples({
      assetId: "asset-1",
      subjectKind: "provider-org",
      subjectId: "provider-1",
      capabilities: ["view", "use", "manage"],
      operation: "create",
    }),
  ).toEqual([
    {
      operation: "create",
      resource: { type: "data_asset", id: "asset-1" },
      relation: "manager",
      subject: { type: "provider", id: "provider-1", relation: "manage" },
    },
  ]);
});

test("projects public open data for all platform members", () => {
  expect(dataAssetPublicTuples({ assetId: "asset-1", accessMode: "open" })).toContainEqual({
    operation: "create",
    resource: { type: "data_asset", id: "asset-1" },
    relation: "user",
    subject: { type: "platform", id: "root", relation: "software_use" },
  });
});

test("does not project request-gated public data to platform members", () => {
  expect(dataAssetPublicTuples({ assetId: "asset-1", accessMode: "request" })).toEqual([]);
});
