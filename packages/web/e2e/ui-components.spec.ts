import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "patchright/test";

const webRoot = resolve(import.meta.dirname, "..");
let css = "";
let javascript = "";

test.beforeAll(() => {
  const bundle = resolve(webRoot, "test-results/ui-components.js");
  mkdirSync(resolve(webRoot, "test-results"), { recursive: true });
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/ui-components.tsx",
      "--target=browser",
      "--format=iife",
      "--outfile",
      bundle,
    ],
    { cwd: webRoot },
  );
  javascript = readFileSync(bundle, "utf8");
  const assets = resolve(webRoot, "dist/assets");
  css = readdirSync(assets)
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(resolve(assets, name), "utf8"))
    .join("\n");
});

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.setContent('<html lang="zh"><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(page.getByRole("heading", { name: "作业", exact: true })).toBeVisible();
});

for (const width of [320, 768, 1280]) {
  for (const theme of ["light", "dark"]) {
    test(`controls and empty state fit ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 960 });
      if (theme === "dark") await page.getByRole("button", { name: "切换主题" }).click();
      const account = page.getByRole("combobox", { name: "执行账号" });
      expect(await account.evaluate((node) => getComputedStyle(node).colorScheme)).toBe(theme);
      if (width === 320) {
        expect(
          await page
            .getByTestId("jobs-search")
            .evaluate((node) => node.getBoundingClientRect().width),
        ).toBeGreaterThanOrEqual(280);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: info.outputPath(`components-${width}-${theme}.png`),
        fullPage: true,
      });
      await page.getByTestId("jobs-search").fill("missing");
      await expect(page.getByRole("cell")).toHaveText("暂无记录");
      expect(
        await page
          .getByRole("table")
          .evaluate((node) => node.getBoundingClientRect().right <= innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`empty-${width}-${theme}.png`),
        fullPage: true,
      });
    });
  }
}

test("Radix status selection supports keyboard navigation and retains one selection", async ({
  page,
}) => {
  const all = page.getByTestId("status-chip-all");
  await all.focus();
  await page.keyboard.press("ArrowRight");
  const next = page.getByTestId("status-chip-pending");
  await expect(next).toBeFocused();
  await page.keyboard.press("Space");
  await expect(next).toHaveAttribute("aria-checked", "true");
  await next.click();
  await expect(next).toHaveAttribute("aria-checked", "true");
  await expect(all).toHaveAttribute("aria-checked", "false");
});

test("sorting, pagination and native form semantics work together", async ({ page }) => {
  await page.getByRole("button", { name: "作业名称", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "作业名称" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("cell").first()).toHaveText("演示作业 11");
  const size = page.getByRole("combobox", { name: "每页条数" });
  await size.selectOption("50");
  await expect(page.locator("tbody tr")).toHaveCount(32);
  await expect(size).toBeVisible();
  const account = page.getByRole("combobox", { name: "执行账号" });
  expect(await account.evaluate((node: HTMLSelectElement) => node.checkValidity())).toBe(false);
  await account.selectOption("research");
  expect(await account.evaluate((node: HTMLSelectElement) => node.checkValidity())).toBe(true);
  expect(
    await account.evaluate(
      (node: HTMLSelectElement) => node.form && new FormData(node.form).get("account"),
    ),
  ).toBe("research");
  await expect(page.getByRole("combobox", { name: "当前集群" })).toBeDisabled();
  expect(
    await account.evaluate(
      (node: HTMLSelectElement) => node.form && new FormData(node.form).has("disabled"),
    ),
  ).toBe(false);
});

test("transfer filters share keyboard selection and retain the selected status", async ({
  page,
}) => {
  const active = page.getByTestId("files-transfers-filter-active");
  const failed = page.getByTestId("files-transfers-filter-failed");
  await active.focus();
  await page.keyboard.press("ArrowRight");
  await expect(failed).toBeFocused();
  await page.keyboard.press("Space");
  await expect(failed).toHaveAttribute("aria-checked", "true");
  await failed.click();
  await expect(failed).toHaveAttribute("aria-checked", "true");
  await expect(active).toHaveAttribute("aria-checked", "false");
});
