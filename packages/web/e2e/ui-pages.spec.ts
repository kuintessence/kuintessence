import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "patchright/test";

const webRoot = resolve(import.meta.dirname, "..");
let css = "";
let javascript = "";
test.beforeAll(() => {
  const bundleDir = resolve(webRoot, "test-results/ui-pages-bundle");
  mkdirSync(resolve(webRoot, "test-results"), { recursive: true });
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/ui-pages.tsx",
      "--target=browser",
      "--format=iife",
      "--outdir",
      bundleDir,
    ],
    { cwd: webRoot },
  );
  javascript = readFileSync(resolve(bundleDir, "ui-pages.js"), "utf8");
  css = readdirSync(resolve(webRoot, "dist/assets"))
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(resolve(webRoot, "dist/assets", name), "utf8"))
    .join("\n");
});
for (const width of [320, 768, 1280]) {
  for (const theme of ["light", "dark"]) {
    for (const route of ["jobs", "software", "workflows", ...(width === 320 ? ["runtime"] : [])]) {
      test(`${route} page at ${width}px in ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 960 });
        await page.clock.setFixedTime(new Date("2026-01-02T08:00:00Z"));
        const errors: string[] = [];
        const unexpectedRequests: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", async (request) => {
          if (request.request().isNavigationRequest()) {
            await request.fulfill({
              contentType: "text/html",
              body: `<html lang="zh" class="${theme}"><body><div id="root"></div></body></html>`,
            });
          } else {
            unexpectedRequests.push(request.request().url());
            await request.abort();
          }
        });
        await page.goto(`https://kq-ui.invalid/${route}`);
        await page.addStyleTag({ content: css });
        // Pin fonts available in local Linux and CI; production keeps its own font stack.
        await page.addStyleTag({
          content:
            ':root { --font-sans: "Noto Sans CJK SC", sans-serif; --font-mono: "Liberation Mono", monospace; }',
        });
        await page.addScriptTag({ content: javascript });
        if (route === "jobs") {
          await expect(page.getByTestId("jobs-pagination")).toBeVisible();
          if (width === 320) {
            const boxes = await Promise.all(
              [
                "jobs-status-select",
                "jobs-scope-filter",
                "jobs-submit-button",
                "jobs-submit-menu",
              ].map((id) => page.getByTestId(id).boundingBox()),
            );
            const [status, scope, submit, menu] = boxes;
            if (!status || !scope || !submit || !menu) throw new Error("Missing job controls");
            expect(Math.abs(status.y - scope.y)).toBeLessThan(2);
            expect(Math.abs(status.x - submit.x)).toBeLessThan(2);
            expect(Math.abs(scope.x + scope.width - menu.x - menu.width)).toBeLessThan(2);
            expect(submit.width).toBeGreaterThan(180);
            expect(menu.width).toBe(36);
          }
        } else if (route === "software") {
          await expect(page.getByTestId("software-card-demo-template-0")).toBeVisible();
          const widths = await page
            .getByTestId("software-grid")
            .locator(":scope > div")
            .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width));
          expect(widths.length).toBe(3);
          expect(widths.every((cardWidth) => cardWidth >= Math.min(320, width - 32))).toBe(true);
        } else if (route === "workflows") {
          await expect(page.getByRole("button", { name: /演示材料计算/ })).toBeVisible();
        } else {
          await expect(page.getByTestId("runtime-material-readonly-summary")).toBeVisible();
          await expect(page.getByText(/demo-local-pbe/)).toBeVisible();
          await expect(page.getByRole("textbox")).toHaveCount(0);
          await expect(page.locator('button[type="submit"]')).toHaveCount(0);
        }
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await expect(page).toHaveScreenshot(`${route}-${width}-${theme}.png`, { fullPage: true });
        expect(errors).toEqual([]);
        expect(unexpectedRequests).toEqual([]);
      });
    }
  }
}
