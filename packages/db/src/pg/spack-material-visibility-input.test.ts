import { describe, expect, test } from "bun:test";
import {
  parseSpackMaterialVisibilityChange,
  parseSpackMaterialVisibilityPolicy,
  type SpackMaterialVisibilityChange,
  type SpackMaterialVisibilityPolicy,
} from "./spack-material-visibility-input";

const FIRST = "00000000-0000-4000-8000-000000000001";
const SECOND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THIRD = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const POLICY: SpackMaterialVisibilityPolicy = {
  mode: "allowlist",
  userIds: [FIRST],
  orgIds: [SECOND],
};
const CHANGE: SpackMaterialVisibilityChange = {
  policy: POLICY,
  expectedRevision: 0,
  reason: "Update admission policy",
};
const ids = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  );

describe("Spack material visibility input", () => {
  test("accepts inherit, empty allowlists and independently bounded identity lists", () => {
    expect(parseSpackMaterialVisibilityPolicy({ mode: "inherit" })).toEqual({ mode: "inherit" });
    expect(
      parseSpackMaterialVisibilityPolicy({ mode: "allowlist", userIds: [], orgIds: [] }),
    ).toEqual({ mode: "allowlist", userIds: [], orgIds: [] });
    const policy: SpackMaterialVisibilityPolicy = {
      mode: "allowlist",
      userIds: ids(100),
      orgIds: ids(100),
    };
    expect(parseSpackMaterialVisibilityPolicy(policy)).toEqual(policy);
  });

  test("sorts both lists and copies policy and change before asynchronous use", () => {
    const input = {
      policy: { mode: "allowlist", userIds: [THIRD, FIRST], orgIds: [SECOND, FIRST] },
      expectedRevision: 3,
      reason: "Original reason",
    };
    const parsed = parseSpackMaterialVisibilityChange(input);
    expect(parsed).toEqual({
      policy: { mode: "allowlist", userIds: [FIRST, THIRD], orgIds: [FIRST, SECOND] },
      expectedRevision: 3,
      reason: "Original reason",
    });
    expect(input.policy.userIds).toEqual([THIRD, FIRST]);
    expect(input.policy.orgIds).toEqual([SECOND, FIRST]);
    input.policy.userIds.splice(0);
    input.policy.orgIds.push(THIRD);
    input.expectedRevision = 99;
    input.reason = "Changed reason";
    expect(parsed).toEqual({
      policy: { mode: "allowlist", userIds: [FIRST, THIRD], orgIds: [FIRST, SECOND] },
      expectedRevision: 3,
      reason: "Original reason",
    });
  });

  test.each(
    [
      null,
      undefined,
      [],
      "inherit",
      {},
      { mode: "public" },
      { mode: "inherit", userIds: [] },
      { mode: "inherit", [Symbol("hidden")]: true },
      { mode: "allowlist", userIds: [] },
      { mode: "allowlist", orgIds: [] },
      { ...POLICY, unknown: true },
      Object.assign(Object.create(null), { mode: "inherit" }),
      Object.assign(Object.create({ inherited: true }), { mode: "inherit" }),
    ].map((input: unknown) => ({ input })),
  )("rejects non-exact policy objects (%j)", ({ input }) => {
    expect(() => parseSpackMaterialVisibilityPolicy(input)).toThrow();
  });

  test.each(
    [
      undefined,
      null,
      FIRST,
      {},
      [null],
      [1],
      [FIRST, FIRST],
      [SECOND.toUpperCase()],
      [` ${FIRST}`],
      [`${FIRST} `],
      [FIRST.replaceAll("-", "")],
      ["not-a-uuid"],
      new Array(1),
      ids(101),
    ].map((values: unknown) => ({ values })),
  )("rejects malformed user and org identifier lists (%j)", ({ values }) => {
    for (const key of ["userIds", "orgIds"]) {
      expect(() => parseSpackMaterialVisibilityPolicy({ ...POLICY, [key]: values })).toThrow();
    }
  });

  test.each([
    0, 2_147_483_646,
  ])("accepts bounded revision %s and a 1000-character reason", (revision) => {
    const input: SpackMaterialVisibilityChange = {
      ...CHANGE,
      expectedRevision: revision,
      reason: "x".repeat(1000),
    };
    expect(parseSpackMaterialVisibilityChange(input)).toEqual(input);
  });

  test.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_647,
    "0",
    null,
  ])("rejects invalid CAS revision (%j)", (expectedRevision: unknown) => {
    expect(() => parseSpackMaterialVisibilityChange({ ...CHANGE, expectedRevision })).toThrow();
  });

  test.each([
    "",
    " ",
    " padded",
    "padded ",
    "x".repeat(1001),
    "a\nb",
    "a\tb",
    "a\0b",
    "a\x7fb",
    null,
    1,
  ])("rejects invalid audit reason (%j)", (reason: unknown) => {
    expect(() => parseSpackMaterialVisibilityChange({ ...CHANGE, reason })).toThrow();
  });

  test.each(
    [
      null,
      [],
      { policy: POLICY, expectedRevision: 0 },
      { policy: POLICY, reason: CHANGE.reason },
      { expectedRevision: 0, reason: CHANGE.reason },
      { ...CHANGE, actor: FIRST },
      { ...CHANGE, [Symbol("hidden")]: true },
      { ...CHANGE, policy: { mode: "inherit", userIds: [] } },
      Object.assign(Object.create(null), CHANGE),
      Object.assign(Object.create({ inherited: true }), CHANGE),
    ].map((input: unknown) => ({ input })),
  )("rejects non-exact change objects (%j)", ({ input }) => {
    expect(() => parseSpackMaterialVisibilityChange(input)).toThrow();
  });
});
