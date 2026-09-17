import { describe, expect, test } from "bun:test";
import { expectedStatus, hasSmokeFailures, ROLE_NAMES } from "./role-operations-smoke";

describe("role operations smoke contract", () => {
  test("covers every technical role", () => {
    expect(ROLE_NAMES).toEqual([
      "guest",
      "user",
      "org_admin",
      "operator",
      "platform_admin",
      "super_admin",
    ]);
  });

  test("keeps provider and platform read boundaries distinct", () => {
    expect(expectedStatus("anonymous", "capabilities")).toBe(401);
    expect(expectedStatus("guest", "capabilities")).toBe(200);
    expect(expectedStatus("guest", "jobs")).toBe(403);
    expect(expectedStatus("user", "cpDashboard")).toBe(403);
    expect(expectedStatus("org_admin", "cpDashboard")).toBe(200);
    expect(expectedStatus("org_admin", "auditLog")).toBe(403);
    expect(expectedStatus("operator", "cpDashboard")).toBe(403);
    expect(expectedStatus("operator", "auditLog")).toBe(200);
    expect(expectedStatus("platform_admin", "cpDashboard")).toBe(200);
    expect(expectedStatus("super_admin", "cpDashboard")).toBe(200);
    expect(expectedStatus("super_admin", "auditLog")).toBe(200);
  });

  test("fails the smoke for request or evidence contract failures", () => {
    expect(hasSmokeFailures([], [])).toBe(false);
    expect(hasSmokeFailures(["request"], [])).toBe(true);
    expect(hasSmokeFailures([], ["evidence"])).toBe(true);
  });
});
