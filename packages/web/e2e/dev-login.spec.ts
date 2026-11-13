import { expect, test } from "patchright/test";

test("development entry renders login without Node-only imports", async ({ page }) => {
  let pageErrors = 0;
  page.on("pageerror", () => pageErrors++);
  await page.route("**/platform/api/auth/oidc/config-public", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: false, providerName: "" }),
    }),
  );
  await page.goto("/login");
  // Vite can forward module errors to its server instead of emitting pageerror.
  await expect(page.getByTestId("login-email")).toBeVisible();
  await page.getByTestId("login-role").selectOption("super_admin");
  await expect(page.getByTestId("login-role")).toHaveValue("super_admin");
  expect(pageErrors).toBe(0);
});
