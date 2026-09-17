import { describe, expect, test } from "bun:test";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { deriveMeCapabilities } from "./me-capabilities";

function principal(overrides: Partial<BoundPrincipal> = {}): BoundPrincipal {
  return {
    sub: "00000000-0000-4000-8000-000000000001",
    role: "user",
    email: "scientist@example.com",
    userId: "00000000-0000-4000-8000-000000000001",
    orgId: null,
    orgIds: [],
    memberships: [],
    capabilities: [],
    ...overrides,
  };
}

describe("deriveMeCapabilities", () => {
  test("keeps an ordinary user in consumer, ecosystem, and personal workspaces", () => {
    const result = deriveMeCapabilities(principal());
    expect(result.capabilities).toContain("workspace.consumer.access");
    expect(result.capabilities).toContain("workspace.ecosystem.view");
    expect(result.capabilities).not.toContain("workspace.provider.view");
    expect(result.activeContextId).toBe("personal");
  });

  test("keeps a bound guest in the public ecosystem without consumer workflow capabilities", () => {
    const result = deriveMeCapabilities(principal({ role: "guest" }));

    expect(result.capabilities).toContain("workspace.ecosystem.view");
    expect(result.capabilities).not.toContain("workspace.consumer.access");
    expect(result.capabilities).not.toContain("workspace.personal.access");
    expect(result.capabilities).not.toContain("workflow.submit");
    expect(result.capabilities).not.toContain("storage.request");
  });

  test("grants provider management from an organization admin membership", () => {
    const orgId = "00000000-0000-4000-8000-000000000002";
    const result = deriveMeCapabilities(
      principal({
        orgId,
        orgIds: [orgId],
        memberships: [{ orgId, role: "admin" }],
      }),
    );
    expect(result.capabilities).toContain("workspace.provider.manage");
    expect(result.capabilities).toContain("workspace.ecosystem.publish");
    expect(result.capabilities).not.toContain("software.publish");
    expect(result.capabilities).toContain("terminal.open");
    expect(result.activeContextId).toBe(`organization:${orgId}`);
  });

  test("scopes provider management to the active organization", () => {
    const ownerOrgId = "00000000-0000-4000-8000-000000000002";
    const operatorOrgId = "00000000-0000-4000-8000-000000000003";
    const memberships: BoundPrincipal["memberships"] = [
      { orgId: ownerOrgId, role: "owner" },
      { orgId: operatorOrgId, role: "operator" },
    ];

    const ownerContext = deriveMeCapabilities(
      principal({ orgId: ownerOrgId, orgIds: [ownerOrgId, operatorOrgId], memberships }),
    );
    const operatorContext = deriveMeCapabilities(
      principal({ orgId: operatorOrgId, orgIds: [ownerOrgId, operatorOrgId], memberships }),
    );

    expect(ownerContext.capabilities).toContain("workspace.provider.manage");
    expect(ownerContext.capabilities).toContain("terminal.open");
    expect(operatorContext.capabilities).toContain("workspace.provider.view");
    expect(operatorContext.capabilities).not.toContain("workspace.provider.manage");
    expect(operatorContext.capabilities).not.toContain("terminal.open");
  });

  test("matches Registry publisher roles when deriving software.publish", () => {
    const adminOrgId = "00000000-0000-4000-8000-000000000002";
    const activeOrgId = "00000000-0000-4000-8000-000000000003";
    const membershipOnly = deriveMeCapabilities(
      principal({
        orgId: activeOrgId,
        orgIds: [adminOrgId, activeOrgId],
        memberships: [
          { orgId: adminOrgId, role: "admin" },
          { orgId: activeOrgId, role: "member" },
        ],
      }),
    );
    const orgAdmin = deriveMeCapabilities(principal({ role: "org_admin" }));
    const configuredUser = deriveMeCapabilities(principal(), ["user"]);
    const configuredWithoutOrgAdmin = deriveMeCapabilities(principal({ role: "org_admin" }), [
      "platform_admin",
    ]);

    expect(membershipOnly.capabilities).not.toContain("software.publish");
    expect(orgAdmin.capabilities).toContain("software.publish");
    expect(configuredUser.capabilities).toContain("software.publish");
    expect(configuredWithoutOrgAdmin.capabilities).not.toContain("software.publish");
  });

  test("does not expose provider workspaces to ordinary organization members", () => {
    const orgId = "00000000-0000-4000-8000-000000000002";
    const result = deriveMeCapabilities(
      principal({
        orgId,
        orgIds: [orgId],
        memberships: [{ orgId, role: "member" }],
      }),
    );
    expect(result.capabilities).not.toContain("workspace.provider.view");
    expect(result.capabilities).not.toContain("workspace.provider.manage");
  });

  test("separates platform observation from platform mutation", () => {
    const operator = deriveMeCapabilities(principal({ role: "operator" }));
    const admin = deriveMeCapabilities(principal({ role: "platform_admin" }));
    expect(operator.capabilities).toContain("workspace.platform.view");
    expect(operator.capabilities).not.toContain("workspace.platform.manage");
    expect(operator.capabilities).not.toContain("workspace.provider.view");
    expect(operator.capabilities).toContain("workspace.audit.view");
    expect(operator.capabilities).toContain("metering.report.view");
    expect(admin.capabilities).toContain("workspace.provider.view");
    expect(admin.capabilities).toContain("workspace.platform.manage");
  });

  test("exposes only the audit workspace and read-only audit capabilities to an auditor", () => {
    const result = deriveMeCapabilities(principal({ capabilities: ["audit_readonly"] }));

    expect(result.activeContextId).toBe("audit");
    expect(result.capabilities).toContain("workspace.audit.view");
    expect(result.capabilities).toContain("audit.view");
    expect(result.capabilities).toContain("audit.recording.view");
    expect(result.capabilities).toContain("metering.report.view");
    expect(result.capabilities).not.toContain("workspace.platform.view");
    expect(result.capabilities).not.toContain("workspace.provider.view");
    expect(result.capabilities).not.toContain("terminal.open");
  });
});
