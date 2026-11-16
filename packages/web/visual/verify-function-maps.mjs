import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "patchright";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const review = path.join(project, ".impeccable/review");
const build = path.join(review, "function-maps-build/function-maps.html");
const catalog = JSON.parse(
  await fs.readFile(
    path.join(project, "packages/web/src/components/function-maps/catalog.json"),
    "utf8",
  ),
);
const widths = process.env.KQ_MAP_WIDTH ? [Number(process.env.KQ_MAP_WIDTH)] : [1440, 390, 320];
assert.ok(widths.every((width) => [1440, 390, 320].includes(width)));
const themes = process.env.KQ_MAP_THEME ? [process.env.KQ_MAP_THEME] : ["light", "dark"];
assert.ok(themes.every((theme) => ["light", "dark"].includes(theme)));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.KQ_CHROMIUM_PATH ??
    "/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
  args: ["--no-sandbox", "--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 770 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(pathToFileURL(build).href);
  await page.locator("[data-map-id]").waitFor();
  let renders = 0;
  let activations = 0;
  const captures = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 770 });
    for (const theme of themes) {
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      for (const language of ["zh", "en"]) {
        await page.getByLabel("Language", { exact: true }).selectOption(language);
        for (const model of catalog) {
          await page.getByLabel("Map", { exact: true }).selectOption(model.id);
          const root = page.locator(`[data-map-id="${model.id}"]`);
          await root.waitFor({ state: "attached" });
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            `${model.id}: page overflow at ${width}`,
          );
          renders++;
          if (width < 768) {
            assert.equal(
              await root.isVisible(),
              false,
              `${model.id}: map must be hidden at ${width}`,
            );
            assert.equal(await page.locator(".function-map-mobile-node").count(), 0);
            continue;
          }
          assert.ok(await root.isVisible());
          assert.equal(await root.locator("details").count(), 0);
          const canvas = root.locator(".function-map-canvas");
          assert.ok(
            await canvas.evaluate(
              (el) =>
                el.scrollWidth <= el.clientWidth &&
                el.scrollHeight <= el.clientHeight &&
                el.clientHeight <= Math.min(360, window.innerHeight * 0.46) + 1,
            ),
            `${model.id}: map does not fit`,
          );
          const region = page.locator('[data-kq-surface="region"]').first();
          assert.ok(
            await region.evaluate((el) => {
              const style = getComputedStyle(el);
              return (
                style.borderRadius === "0px" &&
                style.borderTopWidth === "0px" &&
                style.backgroundColor === "rgba(0, 0, 0, 0)"
              );
            }),
            "page must have no card shell",
          );
          assert.ok(
            await root
              .locator(".function-map-connection")
              .evaluateAll((nodes) =>
                nodes.every(
                  (el) =>
                    getComputedStyle(el).stroke !== "none" &&
                    parseFloat(getComputedStyle(el).strokeWidth) > 0,
                ),
              ),
            `${model.id}: invisible connection`,
          );
          const nodes = root.locator("foreignObject button");
          assert.ok(
            await nodes.evaluateAll((buttons) =>
              buttons.every((button) => {
                const icon = button.querySelector("svg[data-function-map-icon]");
                return (
                  icon &&
                  icon.namespaceURI === "http://www.w3.org/2000/svg" &&
                  icon.children.length > 0 &&
                  button.scrollHeight <= button.clientHeight
                );
              }),
            ),
            `${model.id}: clipped node content or missing icon`,
          );
          const before = await root.boundingBox();
          for (let i = 0; i < (await nodes.count()); i++) {
            await nodes.nth(i).click();
            const dialog = page.getByRole("dialog");
            await dialog.waitFor();
            assert.ok(
              await dialog.evaluate((el) => {
                const bounds = el.getBoundingClientRect();
                return (
                  bounds.top >= 0 &&
                  bounds.left >= 0 &&
                  bounds.bottom <= window.innerHeight &&
                  bounds.right <= window.innerWidth
                );
              }),
              `${model.id}: popup exceeds viewport`,
            );
            assert.equal(await dialog.getByRole("heading").count(), 1);
            assert.equal(
              (await root.boundingBox()).height,
              before.height,
              "popup must not expand the map",
            );
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "hidden" });
            await page.waitForFunction(
              (element) => document.activeElement === element,
              await nodes.nth(i).elementHandle(),
              { timeout: 2000 },
            );
            activations++;
          }
          if (language === "zh" && ["G10", "D01", "G01", "T01", "G25"].includes(model.id)) {
            const file = `${model.id}-flat-${theme}-${width}.png`;
            await page.screenshot({
              path: path.join(review, file),
              fullPage: true,
              animations: "disabled",
            });
            captures.push(file);
            if (model.id === "G10") {
              await nodes.last().click();
              const popup = `${model.id}-popup-${theme}-${width}.png`;
              await page.screenshot({ path: path.join(review, popup), animations: "disabled" });
              captures.push(popup);
              await page.keyboard.press("Escape");
            }
          }
        }
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 770 });
  await page.getByLabel("Language", { exact: true }).selectOption("en");
  await page.getByLabel("Map", { exact: true }).selectOption("G10");
  const canvas = page.locator(".function-map-canvas");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Connections", { exact: true }).selectOption("flow");
  await page.getByLabel("Line color", { exact: true }).selectOption("brand");
  await page.getByRole("slider", { name: /Line width/ }).focus();
  await page.keyboard.press("End");
  await page.getByRole("slider", { name: /Flow duration/ }).focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowRight");
  assert.ok(
    await page
      .locator(".function-map-flow")
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return (
          style.animationName === "function-map-flow" &&
          style.animationDuration === "4s" &&
          style.strokeWidth === "3px" &&
          style.stroke !== "none"
        );
      }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".function-map-flow")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByLabel("Connections", { exact: true }).selectOption("static");
  assert.equal(await page.locator(".function-map-flow").count(), 0);
  await page.keyboard.press("Escape");
  const node = page.locator("foreignObject button").first();
  await node.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(200);
  await page.mouse.click(8, 8);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.evaluate(() => {
    const tail = document.createElement("div");
    tail.id = "wheel-check";
    tail.style.height = "1200px";
    document.body.append(tail);
  });
  await canvas.hover();
  await page.mouse.wheel(0, 180);
  await page.waitForFunction(() => window.scrollY > 0);
  assert.equal(await canvas.evaluate((el) => el.scrollTop), 0, "wheel must scroll the page");
  await page.evaluate(() => {
    document.getElementById("wheel-check")?.remove();
    window.scrollTo(0, 0);
  });
  await node.click();
  await page.getByRole("dialog").waitFor();
  await page.setViewportSize({ width: 767, height: 770 });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-map-id]").isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 770 });
  await page.getByLabel("Map", { exact: true }).selectOption("G05");
  for (const state of ["loading", "forbidden", "error", "ready"]) {
    await page.getByLabel("Demo state", { exact: true }).selectOption(state);
    assert.equal(await page.locator("[data-map-id=G05]").count(), 1);
  }
  assert.deepEqual(errors, []);
  const report = {
    renders,
    activations,
    widths,
    themes,
    languages: ["zh", "en"],
    popup: "contained, no layout growth, Escape and outside click, focus restored",
    appearance: "static/flow, color, width, duration, reduced motion",
    scroll: "wheel scrolls page",
    smallScreen: "hidden below 768px",
    errors,
    captures,
  };
  await fs.writeFile(
    path.join(
      review,
      widths.length === 1
        ? `function-maps-verification-${widths[0]}-${themes.join("-")}.json`
        : "function-maps-verification.json",
    ),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
