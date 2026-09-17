import { expect, test } from "patchright/test";

/**
 * Workflows + run view acceptance:
 *   1. Picking the two-node pipeline template fills the editor and parses cleanly.
 *   2. Submitting POSTs to /api/workflows and routes to /workflows/<runId>.
 *   3. The run view renders one node card per control-flow node with its status.
 *
 * Server is mocked. The editor submits the canonical workflow DSL;
 * the run detail carries a per-node `result` map.
 *
 * NOTE: the contract assertions still need a live dev-server verification pass.
 */
test.describe("Workflows + run view", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => window.localStorage.clear());

    const RUN_ID = "run-123";

    await page.route("**/api/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "test-token", expiresIn: 900 }),
      });
    });

    await page.route(/\/api\/workflows(\/.*)?$/, async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;

      if (path.endsWith("/api/workflows")) {
        if (req.method() === "POST") {
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
              runId: RUN_ID,
              name: "two-node-pipeline",
              status: "submitted",
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ runs: [] }),
        });
        return;
      }

      // GET /api/workflows/<runId> — run detail with a per-node result map.
      const runId = path.split("/").pop() ?? "";
      if (runId !== RUN_ID) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "NOT_FOUND", message: "missing" } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: RUN_ID,
          name: "two-node-pipeline",
          description: "two-node workflow demo",
          status: "SUCCEEDED",
          createdAt: new Date().toISOString(),
          stepJobs: {},
          result: {
            status: { greet: "SUCCEEDED", respond: "SUCCEEDED" },
            values: {
              greet: { status: "SUCCEEDED", values: {} },
              respond: { status: "SUCCEEDED", values: {} },
            },
          },
        }),
      });
    });

    await page.route("**/api/jobs", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      });
    });
    await page.route("**/api/agents", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agents: [] }),
      });
    });
    await page.route("**/api/audit-log**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries: [] }),
      });
    });
  });

  async function login(page: import("patchright/test").Page) {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("demo@example.com");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL("/");
  }

  test("submitting the two-node pipeline shows node cards", async ({ page }) => {
    await login(page);
    await page.getByTestId("nav-workflows").click();
    await expect(page).toHaveURL("/workflows");

    await page.getByTestId("workflows-new").click();
    await expect(page).toHaveURL("/workflows/new");

    // Pick the two-node pipeline template — fills the editor.
    await page.getByTestId("template-two-node-pipeline").click();
    // Parsed summary should report the node count.
    await expect(page.getByTestId("parsed-summary")).toContainText("2");

    // Submit — should navigate to /workflows/<runId>.
    await page.getByTestId("submit-workflow").click();
    await expect(page).toHaveURL(/\/workflows\/run-123/);

    // The run view renders one node card per control-flow node.
    await expect(page.getByTestId("workflow-nodes-card")).toBeVisible();
    await expect(page.getByTestId("workflow-node-greet")).toBeVisible();
    await expect(page.getByTestId("workflow-node-respond")).toBeVisible();
  });
});
