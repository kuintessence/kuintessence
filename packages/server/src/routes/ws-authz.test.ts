import { describe, expect, test } from "bun:test";
import { AppError } from "@kuintessence/shared";
import type { AuthzService, ShadowCheckInput } from "../authz/service";
import { authorizeRealtimeSubscription, wsActorLookupKey } from "./ws";

function fakeAuthz(mode: "shadow" | "enforce") {
  const shadowInputs: ShadowCheckInput[] = [];
  const requireInputs: Array<{ input: unknown; isPlatformAdmin: boolean }> = [];
  const authz = {
    mode,
    shadowCheck: async (input: ShadowCheckInput) => {
      shadowInputs.push(input);
      return input.localAllowed;
    },
    requirePermission: async (input: unknown, isPlatformAdmin: boolean) => {
      requireInputs.push({ input, isPlatformAdmin });
      throw new AppError("FORBIDDEN", "Authorization denied", 403);
    },
  } as unknown as AuthzService;
  return { authz, shadowInputs, requireInputs };
}

describe("authorizeRealtimeSubscription", () => {
  test("records job#view shadow checks for WS subscriptions", async () => {
    const fake = fakeAuthz("shadow");

    await authorizeRealtimeSubscription(fake.authz, {
      actorUserId: "user-1",
      actorEmail: "bound-owner@example.test",
      resourceType: "job",
      resourceId: "job-1",
      localAllowed: true,
    });

    expect(fake.shadowInputs).toHaveLength(1);
    expect(fake.shadowInputs[0]).toMatchObject({
      actorUserId: "user-1",
      actorEmail: "bound-owner@example.test",
      resource: { type: "job", id: "job-1" },
      permission: "view",
      subject: { type: "user", id: "user-1" },
      localAllowed: true,
    });
  });

  test("records local denial before rejecting shadow WS subscriptions", async () => {
    const fake = fakeAuthz("shadow");

    await expect(
      authorizeRealtimeSubscription(fake.authz, {
        actorUserId: "user-1",
        actorEmail: "bound-user@example.test",
        resourceType: "job",
        resourceId: "job-1",
        localAllowed: false,
      }),
    ).rejects.toThrow("Not authorized to subscribe to this job");

    expect(fake.shadowInputs).toHaveLength(1);
    expect(fake.shadowInputs[0]).toMatchObject({
      actorUserId: "user-1",
      actorEmail: "bound-user@example.test",
      resource: { type: "job", id: "job-1" },
      permission: "view",
      subject: { type: "user", id: "user-1" },
      localAllowed: false,
    });
  });

  test("propagates enforce denials for workflow subscriptions", async () => {
    const fake = fakeAuthz("enforce");

    await expect(
      authorizeRealtimeSubscription(fake.authz, {
        actorUserId: "user-1",
        actorEmail: "bound-owner@example.test",
        resourceType: "workflow",
        resourceId: "run-1",
        localAllowed: true,
      }),
    ).rejects.toThrow("Authorization denied");
    expect(fake.requireInputs).toHaveLength(1);
  });

  test("does not allow degraded fallback without a bound platform role", async () => {
    const fake = fakeAuthz("enforce");

    await expect(
      authorizeRealtimeSubscription(fake.authz, {
        actorUserId: "user-1",
        actorEmail: "bound-user@example.test",
        resourceType: "job",
        resourceId: "job-1",
        localAllowed: false,
      }),
    ).rejects.toThrow("Authorization denied");

    expect(fake.requireInputs[0]?.isPlatformAdmin).toBe(false);
  });

  test("fails closed in enforce mode without a canonical caller id", async () => {
    const fake = fakeAuthz("enforce");

    await expect(
      authorizeRealtimeSubscription(fake.authz, {
        actorUserId: null,
        actorEmail: null,
        resourceType: "job",
        resourceId: "job-1",
        localAllowed: false,
      }),
    ).rejects.toThrow("Authorization principal is not bound");
    expect(fake.requireInputs).toEqual([]);
  });

  test("fails closed in shadow mode without a canonical caller id", async () => {
    const fake = fakeAuthz("shadow");

    await expect(
      authorizeRealtimeSubscription(fake.authz, {
        actorUserId: null,
        actorEmail: null,
        resourceType: "workflow",
        resourceId: "run-1",
        localAllowed: false,
      }),
    ).rejects.toThrow("Authorization principal is not bound");

    expect(fake.shadowInputs).toEqual([]);
  });
});

describe("wsActorLookupKey", () => {
  test("uses canonical UUID subjects before a potentially stale email", () => {
    expect(
      wsActorLookupKey({
        sub: "00000000-0000-4000-8000-000000000111",
        email: "stale@example.test",
      }),
    ).toBe("00000000-0000-4000-8000-000000000111");
  });

  test("falls back to email for opaque OIDC subjects", () => {
    expect(wsActorLookupKey({ sub: "casdoor:opaque-subject", email: "current@example.test" })).toBe(
      "current@example.test",
    );
  });
});
