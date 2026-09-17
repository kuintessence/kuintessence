import { describe, expect, test } from "vitest";
import {
  canAccessOperation,
  canAccessOperationsLink,
  OPERATIONS_LINKS,
  operationsHrefForRole,
} from "./operations-capabilities";

describe("operations capability role branches", () => {
  test("keeps platform operators read-only without inheriting provider administration", () => {
    expect(canAccessOperation("operator", "user")).toBe(true);
    expect(canAccessOperation("operator", "operator")).toBe(true);
    expect(canAccessOperation("operator", "org_admin")).toBe(false);
    expect(canAccessOperation("operator", "platform_admin")).toBe(false);
  });

  test("keeps organization administrators outside platform operations", () => {
    expect(canAccessOperation("org_admin", "org_admin")).toBe(true);
    expect(canAccessOperation("org_admin", "operator")).toBe(false);
    expect(canAccessOperation("org_admin", "platform_admin")).toBe(false);
  });

  test("lets platform administrators reach provider and platform operations", () => {
    expect(canAccessOperation("platform_admin", "org_admin")).toBe(true);
    expect(canAccessOperation("platform_admin", "operator")).toBe(true);
    expect(canAccessOperation("platform_admin", "platform_admin")).toBe(true);
    expect(canAccessOperation("platform_admin", "super_admin")).toBe(false);
  });

  test("shares read-only metering and audit entries across the provider and operator branches", () => {
    const metering = OPERATIONS_LINKS.find((item) => item.key === "metering");
    const audit = OPERATIONS_LINKS.find((item) => item.key === "audit");
    const cpAudit = OPERATIONS_LINKS.find((item) => item.key === "cpAudit");
    expect(metering).toBeDefined();
    expect(audit).toBeDefined();
    expect(cpAudit).toBeDefined();
    if (!metering || !audit || !cpAudit) return;

    expect(canAccessOperationsLink("org_admin", metering)).toBe(true);
    expect(canAccessOperationsLink("operator", metering)).toBe(true);
    expect(canAccessOperationsLink("user", metering)).toBe(false);
    expect(canAccessOperationsLink("org_admin", audit)).toBe(false);
    expect(canAccessOperationsLink("operator", audit)).toBe(true);
    expect(canAccessOperationsLink("org_admin", cpAudit)).toBe(true);
    expect(canAccessOperationsLink("user", audit, new Set(["audit.view"] as const))).toBe(true);
    expect(operationsHrefForRole("org_admin", metering)).toBe("/cp/metering");
    expect(operationsHrefForRole("operator", metering)).toBe("/operations#metering");
    expect(
      operationsHrefForRole("user", metering, new Set(["metering.report.view"] as const)),
    ).toBe("/operations#metering");
    expect(operationsHrefForRole("operator", audit)).toBe("/operations#audit");
  });
});
