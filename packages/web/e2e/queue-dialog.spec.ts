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

test("queue list sorts, filters and resizes while keeping actions readable", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1161, height: 770 });
  const queues = ["Zeta", "Alpha"].map((name, index) => ({
    queueId: name,
    name,
    providerOrgId: provider,
    visibleOrgIds: [otherProvider],
    agentId: "lab-slurm",
    schedulerType: "slurm",
    queueName: "batch",
    qos: null,
    enabled: index === 1,
    policyTags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }));
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.isNavigationRequest()) {
      return route.fulfill({
        contentType: "text/html",
        body: '<html lang="zh"><body><main id="root" style="max-width:850px;margin:0 auto"></main></body></html>',
      });
    }
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/admin/queues")) return route.fulfill({ json: { queues } });
    if (path.endsWith("/cp/agents")) return route.fulfill({ json: { items: [] } });
    if (path.endsWith("/cp/agent-registration-context"))
      return route.fulfill({ json: { providerOrgs: [], schedulers: ["slurm"] } });
    if (path.endsWith("/me/active-organization"))
      return route.fulfill({ json: { activeOrganizationId: null, organizations: [] } });
    return route.abort();
  });
  await page.goto("https://queue-table.invalid");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });

  const table = page.getByTestId("cp-queues-table-scroll");
  const rows = table.locator("tbody tr");
  await expect(rows.first()).toContainText("Zeta");
  await table.getByRole("button", { name: "队列", exact: true }).click();
  await expect(rows.first()).toContainText("Alpha");

  const resize = table.getByRole("separator", { name: "调整队列列宽", exact: true });
  const width = Number(await resize.getAttribute("aria-valuenow"));
  const handle = await resize.boundingBox();
  if (!handle) throw new Error("Queue column resize handle is missing");
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 64, y, { steps: 6 });
  await page.mouse.up();
  await expect(resize).toHaveAttribute("aria-valuenow", String(width + 64));
  await resize.press("ArrowLeft");
  await expect(resize).toHaveAttribute("aria-valuenow", String(width + 48));
  await resize.press("Home");
  await expect(resize).toHaveAttribute("aria-valuenow", String(width));

  const actionCell = rows.first().locator("td").last();
  await table.evaluate((element) => {
    element.scrollLeft = 120;
  });
  await expect(actionCell).toHaveCSS("position", "sticky");
  const style = await actionCell.evaluate((cell) => ({
    background: getComputedStyle(cell).backgroundColor,
    edge: getComputedStyle(cell, "::before").backgroundImage,
  }));
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.edge).toContain("linear-gradient");
  await expect(actionCell.getByRole("button", { name: "编辑" })).toBeInViewport();
  await page.screenshot({ path: info.outputPath("queue-list-desktop.png") });

  await page.getByRole("combobox", { name: "发布状态" }).selectOption("disabled");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Zeta");
  await page.setViewportSize({ width: 390, height: 640 });
  await expect(actionCell).toHaveCSS("position", "static");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: info.outputPath("queue-list-mobile.png") });
});
