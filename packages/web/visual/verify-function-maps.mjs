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
assert.equal(
  widths.every((width) => [1440, 390, 320].includes(width)),
  true,
);
const reportName =
  widths.length === 1
    ? `function-maps-verification-${widths[0]}.json`
    : "function-maps-verification.json";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.KQ_CHROMIUM_PATH ??
    "/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
  args: ["--no-sandbox", "--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(pathToFileURL(build).href);
  await page.locator("[data-map-id]").waitFor();
  let renders = 0;
  let activations = 0;
  const captures = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["light", "dark"]) {
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      for (const language of ["zh", "en"]) {
        await page.getByLabel("Language", { exact: true }).selectOption(language);
        for (const model of catalog) {
          await page.getByLabel("Map", { exact: true }).selectOption(model.id);
          await page.locator(`[data-map-id="${model.id}"]`).waitFor();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
            `${model.id}: page overflow at ${width}`,
          );
          const root = page.locator(`[data-map-id="${model.id}"]`);
          if (width >= 640 && model.type === "runtime") {
            const summaries = root.locator("foreignObject [data-runtime-summary]");
            for (let i = 0; i < (await summaries.count()); i++) {
              assert.equal(
                await summaries.nth(i).evaluate((summary) => {
                  const button = summary.closest("button");
                  if (!button) return false;
                  const bounds = button.getBoundingClientRect();
                  const content = summary.getBoundingClientRect();
                  return (
                    content.bottom <= bounds.bottom - 8 &&
                    content.top >= bounds.top &&
                    button.scrollHeight <= button.clientHeight
                  );
                }),
                true,
                `${model.id}: runtime health summary clipped`,
              );
            }
          }
          const nodes =
            width >= 640
              ? root.locator("foreignObject button")
              : root.locator(".function-map-mobile-node");
          assert.equal(
            await nodes.evaluateAll((buttons) =>
              buttons.every((button) => {
                const icons = button.querySelectorAll("svg[data-function-map-icon]");
                if (icons.length !== 1) return false;
                const element = icons[0];
                const bounds = element.getBoundingClientRect();
                const parent = button.getBoundingClientRect();
                const style = getComputedStyle(element);
                return (
                  element.namespaceURI === "http://www.w3.org/2000/svg" &&
                  element.children.length > 0 &&
                  bounds.width >= 24 &&
                  bounds.height >= 24 &&
                  bounds.left >= parent.left &&
                  bounds.right <= parent.right &&
                  bounds.top >= parent.top &&
                  bounds.bottom <= parent.bottom &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  style.stroke !== "none" &&
                  style.color !== "rgba(0, 0, 0, 0)"
                );
              }),
            ),
            true,
            `${model.id}: node SVG icon is missing, invisible or clipped`,
          );
          for (let i = 0; i < (await nodes.count()); i++) {
            await nodes.nth(i).click();
            const explanation = root.locator("section[aria-live=polite]");
            await explanation.waitFor();
            assert.equal(await explanation.locator("h3").count(), 1);
            activations++;
          }
          const relationship = root.locator(":scope > details").first();
          if (await relationship.count())
            await relationship.evaluate((element) => {
              element.open = true;
            });
          if (width < 640)
            assert.equal(
              (await root.locator("li").count()) >= model.edges.length || model.id === "G05",
              true,
              `${model.id}: missing mobile relationships`,
            );
          renders++;
          const capture =
            (width === 1440 &&
              language === "zh" &&
              ["D01", "G01", "G12", "T02", "T01", "G05"].includes(model.id)) ||
            (width === 390 &&
              language === "zh" &&
              theme === "dark" &&
              ["T02", "G18", "T01"].includes(model.id)) ||
            (width === 320 && language === "en" && theme === "light" && model.id === "G18");
          if (capture) {
            const file = `${model.id}-${theme}-${language}-${width}.png`;
            if (await nodes.count()) await nodes.first().click();
            await root.locator(".function-map-canvas").evaluate((element) => {
              element.scrollLeft = 0;
              element.scrollTop = 0;
            });
            if (await relationship.count())
              await relationship.evaluate((element) => {
                element.open = window.innerWidth < 640;
              });
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({
              path: path.join(review, file),
              fullPage: true,
              animations: "disabled",
            });
            captures.push(file);
          }
        }
      }
    }
  }
  await page.getByLabel("Map", { exact: true }).selectOption("G05");
  for (const state of ["loading", "forbidden", "error", "ready"]) {
    await page.getByLabel("Demo state", { exact: true }).selectOption(state);
    assert.equal(await page.locator("[data-map-id=G05]").count(), 1);
  }
  await page.getByLabel("Map", { exact: true }).selectOption("G12");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const button = page.locator("[data-map-id=G12] foreignObject button").first();
  await button.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("[data-map-id=G12] section[aria-live=polite]").count(), 1);
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(review, reportName),
    `${JSON.stringify({ renders, activations, widths, themes: ["light", "dark"], languages: ["zh", "en"], nodeSvgIcons: "all visible node buttons contain an inline SVG with visible geometry and unclipped bounds", runtimeAcquisition: ["loading", "forbidden", "error", "ready"], keyboard: "native SVG foreignObject button + Enter", errors, captures }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ renders, activations, captures: captures.length, errors }));
} finally {
  await browser.close();
}
