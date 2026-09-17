import { expect, test } from "patchright/test";

/**
 * Agents card grid acceptance:
 *   1. List of registered agents renders one card per agent.
 *   2. Each card shows the status indicator and the "View jobs on this agent" link.
 *   3. Empty-state appears when the API returns zero agents.
 */
test.describe("Agents card grid", () => {
  async function login(page: import("patchright/test").Page) {
    await page.goto("/");
    await page.evaluate(() => window.localStorage.clear());
    await page.route("**/api/auth/login", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "tok-test", expiresIn: 900 }),
      }),
    );
    await page.route("**/api/jobs", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route("**/api/workflows", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      }),
    );
    await page.route("**/api/audit-log**", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries: [] }),
      }),
    );
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("demo@example.com");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL("/");
  }

  test("renders one card per agent with status + view-jobs link", async ({ page }) => {
    const agents = [
      {
        agentId: "agent-slurm-jx",
        siteName: "Example HPC",
        schedulerType: "slurm",
        schedulerVersion: "23.02",
        status: "online",
        lastHeartbeat: new Date(Date.now() - 30_000).toISOString(),
        cpuUsagePercent: 42,
        memoryUsedMb: 4096,
        memoryTotalMb: 16384,
      },
      {
        agentId: "agent-k8s-test",
        siteName: "Test K8s",
        schedulerType: "k8s",
        schedulerVersion: "1.30",
        status: "offline",
        lastHeartbeat: null,
        cpuUsagePercent: null,
        memoryUsedMb: null,
        memoryTotalMb: null,
      },
    ];
    await page.route("**/api/agents", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agents }),
      }),
    );

    await login(page);
    await page.getByTestId("nav-agents").click();
    await expect(page).toHaveURL("/agents");
    await expect(page.getByTestId("agents-grid")).toBeVisible();
    await expect(page.getByTestId("agent-card-agent-slurm-jx")).toBeVisible();
    await expect(page.getByTestId("agent-card-agent-k8s-test")).toBeVisible();
    await expect(page.getByTestId("agent-status-agent-slurm-jx")).toBeVisible();
    await expect(page.getByTestId("agent-view-jobs-agent-slurm-jx")).toBeVisible();
    await expect(page.getByTestId("agents-count")).toContainText("1 online · 2 total");
  });

  test("shows empty-state when no agents are registered", async ({ page }) => {
    await page.route("**/api/agents", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agents: [] }),
      }),
    );

    await login(page);
    await page.getByTestId("nav-agents").click();
    await expect(page).toHaveURL("/agents");
    await expect(page.getByTestId("agents-empty")).toBeVisible();
    await expect(page.getByTestId("agents-count")).toContainText("0 online · 0 total");
  });
});
