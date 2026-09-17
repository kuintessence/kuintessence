import { expect, test } from "patchright/test";

/**
 * App shell acceptance:
 *   1. Sidebar can be toggled via the topbar button.
 *   2. Theme preference (dark / light) persists across reload.
 *   3. The primary sidebar links resolve to their routes.
 */
test.describe("AppShell", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("kq_token", "e2e-token");
      window.localStorage.setItem("kq_session", "cookie");
      window.localStorage.setItem("kq_email", "e2e@example.com");
      window.localStorage.setItem("kq_role", "platform_admin");
      window.localStorage.setItem("kq_token_expires_at", String(Date.now() + 60 * 60 * 1000));
    });
    await page.goto("/");
    await page.evaluate(() => {
      window.localStorage.removeItem("kq.theme");
      window.localStorage.removeItem("kq.sidebar-expanded");
    });
  });

  test("sidebar toggles between expanded and collapsed", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar).toHaveAttribute("data-expanded", "true");

    await page.getByTestId("sidebar-toggle").click();
    await expect(sidebar).toHaveAttribute("data-expanded", "false");

    await page.getByTestId("sidebar-toggle").click();
    await expect(sidebar).toHaveAttribute("data-expanded", "true");
  });

  test("theme preference persists across reload", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("theme-menu").click();
    await page.getByTestId("theme-dark").click();

    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // Switch back to light to confirm the round-trip works in both directions.
    await page.getByTestId("theme-menu").click();
    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("the primary sidebar links resolve to their routes", async ({ page }) => {
    await page.goto("/");

    const cases = [
      { testId: "nav-jobs", urlMatch: /\/jobs/ },
      { testId: "nav-workflows", urlMatch: /\/workflows/ },
      { testId: "nav-agents", urlMatch: /\/agents/ },
      { testId: "nav-software", urlMatch: /\/software/ },
      { testId: "nav-settings", urlMatch: /\/settings/ },
      { testId: "nav-dashboard", urlMatch: /\/$/ },
    ];

    for (const { testId, urlMatch } of cases) {
      await page.getByTestId(testId).click();
      await expect(page).toHaveURL(urlMatch);
      // Sidebar must remain rendered around every route.
      await expect(page.getByTestId("sidebar")).toBeVisible();
    }
  });
});
