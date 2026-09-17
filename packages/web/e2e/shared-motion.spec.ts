import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "patchright/test";

const webRoot = resolve(import.meta.dirname, "..");
const bundle = resolve(webRoot, "test-results/motion-fixture.js");
let css = "";
let javascript = "";

test.beforeAll(() => {
  mkdirSync(resolve(webRoot, "test-results"), { recursive: true });
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/shared-motion.tsx",
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
  await page.setContent('<html><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
});

for (const width of [1280, 390, 320]) {
  test(`dialog stays centered during real CSS animation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole("button", { name: "Open dialog", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const geometry = await dialog.evaluate((element) => {
      const animation = element.getAnimations()[0];
      if (!animation) throw new Error("Expected a real enter animation");
      animation.pause();
      animation.currentTime = 80;
      const rect = element.getBoundingClientRect();
      return {
        centerX: rect.x + rect.width / 2,
        centerY: rect.y + rect.height / 2,
        fill: getComputedStyle(element).animationFillMode,
        name: getComputedStyle(element).animationName,
      };
    });
    expect(geometry.name).toBe("kq-dialog-enter");
    expect(geometry.fill).toBe("both");
    expect(Math.abs(geometry.centerX - width / 2)).toBeLessThan(1);
    expect(Math.abs(geometry.centerY - 400)).toBeLessThanOrEqual(6);
    await page.screenshot({ path: info.outputPath(`dialog-${width}.png`) });
    await dialog.evaluate((element) => {
      for (const animation of element.getAnimations()) animation.finish();
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".kq-motion--overlay")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open dialog", exact: true })).toBeFocused();
  });
}

for (const width of [320, 390, 639, 640, 1280]) {
  for (const surface of ["dialog", "left sheet", "right sheet"]) {
    test(`${surface} reserves header space for close control at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const trigger = page.getByRole("button", { name: `Open ${surface}`, exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog");
      const geometry = await dialog.evaluate((element) => {
        const close = element.querySelector('[aria-label="Close"]');
        const header = element.querySelector('[data-testid="motion-header"]');
        const footer = element.querySelector('[data-testid="motion-footer"]');
        if (!close || !header || !footer) throw new Error("Expected complete panel sections");
        const closeRect = close.getBoundingClientRect();
        const panelRect = element.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        return {
          closeWidth: closeRect.width,
          closeHeight: closeRect.height,
          textGaps: Array.from(header.children, (child) => {
            return closeRect.left - child.getBoundingClientRect().right;
          }),
          left: panelRect.left,
          right: panelRect.right,
          footerBottom: footerRect.bottom,
          overflow: element.scrollWidth > element.clientWidth,
        };
      });
      await page.screenshot({
        path: info.outputPath(`header-${surface.replaceAll(" ", "-")}-${width}.png`),
      });
      expect(geometry.closeWidth).toBeGreaterThanOrEqual(44);
      expect(geometry.closeHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.textGaps).toHaveLength(2);
      for (const gap of geometry.textGaps) expect(gap).toBeGreaterThanOrEqual(8);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.footerBottom).toBeLessThanOrEqual(width === 320 ? 568 : 844);
      expect(geometry.overflow).toBe(false);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
}

for (const side of ["left", "right"]) {
  test(`${side} sheet keeps its exit nodes and cleans the portal`, async ({ page }) => {
    await page.getByRole("button", { name: `Open ${side} sheet` }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    const exiting = page.locator('.kq-motion--sheet[data-state="closed"]');
    const exitName = await exiting.evaluate((element) => getComputedStyle(element).animationName);
    expect(exitName).toBe(`kq-sheet-${side}-exit`);
    await expect(page.locator(".kq-motion--sheet")).toHaveCount(0);
    await expect(page.locator(".kq-motion--sheet-overlay")).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Open ${side} sheet` })).toBeFocused();
  });
}

test("reduced motion removes animations without losing focus or leaving overlays", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  const dialog = page.getByRole("dialog");
  expect(await dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".kq-motion--overlay")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open dialog", exact: true })).toBeFocused();
});

test("deletion snapshot stays readable while repeat confirmation is disabled", async ({ page }) => {
  await page.getByRole("button", { name: "Open deletion" }).click();
  await page.getByTestId("files-delete-confirm").click();
  const closing = page.getByTestId("files-delete-dialog");
  const snapshot = await closing.evaluate((element) => {
    const button = element.querySelector<HTMLButtonElement>('[data-testid="files-delete-confirm"]');
    button?.click();
    return { text: element.textContent, disabled: button?.disabled };
  });
  expect(snapshot.text).toContain("results/output.txt");
  expect(snapshot.disabled).toBe(true);
  await expect(page.getByTestId("deletions")).toHaveText("1");
  await expect(closing).toHaveCount(0);
  await expect(page.locator(".kq-motion--overlay")).toHaveCount(0);
});
