import { describe, expect, test } from "bun:test";
import { SpackMaterialLifecycleChangeSchema } from "./spack-material-lifecycle";

const change = { action: "withdraw", expectedRevision: 0, reason: "Source needs review" };

describe("material lifecycle change contract", () => {
  test.each(["withdraw", "restore"])(
    "accepts the exact %s command without rewriting it",
    (action) => {
      for (const expectedRevision of [0, 2_147_483_646]) {
        for (const reason of ["x", "Source needs review", "x".repeat(1000)]) {
          const input = { action, expectedRevision, reason };
          expect(SpackMaterialLifecycleChangeSchema.parse(input)).toEqual(input);
        }
      }
    },
  );

  test.each([
    null,
    [],
    {},
    { expectedRevision: 0, reason: "Review" },
    { action: "withdraw", reason: "Review" },
    { action: "withdraw", expectedRevision: 0 },
  ])("requires an object with all three fields: %j", (input) => {
    expect(SpackMaterialLifecycleChangeSchema.safeParse(input).success).toBe(false);
  });

  test.each([
    { action: "delete" },
    { action: "available" },
    { action: "WITHDRAW" },
    { action: null },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: 2_147_483_647 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    { expectedRevision: Number.NaN },
    { expectedRevision: Number.POSITIVE_INFINITY },
    { expectedRevision: "0" },
    { expectedRevision: null },
    { expectedRevision: true },
    { reason: null },
    { reason: 123 },
    { reason: "" },
    { reason: " " },
    { reason: " leading" },
    { reason: "trailing " },
    { reason: "\u00a0leading" },
    { reason: "trailing\u00a0" },
    { reason: "x".repeat(1001) },
    { role: "super_admin" },
    { orgIds: ["other-org"] },
    { orgId: "other-org" },
    { operatorId: "someone-else" },
    { url: "https://example.test/material" },
    { repositoryId: "a".repeat(64) },
    { state: "available" },
  ])("rejects invalid values and extra authority or locator fields: %j", (patch) => {
    expect(SpackMaterialLifecycleChangeSchema.safeParse({ ...change, ...patch }).success).toBe(
      false,
    );
  });

  test("rejects every ASCII control character even inside an otherwise valid reason", () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      const reason = `Review${String.fromCharCode(code)}required`;
      expect(SpackMaterialLifecycleChangeSchema.safeParse({ ...change, reason }).success).toBe(
        false,
      );
    }
  });
});
