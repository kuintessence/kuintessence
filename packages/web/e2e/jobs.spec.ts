import { expect, test } from "patchright/test";

/**
 * Jobs acceptance:
 *   1. Status filter chip "Failed" reduces visible rows.
 *   2. Click row → slide-in JobDetailSheet opens.
 *   3. Submit-from-toolbar — newly submitted job appears within one auto-refresh.
 *
 * The Server is mocked. We seed 3 jobs (PENDING + RUNNING + FAILED) so filter assertions
 * are unambiguous.
 */
test.describe("Jobs page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => window.localStorage.clear());

    const seed = [
      {
        id: "j-pending",
        name: "build-pending",
        status: "PENDING",
        submittedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        id: "j-running",
        name: "train-running",
        status: "RUNNING",
        submittedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      {
        id: "j-failed",
        name: "infer-failed",
        status: "FAILED",
        submittedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ];

    const state = { jobs: [...seed] };

    await page.route("**/api/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "test-token", expiresIn: 900 }),
      });
    });

    // Single handler that branches on path/method to avoid glob-precedence pitfalls.
    await page.route(/\/api\/jobs(\/.*)?$/, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();

      // Collection: GET / POST /api/jobs
      if (path.endsWith("/api/jobs")) {
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ jobs: state.jobs }),
          });
          return;
        }
        const body = req.postDataJSON() as { name?: string };
        const id = `j-new-${state.jobs.length + 1}`;
        const fresh = {
          id,
          name: body?.name ?? "unnamed",
          status: "PENDING",
          submittedAt: new Date().toISOString(),
        };
        state.jobs.push(fresh);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(fresh),
        });
        return;
      }

      // /api/jobs/:id/logs → not implemented
      if (path.endsWith("/logs")) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "NOT_FOUND", message: "no logs" } }),
        });
        return;
      }

      // /api/jobs/:id → detail
      const id = path.split("/").pop() ?? "";
      const j = state.jobs.find((x) => x.id === id);
      if (!j) {
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
          ...j,
          command: 'echo "hi"',
          resources: { cpus: 1, memoryMb: 1024 },
        }),
      });
    });

    await page.route("**/api/workflows", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
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

  test("status filter chip 'Failed' reduces visible rows", async ({ page }) => {
    await login(page);
    await page.getByTestId("nav-jobs").click();
    await expect(page).toHaveURL("/jobs");

    // All 3 visible.
    await expect(page.getByTestId("job-row-j-pending")).toBeVisible();
    await expect(page.getByTestId("job-row-j-running")).toBeVisible();
    await expect(page.getByTestId("job-row-j-failed")).toBeVisible();

    await page.getByTestId("status-chip-failed").click();
    // Only Failed remains.
    await expect(page.getByTestId("job-row-j-failed")).toBeVisible();
    await expect(page.getByTestId("job-row-j-pending")).toHaveCount(0);
    await expect(page.getByTestId("job-row-j-running")).toHaveCount(0);
    await expect(page.getByTestId("jobs-count")).toHaveText("1 visible · 3 total");
  });

  test("clicking a row opens the JobDetailSheet", async ({ page }) => {
    await login(page);
    await page.getByTestId("nav-jobs").click();

    await page.getByTestId("job-row-j-running").click();
    await expect(page.getByTestId("job-detail-sheet")).toBeVisible();
    await expect(page.getByTestId("tab-overview")).toBeVisible();
    await expect(page.getByTestId("tab-logs")).toBeVisible();
    await expect(page.getByTestId("tab-resources")).toBeVisible();

    // Overview tab default — must show the job id.
    await expect(page.getByTestId("job-detail-sheet")).toContainText("j-running");

    // Logs tab — Server returned 404 so we should see the "endpoint pending" notice.
    await page.getByTestId("tab-logs").click();
    await expect(page.getByTestId("job-logs-unavailable")).toBeVisible({ timeout: 7_000 });

    // Resources tab — assert cpus value renders.
    await page.getByTestId("tab-resources").click();
    await expect(page.getByTestId("job-resources-tab")).toContainText("CPU");
  });

  test("submit-from-toolbar appears in the table within one refresh", async ({ page }) => {
    await login(page);
    await page.getByTestId("nav-jobs").click();
    await expect(page.getByTestId("jobs-count")).toHaveText("3 visible · 3 total");

    await page.getByTestId("jobs-submit-button").click();
    await expect(page.getByTestId("submit-job-dialog")).toBeVisible();
    await page.getByTestId("submit-job-name").fill("e2e-fresh");
    await page.getByTestId("submit-job-confirm").click();

    // Dialog closes, list invalidates → count goes from 3 to 4.
    await expect(page.getByTestId("submit-job-dialog")).not.toBeVisible({ timeout: 7_000 });
    await expect(page.getByTestId("jobs-count")).toHaveText("4 visible · 4 total", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("job-row-j-new-4").getByText("e2e-fresh")).toBeVisible();
  });
});
