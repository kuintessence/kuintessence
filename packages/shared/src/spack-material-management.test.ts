import { describe, expect, test } from "bun:test";
import {
  SpackMaterialManagementCatalogSchema,
  SpackMaterialManagementQuerySchema,
} from "./spack-material-management";

const digest = `sha256:${"a".repeat(64)}`;
const cursor = `v1.${"a".repeat(64)}`;
const release = {
  repositoryId: "b".repeat(64),
  manifestDigest: digest,
  repository: "public/materials",
  spec: "hello@2.12.1",
  spackVersion: "0.23.1",
  target: "linux-ubuntu20.04-x86_64",
  redistribution: "unrestricted",
  sourceCount: 1,
  totalBytes: 1024,
  state: "available",
  revision: 0,
};

describe("Spack material management contracts", () => {
  test("requires an exact repository and applies bounded defaults", () => {
    expect(SpackMaterialManagementQuerySchema.parse({ repository: "public/materials" })).toEqual({
      repository: "public/materials",
      state: "all",
      limit: 10,
    });
    expect(SpackMaterialManagementQuerySchema.safeParse({}).success).toBe(false);
  });

  test.each([
    { repository: "../private" },
    { state: "hidden" },
    { after: "a".repeat(64) },
    { limit: 0 },
    { limit: 21 },
    { limit: 1.5 },
    { limit: "10" },
    { principal: "admin" },
  ])("rejects invalid or extra input %j", (input) => {
    expect(
      SpackMaterialManagementQuerySchema.safeParse({ repository: "public/materials", ...input })
        .success,
    ).toBe(false);
  });

  test("permits an empty filtered page with a continuation cursor", () => {
    expect(
      SpackMaterialManagementCatalogSchema.parse({ releases: [], nextCursor: cursor }),
    ).toEqual({ releases: [], nextCursor: cursor });
  });

  test("accepts available and withdrawn summaries without audit data", () => {
    for (const summary of [release, { ...release, state: "withdrawn", revision: 1 }]) {
      expect(
        SpackMaterialManagementCatalogSchema.safeParse({
          releases: [summary],
          nextCursor: null,
        }).success,
      ).toBe(true);
    }
  });

  test.each([
    { state: "withdrawn" },
    { revision: -1 },
    { revision: 2_147_483_648 },
    { revision: 0.1 },
    { history: [] },
    { reason: "Private audit reason" },
  ])("rejects invalid states or extra release fields %j", (input) => {
    expect(
      SpackMaterialManagementCatalogSchema.safeParse({
        releases: [{ ...release, ...input }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  test("bounds page size and rejects unknown response fields", () => {
    expect(
      SpackMaterialManagementCatalogSchema.safeParse({
        releases: Array.from({ length: 21 }, () => release),
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      SpackMaterialManagementCatalogSchema.safeParse({
        releases: [],
        nextCursor: null,
        total: 5,
      }).success,
    ).toBe(false);
  });
});
