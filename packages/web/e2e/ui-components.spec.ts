import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Locator, test } from "patchright/test";

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

async function expectFilledRows(container: Locator) {
  const rows = await container.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const left =
      bounds.left + Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth);
    const right =
      bounds.right -
      Number.parseFloat(style.paddingRight) -
      Number.parseFloat(style.borderRightWidth);
    const rows: { center: number; left: number; right: number }[] = [];
    for (const child of node.children) {
      const box = child.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const row = rows.find((row) => Math.abs(row.center - (box.top + box.height / 2)) < 2);
      if (row) {
        row.left = Math.min(row.left, box.left);
        row.right = Math.max(row.right, box.right);
      } else {
        rows.push({ center: box.top + box.height / 2, left: box.left, right: box.right });
      }
    }
    return rows.map((row) => ({ leftGap: row.left - left, rightGap: right - row.right }));
  });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(Math.abs(row.leftGap)).toBeLessThan(2);
    expect(Math.abs(row.rightGap)).toBeLessThan(2);
  }
}

for (const width of [320, 360, 390, 480, 640, 768, 1024, 1280]) {
  test(`wrapped controls fill each row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await expectFilledRows(page.getByTestId("jobs-search").locator("../.."));
    await expectFilledRows(page.getByTestId("jobs-submit-button").locator(".."));
    if (width >= 640) await expectFilledRows(page.getByTestId("jobs-status-filter"));
    await expectFilledRows(page.getByRole("tablist", { name: "演示详情" }));
    await expectFilledRows(page.getByRole("radiogroup", { name: "传输列表" }));
    await expectFilledRows(page.getByRole("button", { name: "下一页", exact: true }).locator(".."));
    await expectFilledRows(page.getByTestId("demo-footer"));
    const menu = await page.getByTestId("jobs-submit-menu").boundingBox();
    expect(menu?.width).toBe(36);
    await page.getByTestId("jobs-submit-menu").click();
    await page.getByTestId("jobs-submit-upload").click();
    await expect(page.getByRole("status")).toHaveText("演示操作：导入 JSON");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
