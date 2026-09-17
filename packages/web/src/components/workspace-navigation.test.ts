import { describe, expect, test } from "vitest";
import {
  canUseWorkspaceIdentity,
  canUseWorkspaceNavItem,
  getWorkspaceIdentity,
  inferWorkspaceIdentity,
  isWorkspaceNavItemActive,
} from "./workspace-navigation";

describe("workspace navigation", () => {
  test("derives provider and platform authorization contexts from the URL", () => {
    expect(inferWorkspaceIdentity("/cp/users", "")).toBe("provider-operations");
    expect(inferWorkspaceIdentity("/cp/queues", "")).toBe("provider-technical");
    expect(inferWorkspaceIdentity("/operations", "")).toBe("platform-operations");
    expect(inferWorkspaceIdentity("/operations", "#audit")).toBe("platform-audit");
    expect(inferWorkspaceIdentity("/operations", "#metering")).toBe("platform-audit");
    expect(inferWorkspaceIdentity("/settings", "#security")).toBe("platform-technical");
    expect(inferWorkspaceIdentity("/settings", "#security/authz")).toBe("platform-technical");
    expect(inferWorkspaceIdentity("/settings", "#personal")).toBe("personal");
  });

  test("highlights default sections when a hash is omitted", () => {
    const personalItem = getWorkspaceIdentity("personal").sections[0]?.items[0];
    const templateItem = getWorkspaceIdentity("software-developer").sections[0]?.items[0];
    expect(personalItem).toBeDefined();
    expect(templateItem).toBeDefined();
    if (!personalItem || !templateItem) return;

    expect(isWorkspaceNavItemActive(personalItem, "/settings", "")).toBe(true);
    expect(isWorkspaceNavItemActive(templateItem, "/software", "")).toBe(true);
    expect(isWorkspaceNavItemActive(templateItem, "/software", "#scripts")).toBe(false);
  });

  test("derives exactly one software section from root hashes and nested routes", () => {
    const items = getWorkspaceIdentity("software-developer").sections[0]?.items ?? [];
    const cases = [
      { pathname: "/software", hash: "", activeHash: "workflow-templates" },
      { pathname: "/software", hash: "#usecases", activeHash: "usecases" },
      { pathname: "/software", hash: "#spack", activeHash: "spack" },
      { pathname: "/software", hash: "#scripts", activeHash: "scripts" },
      {
        pathname: "/software/workflow-templates/template-1",
        hash: "#scripts",
        activeHash: "workflow-templates",
      },
      {
        pathname: "/software/usecases/usecase-1",
        hash: "#workflow-templates",
        activeHash: "usecases",
      },
      { pathname: "/software/spack/upstream/lammps", hash: "", activeHash: "spack" },
      { pathname: "/software/scripts/script-1", hash: "", activeHash: "scripts" },
      { pathname: "/software/scripts/new", hash: "#usecases", activeHash: "scripts" },
    ];

    for (const item of cases) {
      const active = items.filter((navItem) =>
        isWorkspaceNavItemActive(navItem, item.pathname, item.hash),
      );
      expect(active).toHaveLength(1);
      expect(active[0]?.hash).toBe(item.activeHash);
    }
  });

  test("keeps provider overview inactive on nested provider routes", () => {
    const overviewItem = getWorkspaceIdentity("provider-operations").sections[0]?.items[0];
    expect(overviewItem).toBeDefined();
    if (!overviewItem) return;

    expect(isWorkspaceNavItemActive(overviewItem, "/cp", "")).toBe(true);
    expect(isWorkspaceNavItemActive(overviewItem, "/cp/software", "")).toBe(false);
  });

  test("separates the operations overview from platform technical settings", () => {
    const operationsItems = getWorkspaceIdentity("platform-operations").sections[0]?.items ?? [];
    const technicalItems = getWorkspaceIdentity("platform-technical").sections[0]?.items ?? [];
    const overviewItem = operationsItems.find((item) => item.hash === "overview");
    const securityItem = technicalItems.find((item) => item.hash === "security");
    expect(overviewItem).toBeDefined();
    expect(securityItem).toBeDefined();
    if (!overviewItem || !securityItem) return;

    expect(isWorkspaceNavItemActive(overviewItem, "/operations", "")).toBe(true);
    expect(isWorkspaceNavItemActive(overviewItem, "/operations", "#security")).toBe(false);
    expect(isWorkspaceNavItemActive(securityItem, "/settings", "#security")).toBe(true);
  });

  test("highlights one nested personal section at a time", () => {
    const items = getWorkspaceIdentity("personal").sections[0]?.items ?? [];
    const accountItem = items.find((item) => item.hash === "personal/account");
    const executionAccountItem = items.find((item) => item.hash === "personal/execution-accounts");
    expect(accountItem).toBeDefined();
    expect(executionAccountItem).toBeDefined();
    if (!accountItem || !executionAccountItem) return;

    expect(isWorkspaceNavItemActive(accountItem, "/settings", "")).toBe(true);
    expect(isWorkspaceNavItemActive(accountItem, "/settings", "#personal/account")).toBe(true);
    expect(isWorkspaceNavItemActive(accountItem, "/settings", "#personal/execution-accounts")).toBe(
      false,
    );
    expect(
      isWorkspaceNavItemActive(executionAccountItem, "/settings", "#personal/execution-accounts"),
    ).toBe(true);
  });

  test("offers the read-only platform workspace to operators without technical management", () => {
    const capabilities = new Set(["workspace.platform.view"] as const);

    expect(
      canUseWorkspaceIdentity(
        getWorkspaceIdentity("platform-operations"),
        "operator",
        false,
        null,
        capabilities,
      ),
    ).toBe(true);
    expect(
      canUseWorkspaceIdentity(
        getWorkspaceIdentity("platform-technical"),
        "operator",
        false,
        null,
        capabilities,
      ),
    ).toBe(false);
  });

  test("offers an audit-only platform workspace without platform operations", () => {
    const capabilities = new Set(["workspace.audit.view"] as const);

    expect(
      canUseWorkspaceIdentity(
        getWorkspaceIdentity("platform-audit"),
        "user",
        false,
        null,
        capabilities,
      ),
    ).toBe(true);
    expect(
      canUseWorkspaceIdentity(
        getWorkspaceIdentity("platform-operations"),
        "user",
        false,
        null,
        capabilities,
      ),
    ).toBe(false);
  });

  test("keeps provider management navigation hidden from provider operators", () => {
    const capabilities = new Set(["workspace.provider.view"] as const);
    const items = getWorkspaceIdentity("provider-operations").sections.flatMap(
      (section) => section.items,
    );
    const visibleRoutes = items
      .filter((item) => canUseWorkspaceNavItem(item, "user", false, null, capabilities))
      .map((item) => item.to);

    expect(visibleRoutes).toContain("/cp");
    expect(visibleRoutes).toContain("/cp/metering");
    expect(visibleRoutes).toContain("/cp/audit");
    expect(visibleRoutes).not.toContain("/cp/data");
    expect(visibleRoutes).toContain("/cp/software");
    expect(visibleRoutes).not.toContain("/cp/users");
    expect(visibleRoutes).not.toContain("/cp/accounts");
  });
});
