import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "patchright/test";

const webRoot = resolve(import.meta.dirname, "..");
let javascript = "";
let css = "";
const provider = "11111111-1111-4111-8111-111111111111";
const otherProvider = "22222222-2222-4222-8222-222222222222";

test.beforeAll(() => {
  const bundle = resolve(webRoot, "test-results/queue-dialog-bundle");
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/queue-dialog.tsx",
      "--target=browser",
      "--format=iife",
      "--define",
      'import.meta.env={"MODE":"test"}',
      "--outdir",
      bundle,
    ],
    { cwd: webRoot },
  );
  javascript = readFileSync(resolve(bundle, "queue-dialog.js"), "utf8");
  css = readdirSync(resolve(webRoot, "dist/assets"))
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(resolve(webRoot, "dist/assets", name), "utf8"))
    .join("\n");
});

for (const viewport of [
  { width: 1161, height: 770 },
  { width: 390, height: 640 },
  { width: 320, height: 480 },
]) {
  test(`dialog and dropdown scrolling ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().isNavigationRequest())
        return route.fulfill({
          contentType: "text/html",
          body: '<html lang="zh"><body><div id="root"></div></body></html>',
        });
      if (path === "/platform/api/admin/queues") return route.fulfill({ json: { queues: [] } });
      if (path === "/platform/api/cp/agents")
        return route.fulfill({
          json: {
            items: [
              ...Array.from({ length: 30 }, (_, i) => ({
                id: `agent-${i}`,
                hostname: `代理 ${i}`,
                siteId: `site-${i}`,
                status: "online",
                providerOrgId: provider,
              })),
              {
                id: "agent-other",
                hostname: "其他组织代理",
                siteId: "other",
                status: "online",
                providerOrgId: otherProvider,
              },
            ],
          },
        });
      if (path === "/platform/api/cp/agent-registration-context")
        return route.fulfill({
          json: {
            isPlatformWide: true,
            providerOrgs: [
              { id: provider, name: "算力中心 A" },
              { id: otherProvider, name: "算力中心 B" },
            ],
            schedulers: ["slurm"],
          },
        });
      if (path.endsWith("/queue-inventory"))
        return route.fulfill({
          json: {
            agentId: path.split("/").at(-2),
            providerOrgId: provider,
            schedulerType: "slurm",
            status: "available",
            queues: [{ queueName: "batch", isDefault: true }],
            managedTargets: [],
          },
        });
      throw new Error(`Unexpected request: ${path}`);
    });
    await page.goto("https://queue-ui.invalid");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: javascript });
    await page.getByTestId("cp-queues-create").click();
    const dialog = page.getByRole("dialog").first();
    const body = dialog.locator("form > div").nth(1);
    const submit = page.getByTestId("cp-queue-submit");
    await expect(submit).toBeInViewport();
    await body.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(submit).toBeInViewport();
    await body.hover();
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
    await page.getByTestId("cp-queue-field-agent-id-trigger").click();
    const list = page.locator("[cmdk-list]");
    await expect(list).toBeVisible();
    const search = page.locator("[cmdk-input]");
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS("outline-style", "none");
    await list.hover();
    await page.mouse.wheel(0, 450);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.mouse.wheel(0, 5000);
    await expect(page.getByRole("option", { name: /代理 29/ })).toBeInViewport({ ratio: 1 });
    await list.hover();
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
    await page.screenshot({ path: info.outputPath("queue-dropdown.png") });
    await search.fill("代理 29");
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(submit).toBeInViewport();
    await expect(dialog.getByRole("heading")).toBeInViewport();
    await expect(page.getByTestId("cp-queue-field-agent-id-trigger")).toContainText("agent-29");
    await page.getByTestId("cp-queue-field-provider-org-id-trigger").click();
    await page.getByRole("option", { name: "算力中心 B", exact: true }).click();
    await page.getByTestId("cp-queue-field-agent-id-trigger").click();
    await expect(page.getByRole("option", { name: /其他组织代理/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /代理 29/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await page.getByRole("combobox", { name: "外部选择", exact: true }).click();
    await list.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "其他表单", exact: true }).click();
    const other = page.getByRole("dialog", { name: "其他表单" });
    await other.locator("form").hover();
    await page.mouse.wheel(0, 2000);
    await expect(other.getByRole("button", { name: "完成" })).toBeInViewport();
    await other.getByRole("button", { name: "完成" }).click();
    expect(errors).toEqual([]);
  });
}
