import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SpackMaterialLifecycleView } from "@kuintessence/shared/browser";
import { expect, type Page, test } from "patchright/test";
import materials from "../src/locales/materials.en.json" with { type: "json" };

const labels = materials.materials;
const origin = "https://lifecycle.example.test";
const repository = "public/materials";
const binding = {
  repositoryId: createHash("sha256").update(repository).digest("hex"),
  manifestDigest: `sha256:${"b".repeat(64)}`,
};
const apiPath = `/software/api/spack/material-repositories/${binding.repositoryId}/releases/${encodeURIComponent(binding.manifestDigest)}/lifecycle`;
const operatorId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-09-21T00:00:00.000Z";
const withdrawReason = "Source archive checksum requires review before further installations.";
const restoreReason = "Source archive checksum verified against the published release.";
const webRoot = resolve(import.meta.dirname, "..");
const bundle = resolve(webRoot, "test-results/material-lifecycle-fixture.js");
let css = "";
let javascript = "";

function view(revision: number, reason = withdrawReason): SpackMaterialLifecycleView {
  const history = Array.from({ length: Math.min(revision, 100) }, (_, index) => ({
    revision: revision - index,
    state: (revision - index) % 2 ? ("withdrawn" as const) : ("available" as const),
    operatorId,
    reason: index === 0 ? reason : withdrawReason,
    epoch: "22222222-2222-4222-8222-222222222222",
    rolloutRevision: 1,
    createdAt,
  }));
  return {
    binding,
    repository,
    revision,
    state: history[0]?.state ?? "available",
    history,
    historyTruncated: revision > 100,
  };
}

test.beforeAll(() => {
  // Actions builds the application CSS first; this bundles only the real-component fixture.
  mkdirSync(resolve(webRoot, "test-results"), { recursive: true });
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/material-lifecycle.tsx",
      "--target=browser",
      "--format=iife",
      "--outfile",
      bundle,
    ],
    { cwd: webRoot, timeout: 60_000 },
  );
  javascript = readFileSync(bundle, "utf8");
  const assets = resolve(webRoot, "dist/assets");
  css = readdirSync(assets)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => readFileSync(resolve(assets, name), "utf8"))
    .join("\n");
  if (!css.trim()) throw new Error("Build the web application CSS before browser acceptance");
});

type Receipt = { status: number; body: unknown };
type Call = { method: string; body: string | null; authorization: string | undefined };

async function mount(page: Page, reads: SpackMaterialLifecycleView[], writes: Receipt[] = []) {
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  let readIndex = 0;
  let writeIndex = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("kq.lang", "en");
    localStorage.setItem("kq_token", "lifecycle-fixture-token");
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === `${origin}${apiPath}`) {
      calls.push({
        method: request.method(),
        body: request.postData(),
        authorization: request.headers().authorization,
      });
      const receipt =
        request.method() === "GET"
          ? { status: 200, body: reads[readIndex++] }
          : request.method() === "POST"
            ? writes[writeIndex++]
            : undefined;
      if (!receipt || receipt.body === undefined) {
        unexpected.push(`${request.method()} ${url.href}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.fulfill({
        status: receipt.status,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(receipt.body),
      });
      return;
    }
    if (request.method() === "GET" && url.origin === origin && !url.search) {
      if (url.pathname === "/") {
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html lang="en"><head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link rel="icon" href="data:,"><link rel="stylesheet" href="/fixture.css">
            <title>Material lifecycle acceptance fixture</title>
            </head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        });
        return;
      }
      if (url.pathname === "/fixture.js" || url.pathname === "/fixture.css") {
        await route.fulfill({
          contentType: url.pathname.endsWith(".js")
            ? "application/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
          body: url.pathname.endsWith(".js") ? javascript : css,
        });
        return;
      }
    }
    // Never fall through to DNS, a real service, a manifest endpoint, or a third-party origin.
    unexpected.push(`${request.method()} ${url.href}`);
    await route.abort("blockedbyclient");
  });
  await page.goto(origin);
  await expect(page.getByTestId("material-lifecycle")).toBeVisible();
  expect(await page.evaluate(() => window.isSecureContext && !!crypto.subtle)).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem("kq.mobile-management-policy"))).toBe(
    "observe-approve",
  );
  await expect(page.getByLabel(labels.lifecycleRepositoryId)).toHaveValue(binding.repositoryId);
  await expect(page.getByLabel(labels.lifecycleManifestDigest)).toHaveValue(binding.manifestDigest);
  expect(calls).toHaveLength(0);
  return { calls, unexpected, errors };
}

async function inspect(page: Page) {
  await page.getByRole("button", { name: labels.lifecycleInspect, exact: true }).click();
  await expect(page.getByTestId("material-lifecycle-detail")).toBeVisible();
}

async function checkGeometry(page: Page, width: number) {
  const geometry = await page.getByTestId("material-lifecycle").evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const controls = Array.from(element.querySelectorAll("input, textarea, button"))
      .map((control) => control.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const intersects = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const overlaps = controls.some((a, index) =>
      controls.slice(index + 1).some((b) => intersects(a, b)),
    );
    const sections = [element, element.querySelector('[data-testid="material-lifecycle-detail"]')];
    const sectionOverlap = sections.some((section) => {
      const rects = Array.from(section?.children ?? [], (child) => child.getBoundingClientRect());
      return rects.some((a, index) => rects.slice(index + 1).some((b) => intersects(a, b)));
    });
    const checkbox = element.querySelector('input[type="checkbox"]');
    const confirmation = checkbox?.parentElement?.querySelector("span");
    const checkboxRect = checkbox?.getBoundingClientRect();
    const confirmationRect = confirmation?.getBoundingClientRect();
    return {
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      left: panel.left,
      right: panel.right,
      overlaps,
      sectionOverlap,
      checkboxWidth: checkboxRect?.width ?? 0,
      confirmationGap: (confirmationRect?.left ?? 0) - (checkboxRect?.right ?? 0),
      overflowingCells: Array.from(element.querySelectorAll("th, td")).filter(
        (cell) => cell.scrollWidth > cell.clientWidth + 1,
      ).length,
      inputHeight: element.querySelector("input")?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(geometry.pageWidth).toBeLessThanOrEqual(width);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(width);
  expect(geometry.overlaps).toBe(false);
  expect(geometry.sectionOverlap).toBe(false);
  expect(geometry.checkboxWidth).toBeGreaterThanOrEqual(12);
  expect(geometry.confirmationGap).toBeGreaterThanOrEqual(4);
  expect(geometry.overflowingCells).toBe(0);
  expect(geometry.inputHeight).toBeGreaterThanOrEqual(32);
}

function checkRequests(
  harness: Awaited<ReturnType<typeof mount>>,
  expected: Array<{ method: string; body: string | null }>,
) {
  expect(harness.calls).toEqual(
    expected.map((call) => ({ ...call, authorization: "Bearer lifecycle-fixture-token" })),
  );
  expect(harness.unexpected).toEqual([]);
  expect(harness.errors).toEqual([]);
}

test("desktop withdraws and restores with explicit reasons, confirmation, and audit", async ({
  page,
}, info) => {
  const harness = await mount(
    page,
    [view(0)],
    [
      { status: 200, body: view(1) },
      { status: 200, body: view(2, restoreReason) },
    ],
  );
  await expect(page.getByTestId("lifecycle-fixture")).toHaveAttribute(
    "data-mobile-writes-blocked",
    "false",
  );
  await inspect(page);
  await expect(page.getByText(labels.lifecycleHistoryEmpty, { exact: true })).toBeVisible();
  const reason = page.getByLabel(labels.lifecycleReason, { exact: true });
  const withdraw = page.getByRole("button", { name: labels.lifecycleAction.withdraw, exact: true });
  await expect(withdraw).toBeDisabled();
  await reason.fill(` ${withdrawReason}`);
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText(labels.lifecycleInvalidReason, { exact: true })).toBeVisible();
  await expect(withdraw).toBeDisabled();
  await reason.fill(withdrawReason);
  await expect(withdraw).toBeDisabled();
  await page.getByRole("checkbox", { name: labels.lifecycleConfirm.withdraw }).check();
  await expect(withdraw).toBeEnabled();
  await withdraw.click();
  await expect(page.getByText(labels.lifecycleNotice.changed, { exact: true })).toBeVisible();
  const table = page.getByRole("table", { name: labels.lifecycleHistory });
  await expect(table.locator("tbody tr").first().locator("td")).toHaveText([
    "1",
    labels.lifecycleState.withdrawn,
    operatorId,
    createdAt,
    withdrawReason,
  ]);
  await expect(page.getByTestId("invalidation-count")).toHaveText("1");
  await checkGeometry(page, 1280);
  await page.screenshot({ path: info.outputPath("desktop-withdrawn.png"), fullPage: true });

  const restore = page.getByRole("button", { name: labels.lifecycleAction.restore, exact: true });
  await expect(reason).toHaveValue("");
  await expect(restore).toBeDisabled();
  await reason.fill(restoreReason);
  await expect(restore).toBeDisabled();
  await page.getByRole("checkbox", { name: labels.lifecycleConfirm.restore }).check();
  await restore.click();
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").first().locator("td")).toHaveText([
    "2",
    labels.lifecycleState.available,
    operatorId,
    createdAt,
    restoreReason,
  ]);
  await expect(page.getByTestId("invalidation-count")).toHaveText("2");
  await expect(withdraw).toBeDisabled();
  checkRequests(harness, [
    { method: "GET", body: null },
    {
      method: "POST",
      body: JSON.stringify({ action: "withdraw", expectedRevision: 0, reason: withdrawReason }),
    },
    {
      method: "POST",
      body: JSON.stringify({ action: "restore", expectedRevision: 1, reason: restoreReason }),
    },
  ]);
  await checkGeometry(page, 1280);
  await page.screenshot({ path: info.outputPath("desktop-restored.png"), fullPage: true });
});

for (const width of [390, 320]) {
  test(`mobile ${width}px reads audit while real mobile policy blocks writes`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const harness = await mount(page, [view(11)]);
    await expect(page.getByTestId("lifecycle-fixture")).toHaveAttribute(
      "data-mobile-writes-blocked",
      "true",
    );
    await inspect(page);
    const table = page.getByRole("table", { name: labels.lifecycleHistory });
    await expect(table.locator("tbody tr")).toHaveCount(10);
    await expect(table.locator("tbody tr").first().locator("td").first()).toHaveText("11");
    await page.getByRole("button", { name: labels.lifecycleNext, exact: true }).click();
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.locator("tbody tr").first().locator("td").first()).toHaveText("1");
    await page.getByRole("button", { name: labels.lifecyclePrevious, exact: true }).click();
    await expect(table.locator("tbody tr")).toHaveCount(10);
    await expect(page.getByLabel(labels.lifecycleReason, { exact: true })).toBeDisabled();
    await expect(
      page.getByRole("checkbox", { name: labels.lifecycleConfirm.restore }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: labels.lifecycleAction.restore, exact: true }),
    ).toBeDisabled();
    await page.getByLabel(labels.lifecycleReason, { exact: true }).evaluate((element) => {
      const form = element.closest("form");
      if (!form) throw new Error("Missing lifecycle change form");
      form.requestSubmit();
    });
    await expect(page.getByTestId("invalidation-count")).toHaveText("0");
    await checkGeometry(page, width);
    const scroller = table.locator("..");
    expect(
      await scroller.evaluate(
        (element) =>
          getComputedStyle(element).overflowX === "auto" &&
          element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`mobile-${width}-audit.png`), fullPage: true });
    await scroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(table.locator("tbody tr").first().locator("td").last()).toHaveText(withdrawReason);
    await checkGeometry(page, width);
    checkRequests(harness, [{ method: "GET", body: null }]);
    await page.screenshot({ path: info.outputPath(`mobile-${width}-reasons.png`), fullPage: true });
  });
}

test("uncertain POST 503 requires explicit GET reconciliation without repeating POST", async ({
  page,
}, info) => {
  const harness = await mount(
    page,
    [view(0), view(1)],
    [{ status: 503, body: { error: { code: "REGISTRY_UNREACHABLE", message: "Unavailable" } } }],
  );
  await inspect(page);
  await page.getByLabel(labels.lifecycleReason, { exact: true }).fill(withdrawReason);
  await page.getByRole("checkbox", { name: labels.lifecycleConfirm.withdraw }).check();
  await page.getByRole("button", { name: labels.lifecycleAction.withdraw, exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(labels.lifecycleNotice.uncertain);
  await expect(page.getByTestId("material-lifecycle-detail")).toHaveCount(0);
  await expect(page.getByTestId("invalidation-count")).toHaveText("1");
  const posted = {
    method: "POST",
    body: JSON.stringify({ action: "withdraw", expectedRevision: 0, reason: withdrawReason }),
  };
  checkRequests(harness, [{ method: "GET", body: null }, posted]);
  await page.screenshot({ path: info.outputPath("desktop-uncertain.png"), fullPage: true });
  await inspect(page);
  await expect(page.getByText(labels.lifecycleNotice.rechecked, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("table", { name: labels.lifecycleHistory }).locator("tbody tr").first(),
  ).toContainText(withdrawReason);
  await expect(
    page.getByRole("button", { name: labels.lifecycleAction.restore, exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel(labels.lifecycleReason, { exact: true })).toHaveValue("");
  await expect(page.getByTestId("invalidation-count")).toHaveText("1");
  checkRequests(harness, [{ method: "GET", body: null }, posted, { method: "GET", body: null }]);
  await checkGeometry(page, 1280);
  await page.screenshot({ path: info.outputPath("desktop-reconciled.png"), fullPage: true });
});
