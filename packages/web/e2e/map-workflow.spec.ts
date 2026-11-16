import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "patchright/test";

const webRoot = resolve(import.meta.dirname, "..");
let javascript = "";
let css = "";
test.beforeAll(() => {
  const output = resolve(webRoot, "test-results/map-workflow-bundle");
  mkdirSync(output, { recursive: true });
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/map-workflow.tsx",
      "--target=browser",
      "--format=iife",
      "--define",
      'import.meta.env={"MODE":"test"}',
      "--outdir",
      output,
    ],
    { cwd: webRoot },
  );
  javascript = readFileSync(resolve(output, "map-workflow.js"), "utf8");
  css = readdirSync(resolve(webRoot, "dist/assets"))
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(resolve(webRoot, "dist/assets", file), "utf8"))
    .join("\n");
});
async function open(page: Page, query: string, theme: string) {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.route("**/*", async (route) => {
    if (route.request().isNavigationRequest())
      await route.fulfill({
        contentType: "text/html",
        body: '<html><body><div id="root"></div></body></html>',
      });
    else await route.abort();
  });
  await page.goto(`https://visual-review.invalid/workflows/new?${query}`);
  await page.evaluate((value) => localStorage.setItem("kq.theme", value), theme);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
}
for (const width of [390, 974, 1449])
  for (const theme of ["light", "dark"])
    for (const lang of ["zh", "en"]) {
      test(`workflow steps ${width} ${theme} ${lang}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await open(page, `draftId=demo&lang=${lang}`, theme);
        await expect(page.getByTestId("rf-shell")).toBeVisible();
        for (const step of ["edit", "inputs", "resources", "review"]) {
          if (step !== "edit") await page.getByTestId(`workflow-step-${step}`).click();
          if (step === "resources") {
            const confirm = page.getByTestId("workflow-association-confirm-continue");
            if (await confirm.isVisible()) await confirm.click();
          }
          await expect(page.getByTestId(`workflow-step-${step}`)).toHaveAttribute(
            "aria-current",
            "step",
          );
          if (step === "resources") {
            const field = page.getByTestId("workflow-resource-data-movement");
            await field.scrollIntoViewIfNeeded();
            expect(
              await field.evaluate((element) => {
                const box = element.getBoundingClientRect();
                for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                  if (
                    ["hidden", "clip"].includes(getComputedStyle(parent).overflowY) &&
                    box.bottom > parent.getBoundingClientRect().bottom + 1
                  )
                    return false;
                }
                return true;
              }),
            ).toBe(true);
            await page.evaluate(() => scrollTo(0, 0));
          }
          const panels = page.locator('[data-workflow-panel="true"]');
          expect(await panels.count()).toBeGreaterThan(1);
          for (const panel of await panels.all()) {
            await expect(panel).toHaveCSS("border-top-width", "1px");
            expect(
              await panel.evaluate((element) => getComputedStyle(element).backgroundColor),
            ).not.toBe("rgba(0, 0, 0, 0)");
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.screenshot({ path: info.outputPath(`${step}.png`), fullPage: true });
        }
        await page.getByTestId("workflow-step-inputs").click();
        const parameter = page.getByTestId("workflow-value-param:sample");
        await parameter.fill("retained-input");
        await page.getByTestId("workflow-step-resources").click();
        const confirm = page.getByTestId("workflow-association-confirm-continue");
        if (await confirm.isVisible()) await confirm.click();
        await page.getByTestId("workflow-step-inputs").click();
        await expect(parameter).toHaveValue("retained-input");
      });
    }
test("workflow start options retain card boundaries", async ({ page }, info) => {
  await open(page, "", "light");
  await expect(page.getByTestId("workflow-start-overlay")).toBeVisible();
  await expect(page.getByTestId("workflow-start-scratch")).toHaveCSS("border-top-width", "1px");
  await expect(page.getByTestId("workflow-start-template")).toHaveCSS("border-top-width", "1px");
  await page.screenshot({ path: info.outputPath("workflow-start.png"), fullPage: true });
});
test("diagram views, collapse and central appearance settings", async ({ page }, info) => {
  await page.setViewportSize({ width: 1449, height: 770 });
  await open(page, "fixture=maps", "light");
  await expect(page.getByRole("tab", { name: "数据概览" })).toBeVisible();
  await page.getByRole("tab", { name: "资源关系" }).click();
  await page.locator(".function-map-node").filter({ hasText: "提供方资料" }).click();
  await expect(page.getByRole("dialog")).toContainText("主要功能");
  await expect(page.getByRole("dialog")).toContainText("算力中心 / 运营资料");
  const popup = page.getByRole("dialog");
  await expect(popup).toHaveCSS("opacity", "1");
  await expect(popup).toBeVisible();
  expect(
    await popup.evaluate((element) =>
      element.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)),
    ),
  ).toBe(true);
  const bounds = await popup.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds) {
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1449);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(770);
  }
  await popup.screenshot({ path: info.outputPath("node-details.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "个人中心", exact: true }).click();
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(page.locator(".function-map-canvas")).toBeHidden();
  await page.getByRole("button", { name: "外观与界面", exact: true }).click();
  await page.getByLabel("连线效果").selectOption("flow");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.screenshot({ path: info.outputPath("preferences.png"), fullPage: true });
  await page.getByRole("button", { name: "算力中心", exact: true }).click();
  await expect(page.getByRole("tab", { name: "资源关系" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".function-map-canvas")).toHaveAttribute("data-flow", "true");
  await page.screenshot({ path: info.outputPath("resource-view.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".function-map-canvas")).toBeHidden();
  await expect(page.getByTestId("cp-kpi-jobsCompleted")).toBeVisible();
  await page.setViewportSize({ width: 1449, height: 770 });
  await page.getByRole("button", { name: "个人中心", exact: true }).click();
  await expect(page.getByRole("button", { name: "展开", exact: true })).toBeVisible();
});
