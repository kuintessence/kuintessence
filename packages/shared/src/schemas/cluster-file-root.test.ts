import { describe, expect, test } from "bun:test";
import { ClusterFileRootCreateSchema, ClusterFileRootUpdateSchema } from "./cluster-file-root";

describe("ClusterFileRootCreateSchema", () => {
  test("accepts a provider-managed root", () => {
    const parsed = ClusterFileRootCreateSchema.parse({
      label: "Scratch",
      path: "/scratch",
      visibleOrgIds: ["11111111-1111-4111-8111-111111111111"],
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.visibleOrgIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  test("rejects relative paths", () => {
    const parsed = ClusterFileRootCreateSchema.safeParse({
      label: "etc",
      path: "etc",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("ClusterFileRootUpdateSchema", () => {
  test("accepts a partial disable patch", () => {
    const parsed = ClusterFileRootUpdateSchema.parse({ enabled: false });
    expect(parsed.enabled).toBe(false);
  });
});
