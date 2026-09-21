import { describe, expect, test } from "bun:test";
import {
  SpackMaterialLifecycleChangeSchema,
  type SpackMaterialLifecycleView,
  SpackMaterialLifecycleViewSchema,
} from "./spack-material-lifecycle";

const change = { action: "withdraw", expectedRevision: 0, reason: "Source needs review" };

describe("material lifecycle change contract", () => {
  test.each([
    "withdraw",
    "restore",
  ])("accepts the exact %s command without rewriting it", (action) => {
    for (const expectedRevision of [0, 2_147_483_646]) {
      for (const reason of ["x", "Source needs review", "x".repeat(1000)]) {
        const input = { action, expectedRevision, reason };
        expect(SpackMaterialLifecycleChangeSchema.parse(input)).toEqual(input);
      }
    }
  });

  test.each([
    null,
    {},
    { expectedRevision: 0, reason: "Review" },
    { action: "withdraw", reason: "Review" },
    { action: "withdraw", expectedRevision: 0 },
  ])("requires an object with all three fields: %j", (input) => {
    expect(SpackMaterialLifecycleChangeSchema.safeParse(input).success).toBe(false);
  });

  test("rejects an empty array instead of a lifecycle change object", () => {
    expect(SpackMaterialLifecycleChangeSchema.safeParse([]).success).toBe(false);
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

function lifecycleView(revision = 0): SpackMaterialLifecycleView {
  const history = Array.from({ length: Math.min(revision, 100) }, (_, index) => ({
    revision: revision - index,
    state: (revision - index) % 2 ? ("withdrawn" as const) : ("available" as const),
    operatorId: "11111111-1111-4111-8111-111111111111",
    reason: "Source needs review",
    epoch: "22222222-2222-4222-8222-222222222222",
    rolloutRevision: 1,
    createdAt: "2026-09-21T00:00:00.000Z",
  }));
  return {
    binding: { repositoryId: "a".repeat(64), manifestDigest: `sha256:${"b".repeat(64)}` },
    repository: "org/research/sources",
    revision,
    state: history[0]?.state ?? "available",
    history,
    historyTruncated: revision > 100,
  };
}

describe("material lifecycle view contract", () => {
  test("accepts every canonical UUID shape allowed by backend authorization", () => {
    const view = lifecycleView(1);
    const event = view.history[0];
    if (!event) throw new Error("Missing audit fixture");
    for (const operatorId of [
      "11111111-1111-1111-1111-111111111111",
      "00000000-0000-0000-0000-000000000000",
      "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    ]) {
      const input = { ...view, history: [{ ...event, operatorId }] };
      expect(SpackMaterialLifecycleViewSchema.parse(input)).toEqual(input);
    }
  });

  test.each([0, 1, 2, 99, 100, 101, 2_147_483_647])(
    "accepts the complete bounded view at revision %i without rewriting it",
    (revision) => {
      const view = lifecycleView(revision);
      expect(SpackMaterialLifecycleViewSchema.parse(view)).toEqual(view);
    },
  );

  test.each(["public/sources", "org/research/sources", "user/alice/sources"])(
    "accepts the immutable manifest namespace %s",
    (repository) => {
      const view = { ...lifecycleView(), repository };
      expect(SpackMaterialLifecycleViewSchema.parse(view)).toEqual(view);
    },
  );

  test("requires every view and audit field", () => {
    const view = lifecycleView(1);
    for (const key of Object.keys(view)) {
      const input = Object.fromEntries(Object.entries(view).filter(([field]) => field !== key));
      expect(SpackMaterialLifecycleViewSchema.safeParse(input).success).toBe(false);
    }
    const audit = view.history[0];
    if (!audit) throw new Error("Missing audit fixture");
    for (const key of Object.keys(audit)) {
      const entry = Object.fromEntries(Object.entries(audit).filter(([field]) => field !== key));
      expect(
        SpackMaterialLifecycleViewSchema.safeParse({ ...view, history: [entry] }).success,
      ).toBe(false);
    }
  });

  test.each([null, {}, "available"])("rejects a missing view: %j", (input) => {
    expect(SpackMaterialLifecycleViewSchema.safeParse(input).success).toBe(false);
  });

  test("rejects an empty array instead of a lifecycle view", () => {
    expect(SpackMaterialLifecycleViewSchema.safeParse([]).success).toBe(false);
  });

  test.each([
    { revision: -1 },
    { revision: 0.5 },
    { revision: "0" },
    { revision: 2_147_483_648 },
    { revision: Number.NaN },
    { revision: Number.POSITIVE_INFINITY },
    { state: "withdrawn" },
    { state: "deleted" },
    { state: null },
    { history: null },
    { historyTruncated: true },
    { historyTruncated: "false" },
    { repository: "" },
    { repository: "sources" },
    { repository: "org/research/../sources" },
    { repository: "org/research/sources " },
    { repository: "https://example.test/sources" },
    { binding: null },
    { binding: { repositoryId: "a".repeat(64) } },
    { binding: { ...lifecycleView().binding, repositoryId: "../other" } },
    { binding: { ...lifecycleView().binding, manifestDigest: "invalid" } },
    { binding: { ...lifecycleView().binding, url: "https://example.test" } },
    { operatorId: "11111111-1111-4111-8111-111111111111" },
    { url: "https://example.test" },
  ])("rejects malformed or noninitial revision-zero views: %j", (patch) => {
    expect(
      SpackMaterialLifecycleViewSchema.safeParse({ ...lifecycleView(), ...patch }).success,
    ).toBe(false);
  });

  test.each([
    { revision: 0 },
    { revision: -1 },
    { revision: 1.5 },
    { revision: "1" },
    { revision: 2_147_483_648 },
    { state: "deleted" },
    { operatorId: "not-a-uuid" },
    { epoch: "not-a-uuid" },
    { rolloutRevision: 0 },
    { rolloutRevision: -1 },
    { rolloutRevision: 1.5 },
    { rolloutRevision: "1" },
    { rolloutRevision: 2_147_483_648 },
    { reason: "" },
    { reason: " leading" },
    { reason: "trailing " },
    { reason: "line\nbreak" },
    { reason: "x".repeat(1001) },
    { createdAt: "2026-09-21" },
    { createdAt: "2026-09-21T00:00:00" },
    { createdAt: "2026-02-30T00:00:00.000Z" },
    { createdAt: 123 },
    { action: "withdraw" },
    { url: "https://example.test" },
  ])("rejects malformed audit fields: %j", (patch) => {
    const view = lifecycleView(1);
    expect(
      SpackMaterialLifecycleViewSchema.safeParse({
        ...view,
        history: [{ ...view.history[0], ...patch }],
      }).success,
    ).toBe(false);
  });

  test("requires the newest history entry to match the current revision and state", () => {
    const view = lifecycleView(2);
    for (const patch of [{ revision: 1 }, { state: "withdrawn" }]) {
      expect(
        SpackMaterialLifecycleViewSchema.safeParse({ ...view, ...patch }).success,
      ).toBe(false);
    }
  });

  test("rejects empty, gapped, duplicated, reversed, oversized, or incomplete histories", () => {
    const view = lifecycleView(3);
    for (const history of [
      [],
      view.history.slice(0, 2),
      [view.history[0], view.history[2]],
      [view.history[0], view.history[0], view.history[2]],
      [...view.history].reverse(),
      [view.history[0], { ...view.history[1], revision: 0 }, view.history[2]],
      Array.from({ length: 101 }, () => view.history[0]),
    ]) {
      expect(
        SpackMaterialLifecycleViewSchema.safeParse({ ...view, history }).success,
      ).toBe(false);
    }
    expect(
      SpackMaterialLifecycleViewSchema.safeParse({
        ...lifecycleView(),
        history: lifecycleView(1).history,
      }).success,
    ).toBe(false);
  });

  test("requires exactly 100 entries for truncated history and an accurate truncation flag", () => {
    for (const revision of [1, 100, 101]) {
      const view = lifecycleView(revision);
      expect(
        SpackMaterialLifecycleViewSchema.safeParse({
          ...view,
          historyTruncated: !view.historyTruncated,
        }).success,
      ).toBe(false);
    }
    const view = lifecycleView(101);
    expect(
      SpackMaterialLifecycleViewSchema.safeParse({
        ...view,
        history: view.history.slice(0, 99),
      }).success,
    ).toBe(false);
  });
});
