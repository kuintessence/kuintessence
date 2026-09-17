import { expect, test } from "patchright/test";

/**
 * Settings acceptance:
 *   1. Theme buttons toggle the html class + data-theme attribute.
 *   2. Dev role-switcher re-issues a token via /auth/login and updates the displayed role.
 *   3. Logout clears auth and returns to /login.
 *   4. Token countdown row renders.
 */
test.describe("Settings page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => window.localStorage.clear());

    let lastRole = "user";
    await page.route("**/api/auth/login", async (route) => {
      const body = route.request().postDataJSON() as { role?: string } | null;
      if (body?.role) lastRole = body.role;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: `tok-${lastRole}`, expiresIn: 900 }),
      });
    });

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
    await page.route("**/api/agents", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agents: [] }),
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
  });

  test("theme switch + token countdown render", async ({ page }) => {
    await page.getByTestId("nav-settings").click();
    await expect(page).toHaveURL("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();

    await page.getByTestId("settings-theme-dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.getByTestId("settings-theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await expect(page.getByTestId("settings-expiry-value")).toBeVisible();
  });

  test("role switcher re-issues a token (dev mode)", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("settings-role")).toBeVisible();

    await page.getByTestId("settings-role-platform_admin").click();

    // The settings page reads role from getAuthState() at mount; re-route to /settings to
    // force a fresh read, which mimics a real navigation after a successful switch.
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toContainText("platform_admin");
  });

  test("logout returns to /login", async ({ page }) => {
    await page.goto("/settings");
    await page.getByTestId("settings-logout").click();
    await expect(page).toHaveURL("/login");
  });
});
