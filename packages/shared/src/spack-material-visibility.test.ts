import { describe, expect, test } from "bun:test";
import {
  SpackMaterialVisibilityChangeSchema,
  type SpackMaterialVisibilityPolicy,
  SpackMaterialVisibilityPolicySchema,
  type SpackMaterialVisibilityView,
  SpackMaterialVisibilityViewSchema,
} from "./spack-material-visibility";

const first = "11111111-1111-1111-1111-111111111111";
const second = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const policy: SpackMaterialVisibilityPolicy = {
  mode: "allowlist",
  userIds: [first, second],
  orgIds: [first],
};
const change = { policy, expectedRevision: 0, reason: "Restrict source access" };
const principal = (index: number) =>
  `${index.toString(16).padStart(8, "0")}-1111-1111-1111-111111111111`;

function view(revision = 0): SpackMaterialVisibilityView {
  const current: SpackMaterialVisibilityPolicy = revision % 2 ? policy : { mode: "inherit" };
  return {
    binding: { repositoryId: "a".repeat(64), manifestDigest: `sha256:${"b".repeat(64)}` },
    repository: "org/research/sources",
    revision,
    policy: current,
    history: Array.from({ length: Math.min(revision, 100) }, (_, index) => ({
      revision: revision - index,
      policy: (revision - index) % 2 ? policy : { mode: "inherit" },
      operatorId: first,
      reason: change.reason,
      epoch: "22222222-2222-4222-8222-222222222222",
      rolloutRevision: 2,
      createdAt: "2026-09-21T00:00:00.000Z",
    })),
    historyTruncated: revision > 100,
  };
}

describe("visibility policy and command", () => {
  test.each([
    { mode: "inherit" },
    { mode: "allowlist", userIds: [], orgIds: [] },
    policy,
    {
      mode: "allowlist",
      userIds: Array.from({ length: 100 }, (_, index) => principal(index)),
      orgIds: Array.from({ length: 100 }, (_, index) => principal(index)),
    },
  ])("accepts bounded canonical policies, including deny-all: %j", (input) => {
    expect(SpackMaterialVisibilityPolicySchema.parse(input)).toEqual(input);
    expect(SpackMaterialVisibilityChangeSchema.parse({ ...change, policy: input }).policy).toEqual(
      input,
    );
  });

  test("normalizes only command ordering, without mutating inputs or weakening response checks", () => {
    const input = { mode: "allowlist", userIds: [second, first], orgIds: [second, first] };
    const expected = { mode: "allowlist", userIds: [first, second], orgIds: [first, second] };
    expect(SpackMaterialVisibilityChangeSchema.parse({ ...change, policy: input }).policy).toEqual(
      expected,
    );
    expect(input.userIds).toEqual([second, first]);
    expect(input.orgIds).toEqual([second, first]);
    expect(SpackMaterialVisibilityPolicySchema.safeParse(input).success).toBe(false);
  });

  test.each([
    null,
    {},
    { mode: "public" },
    { mode: "inherit", userIds: [] },
    { mode: "allowlist", userIds: [] },
    { mode: "allowlist", userIds: [], orgIds: [], enabled: true },
    { mode: "allowlist", userIds: ["not-a-uuid"], orgIds: [] },
    { mode: "allowlist", userIds: [second.toUpperCase()], orgIds: [] },
    { mode: "allowlist", userIds: [first, first], orgIds: [] },
    { mode: "allowlist", userIds: [], orgIds: [first, first] },
    { mode: "allowlist", userIds: [], orgIds: [second.toUpperCase()] },
    { mode: "allowlist", userIds: Array.from({ length: 101 }, (_, i) => principal(i)), orgIds: [] },
    { mode: "allowlist", userIds: [], orgIds: Array.from({ length: 101 }, (_, i) => principal(i)) },
    { mode: "allowlist", userIds: first, orgIds: [] },
    { mode: "allowlist", userIds: [], orgIds: [null] },
  ])("rejects invalid policies at both boundaries: %j", (input) => {
    expect(SpackMaterialVisibilityPolicySchema.safeParse(input).success).toBe(false);
    expect(
      SpackMaterialVisibilityChangeSchema.safeParse({ ...change, policy: input }).success,
    ).toBe(false);
  });

  test.each([
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: "0" },
    { expectedRevision: 2_147_483_647 },
    { reason: "" },
    { reason: " leading" },
    { reason: "trailing " },
    { reason: "line\nbreak" },
    { reason: "x".repeat(1001) },
    { operatorId: first },
    { enabled: true },
  ])("rejects malformed commands: %j", (patch) => {
    expect(SpackMaterialVisibilityChangeSchema.safeParse({ ...change, ...patch }).success).toBe(
      false,
    );
  });

  test("requires all command fields and rejects ASCII controls", () => {
    for (const key of Object.keys(change)) {
      const input = Object.fromEntries(Object.entries(change).filter(([field]) => field !== key));
      expect(SpackMaterialVisibilityChangeSchema.safeParse(input).success).toBe(false);
    }
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      expect(
        SpackMaterialVisibilityChangeSchema.safeParse({
          ...change,
          reason: `Audit${String.fromCharCode(code)}reason`,
        }).success,
      ).toBe(false);
    }
    expect(
      SpackMaterialVisibilityChangeSchema.parse({
        ...change,
        expectedRevision: 2_147_483_646,
        reason: "x".repeat(1000),
      }).expectedRevision,
    ).toBe(2_147_483_646);
  });
});

describe("visibility view", () => {
  test.each([0, 1, 2, 99, 100, 101, 2_147_483_647])("accepts revision %i", (revision) => {
    expect(SpackMaterialVisibilityViewSchema.parse(view(revision))).toEqual(view(revision));
  });

  test("requires all view and audit fields", () => {
    const snapshot = view(1);
    for (const key of Object.keys(snapshot)) {
      const input = Object.fromEntries(Object.entries(snapshot).filter(([field]) => field !== key));
      expect(SpackMaterialVisibilityViewSchema.safeParse(input).success).toBe(false);
    }
    const event = snapshot.history[0];
    if (!event) throw new Error("Missing audit fixture");
    for (const key of Object.keys(event)) {
      const entry = Object.fromEntries(Object.entries(event).filter(([field]) => field !== key));
      expect(
        SpackMaterialVisibilityViewSchema.safeParse({ ...snapshot, history: [entry] }).success,
      ).toBe(false);
    }
  });

  test.each([
    { revision: -1 },
    { revision: 0.5 },
    { revision: 2_147_483_648 },
    { policy },
    { historyTruncated: true },
    { binding: { repositoryId: "../bad", manifestDigest: "bad" } },
    { repository: "https://example.test" },
    { enabled: true },
  ])("rejects invalid initial snapshots: %j", (patch) => {
    expect(SpackMaterialVisibilityViewSchema.safeParse({ ...view(), ...patch }).success).toBe(
      false,
    );
  });

  test("rejects mismatched, unsorted and malformed current or historical policies", () => {
    const snapshot = view(1);
    const unsorted = { mode: "allowlist", userIds: [second, first], orgIds: [] };
    for (const patch of [
      { policy: { mode: "inherit" } },
      { policy: unsorted },
      { policy: unsorted, history: [{ ...snapshot.history[0], policy: unsorted }] },
      { history: [{ ...snapshot.history[0], policy: { ...policy, orgIds: [first, first] } }] },
      { history: [{ ...snapshot.history[0], reason: " leading" }] },
      { history: [{ ...snapshot.history[0], operatorId: "not-uuid" }] },
      { history: [{ ...snapshot.history[0], epoch: "not-uuid" }] },
      { history: [{ ...snapshot.history[0], rolloutRevision: 0 }] },
      { history: [{ ...snapshot.history[0], createdAt: "2026-02-30T00:00:00.000Z" }] },
      { history: [{ ...snapshot.history[0], enabled: true }] },
    ]) {
      expect(SpackMaterialVisibilityViewSchema.safeParse({ ...snapshot, ...patch }).success).toBe(
        false,
      );
    }
  });

  test("rejects truncated, gapped, reversed, duplicate and oversized history", () => {
    const snapshot = view(3);
    for (const history of [
      [],
      snapshot.history.slice(0, 2),
      [...snapshot.history].reverse(),
      [snapshot.history[0], snapshot.history[0], snapshot.history[2]],
      [snapshot.history[0], { ...snapshot.history[1], revision: 1 }, snapshot.history[2]],
      Array.from({ length: 101 }, () => snapshot.history[0]),
    ]) {
      expect(SpackMaterialVisibilityViewSchema.safeParse({ ...snapshot, history }).success).toBe(
        false,
      );
    }
    for (const revision of [0, 1, 100, 101]) {
      const input = view(revision);
      expect(
        SpackMaterialVisibilityViewSchema.safeParse({
          ...input,
          historyTruncated: !input.historyTruncated,
        }).success,
      ).toBe(false);
    }
  });
});
