import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  SpackInstallBindingChange,
  SpackInstallBindingView,
} from "@kuintessence/shared/browser";
import { expect, type Page, test } from "patchright/test";
import materials from "../src/locales/materials.en.json" with { type: "json" };

const labels = materials.materials.installBinding;
const origin = "https://install-bindings.example.test";
const api = "/software/api/spack/install-bindings";
const organizationId = "22222222-2222-4222-8222-222222222222";
const operatorId = "11111111-1111-4111-8111-111111111111";
const spec = "hello@1.0 +shared %gcc@13.2.0";
const reason = "Reviewed immutable source release for future installations.";
const createdAt = "2026-09-30T00:00:00.000Z";
const binding = {
  repositoryId: "b".repeat(64),
  manifestDigest: `sha256:${"c".repeat(64)}`,
};
const replacement = { ...binding, manifestDigest: `sha256:${"d".repeat(64)}` };
const webRoot = resolve(import.meta.dirname, "..");
const bundle = resolve(webRoot, "test-results/spack-install-bindings-fixture.js");
let javascript = "";
let css = "";

function view(
  scope: string,
  revision = 0,
  selected = binding,
  state: "enabled" | "disabled" = "enabled",
): SpackInstallBindingView {
  const history: SpackInstallBindingView["history"] = Array.from(
    { length: Math.min(revision, 100) },
    (_, index) => ({
      revision: revision - index,
      state: index === 0 ? state : "enabled",
      binding: index === 0 && state === "disabled" ? null : selected,
      source: "web",
      operatorId,
      reason,
      createdAt,
    }),
  );
  return {
    scope,
    spec,
    revision,
    state: revision === 0 ? "absent" : state,
    binding: revision === 0 || state === "disabled" ? null : selected,
    history,
    historyTruncated: revision > 100,
  };
}

function command(scope: string, expectedRevision = 0): SpackInstallBindingChange {
  return { scope, spec, expectedRevision, reason, action: "bind", binding };
}

test.beforeAll(() => {
  // Executed by the existing Actions browser job after the application CSS build.
  mkdirSync(resolve(webRoot, "test-results"), { recursive: true });
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/spack-install-bindings.tsx",
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
  if (!css.trim()) throw new Error("Build application CSS before browser acceptance");
});

type Receipt = { status: number; body: unknown } | { abort: true };
type Call = {
  path: string;
  method: string;
  body: unknown;
  authorization: string | undefined;
  contentType: string | undefined;
};

async function mount(page: Page, scope: string, reads: Receipt[], writes: Receipt[] = []) {
  const calls: Call[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  let readIndex = 0;
  let writeIndex = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((scope) => {
    localStorage.setItem("kq.lang", "en");
    localStorage.setItem("kq_token", "install-binding-fixture-token");
    if (scope !== "platform") sessionStorage.setItem("kq.install-binding-fixture.org", scope);
  }, scope);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      !url.search &&
      request.method() === "POST" &&
      [api, `${api}/inspect`].includes(url.pathname)
    ) {
      calls.push({
        path: url.pathname,
        method: request.method(),
        body: request.postDataJSON(),
        authorization: request.headers().authorization,
        contentType: request.headers()["content-type"],
      });
      const receipt = url.pathname === api ? writes[writeIndex++] : reads[readIndex++];
      if (!receipt) {
        unexpected.push(`${request.method()} ${url.href}`);
        await route.abort("blockedbyclient");
      } else if ("abort" in receipt) {
        await route.abort("failed");
      } else {
        await route.fulfill({
          status: receipt.status,
          contentType: "application/json; charset=utf-8",
          headers: { "Cache-Control": "private, no-store" },
          body: JSON.stringify(receipt.body),
        });
      }
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
            <title>Spack install binding acceptance fixture</title>
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
    // No real service, manifest download, upstream request or DNS fallback is permitted.
    unexpected.push(`${request.method()} ${url.href}`);
    await route.abort("blockedbyclient");
  });
  await page.goto(origin);
  await expect(page.getByTestId("spack-install-binding-editor")).toBeVisible();
  await expect(page.getByLabel(labels.scope, { exact: true })).toHaveValue(scope);
  expect(await page.evaluate(() => sessionStorage.getItem("kq.mobile-management-policy"))).toBe(
    "observe-approve",
  );
  expect(calls).toHaveLength(0);
  return { calls, unexpected, errors };
}

async function inspect(page: Page) {
  await page.getByRole("button", { name: labels.inspect, exact: true }).click();
  await expect(page.getByTestId("spack-install-binding-detail")).toBeVisible();
}

async function prepare(page: Page) {
  await page.getByLabel(labels.reason, { exact: true }).fill(reason);
  await page.getByRole("checkbox", { name: labels.confirm, exact: true }).check();
  await expect(page.getByRole("button", { name: labels.save, exact: true })).toBeEnabled();
}

function checkRequests(
  harness: Awaited<ReturnType<typeof mount>>,
  expected: Array<{ path: string; body: unknown }>,
) {
  expect(harness.calls).toEqual(
    expected.map((call) => ({
      ...call,
      method: "POST",
      authorization: "Bearer install-binding-fixture-token",
      contentType: "application/json",
    })),
  );
  expect(harness.unexpected).toEqual([]);
  expect(harness.errors).toEqual([]);
}

async function checkGeometry(page: Page, width: number) {
  const geometry = await page.getByTestId("spack-install-binding-editor").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const controls = Array.from(element.querySelectorAll("input, select, textarea, button"))
      .map((control) => control.getBoundingClientRect())
      .filter((control) => control.width > 0 && control.height > 0);
    return {
      width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      left: rect.left,
      right: rect.right,
      overflow: controls.some((control) => control.left < 0 || control.right > window.innerWidth),
      overlaps: controls.some((a, index) =>
        controls
          .slice(index + 1)
          .some(
            (b) =>
              Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
          ),
      ),
      overflowingCells: Array.from(element.querySelectorAll("th, td")).filter(
        (cell) => cell.scrollWidth > cell.clientWidth + 1,
      ).length,
    };
  });
  expect(geometry.width).toBeLessThanOrEqual(width);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(width);
  expect(geometry.overflow).toBe(false);
  expect(geometry.overlaps).toBe(false);
  expect(geometry.overflowingCells).toBe(0);
}

for (const scope of ["platform", organizationId]) {
  test(`desktop ${scope} queries an exact spec and binds the selected release`, async ({
    page,
  }, info) => {
    const harness = await mount(
      page,
      scope,
      [{ status: 200, body: view(scope) }],
      [{ status: 200, body: view(scope, 1) }],
    );
    await expect(page.getByTestId("install-binding-fixture")).toHaveAttribute(
      "data-mobile-writes-blocked",
      "false",
    );
    const query = page.getByLabel(labels.spec, { exact: true });
    await expect(page.getByRole("button", { name: labels.inspect, exact: true })).toBeDisabled();
    await query.fill(` ${spec}`);
    await expect(query).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: labels.inspect, exact: true })).toBeDisabled();
    await query.fill(spec);
    await inspect(page);
    await expect(page.getByText(labels.historyEmpty, { exact: true })).toBeVisible();
    await expect(page.getByLabel(labels.repositoryId, { exact: true })).toHaveValue(
      binding.repositoryId,
    );
    await expect(page.getByLabel(labels.manifestDigest, { exact: true })).toHaveValue(
      binding.manifestDigest,
    );
    await expect(page.getByRole("button", { name: labels.save, exact: true })).toBeDisabled();
    await prepare(page);
    await page.getByRole("button", { name: labels.save, exact: true }).click();
    await expect(page.getByText(labels.notice.changed, { exact: true })).toBeVisible();
    const row = page.getByRole("table", { name: labels.history }).locator("tbody tr").first();
    await expect(row.locator("td").first()).toHaveText("1");
    await expect(row).toContainText(binding.manifestDigest);
    await expect(row).toContainText(operatorId);
    await expect(row).toContainText(reason);
    await expect(page.getByLabel(labels.reason, { exact: true })).toHaveValue("");
    await expect(page.getByRole("checkbox", { name: labels.confirm })).not.toBeChecked();
    checkRequests(harness, [
      { path: `${api}/inspect`, body: { scope, spec } },
      { path: api, body: command(scope) },
    ]);
    await checkGeometry(page, 1280);
    const portal = scope === "platform" ? "platform" : "provider";
    await page.screenshot({ path: info.outputPath(`desktop-${portal}-bound.png`), fullPage: true });
  });
}

test("409 removes the stale form and explicit inspection supplies the next revision", async ({
  page,
}, info) => {
  const scope = organizationId;
  const harness = await mount(
    page,
    scope,
    [
      { status: 200, body: view(scope) },
      { status: 200, body: view(scope, 1, replacement) },
    ],
    [
      { status: 409, body: { error: { code: "INSTALL_BINDING_CONFLICT", message: "Changed" } } },
      { status: 200, body: view(scope, 2) },
    ],
  );
  await page.getByLabel(labels.spec, { exact: true }).fill(spec);
  await inspect(page);
  await prepare(page);
  await page.getByRole("button", { name: labels.save, exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(labels.notice.conflict);
  await expect(page.getByTestId("spack-install-binding-detail")).toHaveCount(0);
  checkRequests(harness, [
    { path: `${api}/inspect`, body: { scope, spec } },
    { path: api, body: command(scope) },
  ]);
  await inspect(page);
  await expect(page.getByLabel(labels.manifestDigest, { exact: true })).toHaveValue(
    replacement.manifestDigest,
  );
  await expect(page.getByLabel(labels.reason, { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: labels.save, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: labels.useSelection, exact: true }).click();
  await prepare(page);
  await page.getByRole("button", { name: labels.save, exact: true }).click();
  await expect(page.getByText(labels.notice.changed, { exact: true })).toBeVisible();
  checkRequests(harness, [
    { path: `${api}/inspect`, body: { scope, spec } },
    { path: api, body: command(scope) },
    { path: `${api}/inspect`, body: { scope, spec } },
    { path: api, body: command(scope, 1) },
  ]);
  await page.screenshot({
    path: info.outputPath("desktop-conflict-refreshed.png"),
    fullPage: true,
  });
});

for (const failure of ["503", "network", "wrong-receipt"] as const) {
  test(`uncertain ${failure} prevents replay until the exact binding is inspected`, async ({
    page,
  }, info) => {
    const scope = "platform";
    const receipt: Receipt =
      failure === "network"
        ? { abort: true }
        : failure === "wrong-receipt"
          ? { status: 200, body: view(scope, 1, replacement) }
          : { status: 503, body: { error: { code: "INSTALL_BINDING_UNAVAILABLE" } } };
    const harness = await mount(
      page,
      scope,
      [
        { status: 200, body: view(scope) },
        { status: 503, body: { error: { code: "INSTALL_BINDING_UNAVAILABLE" } } },
        { status: 200, body: view(scope, 1) },
      ],
      [receipt],
    );
    await page.getByLabel(labels.spec, { exact: true }).fill(spec);
    await inspect(page);
    await prepare(page);
    await page.getByRole("button", { name: labels.save, exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(labels.notice.uncertain);
    await expect(page.getByLabel(labels.scope, { exact: true })).toBeDisabled();
    await expect(page.getByLabel(labels.spec, { exact: true })).toBeDisabled();
    await expect(page.getByTestId("spack-install-binding-detail")).toHaveCount(0);
    await expect(page.getByRole("button", { name: labels.save, exact: true })).toHaveCount(0);
    const initial = [
      { path: `${api}/inspect`, body: { scope, spec } },
      { path: api, body: command(scope) },
    ];
    checkRequests(harness, initial);
    await page.screenshot({
      path: info.outputPath(`desktop-uncertain-${failure}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: labels.inspect, exact: true }).click();
    await expect(page.getByRole("button", { name: labels.inspect, exact: true })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveText(labels.notice.uncertain);
    await expect(page.getByLabel(labels.spec, { exact: true })).toBeDisabled();
    await expect(page.getByTestId("spack-install-binding-detail")).toHaveCount(0);
    checkRequests(harness, [...initial, { path: `${api}/inspect`, body: { scope, spec } }]);
    await inspect(page);
    await expect(page.getByText(labels.notice.rechecked, { exact: true })).toBeVisible();
    await expect(page.getByLabel(labels.spec, { exact: true })).toBeEnabled();
    await expect(page.getByLabel(labels.reason, { exact: true })).toHaveValue("");
    await expect(page.getByRole("checkbox", { name: labels.confirm })).not.toBeChecked();
    await expect(page.getByRole("button", { name: labels.save, exact: true })).toBeDisabled();
    checkRequests(harness, [
      ...initial,
      { path: `${api}/inspect`, body: { scope, spec } },
      { path: `${api}/inspect`, body: { scope, spec } },
    ]);
  });
}

for (const width of [390, 320]) {
  test(`mobile ${width}px permits exact inspection but rejects UI and client writes`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const scope = organizationId;
    const harness = await mount(page, scope, [{ status: 200, body: view(scope, 11) }]);
    await expect(page.getByTestId("install-binding-fixture")).toHaveAttribute(
      "data-mobile-writes-blocked",
      "true",
    );
    await page.getByLabel(labels.spec, { exact: true }).fill(spec);
    await inspect(page);
    const table = page.getByRole("table", { name: labels.history });
    await expect(table.locator("tbody tr")).toHaveCount(10);
    await page.getByRole("button", { name: materials.materials.lifecycleNext }).click();
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.locator("tbody tr").first().locator("td").first()).toHaveText("1");
    const readOnlyFields = [
      labels.action,
      labels.repositoryId,
      labels.manifestDigest,
      labels.reason,
    ];
    for (const label of readOnlyFields) {
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    }
    await expect(page.getByRole("checkbox", { name: labels.confirm })).toBeDisabled();
    await expect(page.getByRole("button", { name: labels.save, exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: labels.useSelection })).toBeDisabled();
    await page.getByLabel(labels.reason, { exact: true }).evaluate((element) => {
      const form = element.closest("form");
      if (!form) throw new Error("Missing install binding change form");
      form.requestSubmit();
    });
    await page.getByTestId("probe-client-write").click();
    await expect(page.getByTestId("client-write-result")).toHaveText(
      "MOBILE_HIGH_RISK_MUTATION_BLOCKED",
    );
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
    await expect(table.locator("tbody tr").first().locator("td").last()).toHaveText(reason);
    checkRequests(harness, [{ path: `${api}/inspect`, body: { scope, spec } }]);
    await page.screenshot({ path: info.outputPath(`mobile-${width}-reason.png`), fullPage: true });
  });
}
