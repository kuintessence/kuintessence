import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "patchright/test";

const webRoot = resolve(import.meta.dirname, "..");
const artifacts = resolve(webRoot, "../../artifacts/ui-unification-implemented");
let css = "";
let javascript = "";
test.beforeAll(() => {
  const bundle = resolve(webRoot, "test-results/ui-unification-bundle");
  mkdirSync(artifacts, { recursive: true });
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/ui-unification.tsx",
      "--target=browser",
      "--format=iife",
      "--define",
      'import.meta.env={"MODE":"test"}',
      "--outdir",
      bundle,
    ],
    { cwd: webRoot },
  );
  javascript = readFileSync(resolve(bundle, "ui-unification.js"), "utf8");
  css = readdirSync(resolve(webRoot, "dist/assets"))
    .filter((file) => file.endsWith(".css"))
    .map((file) => readFileSync(resolve(webRoot, "dist/assets", file), "utf8"))
    .join("\n");
});
for (const width of [320, 768, 1440])
  for (const theme of ["light", "dark"])
    for (const lang of ["zh", "en"]) {
      test(`resource selection ${width} ${theme} ${lang}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        const errors: string[] = [];
        const requests: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", async (route) => {
          if (route.request().isNavigationRequest())
            await route.fulfill({
              contentType: "text/html",
              body: `<html lang="${lang}" class="${theme}"><body><div id="root"></div></body></html>`,
            });
          else {
            requests.push(route.request().url());
            await route.abort();
          }
        });
        await page.goto(`https://kq-ui.invalid/?lang=${lang}`);
        await page.addScriptTag({
          content:
            'document.documentElement.dataset.kqUiErrors = "[]"; const record = (message) => { const errors = JSON.parse(document.documentElement.dataset.kqUiErrors); errors.push(message); document.documentElement.dataset.kqUiErrors = JSON.stringify(errors); }; addEventListener("error", (event) => record(event.message)); addEventListener("unhandledrejection", (event) => record(String(event.reason)));',
        });
        await page.addStyleTag({ content: css });
        await page.addStyleTag({
          content:
            ':root { --font-sans: "Noto Sans CJK SC", sans-serif; --font-mono: "Liberation Mono", monospace; }',
        });
        await page.addScriptTag({ content: javascript });
        const queue = lang === "zh" ? "计算队列" : "Compute queue";
        const modal = lang === "zh" ? "弹层队列" : "Modal queue";
        const search = lang === "zh" ? "搜索选项" : "Search options";
        const confirm = lang === "zh" ? "确认" : "Confirm";
        const cancel = lang === "zh" ? "取消" : "Cancel";
        const expand = lang === "zh" ? "展开选择" : "Expand selection";
        await expect(page.getByTestId("rf-editor")).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        const flat = async () =>
          expect(
            await page.locator('[data-kq-surface="section"]').evaluateAll((sections) =>
              sections.every((element) => {
                const style = getComputedStyle(element);
                return (
                  style.backgroundColor === "rgba(0, 0, 0, 0)" &&
                  (style.boxShadow === "none" ||
                    (style.boxShadow.match(/-?[\d.]+px/g) ?? []).every(
                      (value) => Number.parseFloat(value) === 0,
                    )) &&
                  parseFloat(style.borderTopWidth) === 0 &&
                  parseFloat(style.borderLeftWidth) === 0 &&
                  parseFloat(style.borderRadius) === 0
                );
              }),
            ),
          ).toBe(true);
        await flat();
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: resolve(artifacts, `overview-${width}-${theme}-${lang}.png`),
          fullPage: true,
        });
        await page.getByRole("combobox", { name: queue, exact: true }).click();
        await expect(
          page.getByText(lang === "zh" ? "最近选择" : "Recently selected", { exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: resolve(artifacts, `dropdown-${width}-${theme}-${lang}.png`),
          fullPage: true,
        });
        const input = page.getByRole("combobox", { name: search, exact: true });
        await input.fill("west");
        await input.press("ArrowDown");
        await input.press("Enter");
        await expect(page.getByTestId("selected-a").first()).toContainText("gpu");
        await expect(page.getByRole("combobox", { name: queue, exact: true })).toBeFocused();
        await page.getByRole("combobox", { name: modal, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: modal });
        await dialog.getByRole("textbox", { name: search, exact: true }).fill("gpu");
        await dialog.getByRole("radio", { name: /GPU/ }).check();
        await dialog.getByRole("button", { name: cancel, exact: true }).click();
        await expect(page.getByTestId("selected-b").first()).toContainText("cpu");
        await page.getByRole("combobox", { name: modal, exact: true }).click();
        await dialog.getByRole("textbox", { name: search, exact: true }).fill("");
        await expect(dialog.getByRole("radio")).toHaveCount(10);
        await page.screenshot({
          path: resolve(artifacts, `dialog-${width}-${theme}-${lang}.png`),
          fullPage: false,
        });
        await dialog.getByRole("textbox", { name: search, exact: true }).fill("gpu");
        await dialog.getByRole("radio", { name: /GPU/ }).check();
        await dialog.getByRole("button", { name: confirm, exact: true }).click();
        await expect(page.getByTestId("selected-b").first()).toContainText("gpu");
        // A dropdown expanded inside a form dialog must retain Radix's nested focus containment.
        await page
          .getByRole("button", { name: lang === "zh" ? "在表单中选择" : "Choose in a form" })
          .click();
        const formDialog = page.getByRole("dialog", {
          name: lang === "zh" ? "作业资源配置" : "Job resources",
        });
        await formDialog.getByRole("combobox", { name: queue, exact: true }).click();
        await page.getByRole("button", { name: expand, exact: true }).click();
        const expanded = page.getByRole("dialog", { name: queue, exact: true });
        await expect(expanded).toBeVisible();
        await expect(expanded.getByRole("textbox", { name: search, exact: true })).toBeFocused();
        await expanded.getByRole("button", { name: cancel, exact: true }).click();
        await expect(formDialog.getByRole("combobox", { name: queue, exact: true })).toBeFocused();
        await flat();
        expect(errors).toEqual([]);
        expect(
          await page.evaluate(() =>
            JSON.parse(document.documentElement.dataset.kqUiErrors ?? "null"),
          ),
        ).toEqual([]);
        expect(requests).toEqual([]);
      });
    }
