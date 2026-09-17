import { expect, test } from "patchright/test";

/**
 * Dashboard workflow acceptance:
 *   1. Fresh login lands on `/` (the dashboard, not /jobs).
 *   2. Quick Start empty-state submits the Hello workflow on click.
 *   3. Dashboard counts increment after a successful submit + refetch.
 *
 * No real Server here — Patchright `page.route` intercepts every /api/* call so the
 * test can drive both the empty-state and the populated-state branches.
 *
 * QuickStart posts to POST /api/workflows with `{ yaml }` and
 * expects `{ runId }`; the dashboard count comes from GET /api/workflows.
 *
 * NOTE: the contract assertions still need a live dev-server verification pass.
 */
test.describe("Dashboard at /", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => window.localStorage.clear());

    // Mutable state shared with the route handlers below.
    const state: {
      workflows: Array<Record<string, unknown>>;
      jobs: Array<Record<string, unknown>>;
    } = {
      workflows: [],
      jobs: [],
    };

    await page.route("**/api/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "test-token", expiresIn: 900 }),
      });
    });

    await page.route("**/api/jobs", async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jobs: state.jobs }),
        });
        return;
      }
      // POST /api/jobs — used by the demo job button (not asserted here, but valid).
      const id = `job-${Date.now()}`;
      state.jobs.push({
        id,
        name: "demo",
        status: "PENDING",
        submittedAt: new Date().toISOString(),
      });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id, name: "demo", status: "PENDING" }),
      });
    });

    // GET list + async submit — the dashboard reads the active-workflow count from here.
    await page.route("**/api/workflows", async (route) => {
      if (route.request().method() === "POST") {
        const runId = `run-${state.workflows.length + 1}`;
        state.workflows.push({
          id: runId,
          name: "hello",
          status: "submitted",
          createdAt: new Date().toISOString(),
        });
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ runId, name: "hello", status: "submitted" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: state.workflows }),
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

  test("fresh login lands on /, dashboard renders", async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("demo@example.com");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await expect(page.getByTestId("stat-active-jobs")).toBeVisible();
    await expect(page.getByTestId("stat-active-workflows")).toBeVisible();
    await expect(page.getByTestId("stat-agents-online")).toBeVisible();
    await expect(page.getByTestId("stat-throughput-total")).toBeVisible();
  });

  test("Quick Start submits the Hello workflow and counts increment", async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("demo@example.com");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL("/");

    // Empty-state Quick Start should be visible — both jobs and workflows are empty.
    const quick = page.getByTestId("quick-start");
    await expect(quick).toBeVisible();
    await expect(page.getByTestId("stat-active-workflows-value")).toHaveText("0");

    await page.getByTestId("quick-start-submit-workflow").click();

    // After submission and the next 10s refetch, the workflow count should rise to 1.
    // We assert against the value cell, which reflects both fresh fetches and tab focus.
    await expect(page.getByTestId("stat-active-workflows-value")).toHaveText("1", {
      timeout: 15_000,
    });
    // Quick Start should no longer be in bootstrap empty state.
    await expect(quick).not.toBeVisible();
  });
});
