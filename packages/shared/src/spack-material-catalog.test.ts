import { describe, expect, test } from "bun:test";
import {
  SpackMaterialCatalogQuerySchema,
  SpackMaterialCatalogSchema,
  type SpackMaterialSummary,
  SpackMaterialSummarySchema,
} from "./spack-material-catalog";

const summary: SpackMaterialSummary = {
  repositoryId: "a".repeat(64),
  manifestDigest: `sha256:${"b".repeat(64)}`,
  repository: "org/provider/materials",
  spec: "hello@1.0",
  spackVersion: "1.0.0",
  target: "linux-ubuntu24.04-x86_64",
  redistribution: "unrestricted",
  sourceCount: 2,
  totalBytes: 1024,
};

describe("material catalog contracts", () => {
  test("accepts an empty catalog, compact summary and exact repository filter", () => {
    expect(SpackMaterialCatalogSchema.parse({ releases: [] })).toEqual({ releases: [] });
    expect(SpackMaterialSummarySchema.parse(summary)).toEqual(summary);
    expect(SpackMaterialCatalogQuerySchema.parse({})).toEqual({});
    expect(SpackMaterialCatalogQuerySchema.parse({ repository: "public/materials" })).toEqual({
      repository: "public/materials",
    });
  });

  test.each([
    { repository: "" },
    { repository: "https://example.test/repository" },
    { repository: "/tmp/materials" },
    { repository: "public/../materials" },
    { repository: ["public/materials"] },
    { limit: 1 },
    { cursor: "guessed" },
    { url: "https://example.test" },
  ])("rejects ambiguous or unsupported queries: %j", (query) => {
    expect(SpackMaterialCatalogQuerySchema.safeParse(query).success).toBe(false);
  });

  test.each([
    { repositoryId: "../other" },
    { manifestDigest: "b".repeat(64) },
    { repository: "private" },
    { redistribution: "restricted" },
    { sourceCount: 0 },
    { sourceCount: 10_001 },
    { sourceCount: 1.5 },
    { totalBytes: -1 },
    { totalBytes: 512 * 1024 ** 3 + 1 },
    { downloadUrl: "https://example.test" },
    { sources: [] },
    { recipes: [] },
  ])("rejects invalid or expanded summaries: %j", (patch) => {
    expect(SpackMaterialSummarySchema.safeParse({ ...summary, ...patch }).success).toBe(false);
  });

  test("bounds the response without permitting unknown count or pagination fields", () => {
    expect(
      SpackMaterialCatalogSchema.safeParse({ releases: Array(201).fill(summary) }).success,
    ).toBe(false);
    expect(SpackMaterialCatalogSchema.safeParse({ releases: [], hiddenCount: 1 }).success).toBe(
      false,
    );
  });
});
