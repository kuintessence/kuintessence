import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "patchright";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const build = pathToFileURL(
  path.join(project, ".impeccable/review/function-maps-build/job-controls.html"),
).href;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.KQ_CHROMIUM_PATH ??
    "/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
  args: ["--no-sandbox", "--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage({ viewport: { width: 974, height: 770 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  let pickerCases = 0;
  for (const overlay of ["dialog", "sheet"])
    for (const bottom of [false, true]) {
      await page.goto(`${build}?overlay=${overlay}${bottom ? "&bottom=1" : ""}`);
      await page.getByRole("button", { name: "打开选择器", exact: true }).click();
      const parent = page.getByRole("dialog", { name: "选择队列", exact: true });
      await parent.waitFor();
      const trigger = page.getByRole("combobox", { name: "队列", exact: true });
      await trigger.click();
      const input = page.locator("input[role=combobox]");
      await input.click();
      await page.keyboard.type("GPU");
      assert.equal(await input.inputValue(), "GPU");
      assert.equal(await input.evaluate((el) => document.activeElement === el), true);
      assert.equal(await page.getByRole("option").count(), 1);
      // The fixed-position popover must remain visible even near the overlay's lower edge.
      const box = await input.boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.y + box.height <= 770);
      assert.equal(
        await input.evaluate((el) => {
          const b = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
        }),
        true,
      );
      await page.keyboard.press("Escape");
      await input.waitFor({ state: "hidden" });
      assert.equal(await parent.isVisible(), true);
      await trigger.click();
      await page.getByRole("option", { name: "GPU queue" }).click();
      assert.equal(await parent.locator("output").textContent(), "gpu");
      await trigger.click();
      await page.getByRole("button", { name: "展开选择" }).click();
      const expanded = page.getByRole("dialog", { name: "队列", exact: true });
      await expanded.waitFor();
      const search = expanded.getByRole("textbox");
      await search.click();
      await search.fill("");
      await page.keyboard.type("CPU");
      assert.equal(await search.inputValue(), "CPU");
      await page.keyboard.press("Escape");
      await expanded.waitFor({ state: "hidden" });
      assert.equal(await parent.isVisible(), true);
      pickerCases++;
    }
  for (const width of [1440, 974, 390, 320])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 770 });
      await page.goto(`${build}?theme=${theme}`);
      await page.locator(".kq-name-fade").first().waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      for (const name of await page.locator(".kq-name-fade").all()) {
        assert.equal(await name.evaluate((el) => getComputedStyle(el).whiteSpace), "nowrap");
        assert.ok(await name.evaluate((el) => el.scrollWidth > el.clientWidth));
        assert.notEqual(await name.evaluate((el) => getComputedStyle(el).maskImage), "none");
      }
      assert.equal(
        await page.locator("h1").evaluate((el) => getComputedStyle(el).userSelect),
        "none",
      );
      const graph = page.locator('[data-map-id="job-resources-example-job"]');
      assert.equal(await graph.isVisible(), width >= 768);
      if (width >= 768) {
        await graph.locator("foreignObject button").filter({ hasText: "申请资源" }).click();
        const details = page.getByRole("dialog");
        await details.waitFor();
        assert.ok((await details.textContent()).includes("4 CPU · 2048 MiB"));
        const bounds = await details.boundingBox();
        assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 770);
        await page.keyboard.press("Escape");
        await details.waitFor({ state: "hidden" });
      }
      await page.screenshot({
        path: path.join(project, `.impeccable/review/job-controls-${width}-${theme}.png`),
      });
    }
  await page.setViewportSize({ width: 974, height: 770 });
  await page.goto(build);
  await page.getByRole("button", { name: "提交作业", exact: true }).click();
  const number = page.getByTestId("submit-usecase-input-threads");
  await number.waitFor();
  assert.equal(await number.inputValue(), "4");
  assert.equal(await number.getAttribute("type"), "number");
  await number.fill("17");
  assert.equal(await number.getAttribute("aria-invalid"), "true");
  await number.fill("8");
  await page.getByTestId("submit-usecase-file-alignment").click();
  const filePicker = page.getByRole("dialog", { name: "选择输入文件", exact: true });
  await filePicker.waitFor();
  await page.getByRole("button", { name: "datasets/", exact: true }).click();
  await page.getByRole("button", { name: "sample.bam", exact: true }).click();
  await page.getByTestId("path-picker-confirm").click();
  await filePicker.waitFor({ state: "hidden" });
  assert.ok((await page.getByRole("dialog").textContent()).includes("sample.bam"));
  await page.screenshot({ path: path.join(project, ".impeccable/review/job-usecase-inputs.png") });
  assert.equal(await page.locator("body").getAttribute("data-preview-error"), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pickerCases, responsiveCases: 8, usecaseInputs: true, errors }));
} finally {
  await browser.close();
}
