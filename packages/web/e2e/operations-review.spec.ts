import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "patchright/test";
import { overview } from "./fixtures/software-overview";

const root = resolve(import.meta.dirname, "..");
let javascript = "",
  css = "";
const organizationId = "11111111-1111-4111-8111-111111111111";
test.beforeAll(() => {
  const bundle = resolve(root, "test-results/operations-review-bundle");
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/operations-review.tsx",
      "--target=browser",
      "--format=iife",
      "--define",
      'import.meta.env={"MODE":"test"}',
      "--outdir",
      bundle,
    ],
    { cwd: root },
  );
  javascript = readFileSync(resolve(bundle, "operations-review.js"), "utf8");
  css = readdirSync(resolve(root, "dist/assets"))
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(resolve(root, "dist/assets", name), "utf8"))
    .join("\n");
});

for (const width of [1161, 390]) {
  for (const scenario of ["dashboard", "software", "metering", "audit", "template", "network"]) {
    test(`${scenario} at ${width}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 770 });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (route.request().isNavigationRequest())
          return route.fulfill({
            contentType: "text/html",
            body: '<html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>',
          });
        if (url.pathname.endsWith("/me/capabilities"))
          return route.fulfill({
            json: {
              principal: {
                userId: organizationId,
                email: "review@example.test",
                role: "super_admin",
              },
              capabilities: [
                "workspace.provider.view",
                "workspace.provider.manage",
                "workspace.platform.view",
                "workspace.platform.operate",
              ],
              contexts: [{ id: "platform", type: "platform" }],
              activeContextId: "platform",
              devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
            },
          });
        if (url.pathname.endsWith("/me/active-organization"))
          return route.fulfill({
            json: {
              activeOrganizationId: organizationId,
              organizations: [{ orgId: organizationId, name: "研究算力中心", role: "owner" }],
            },
          });
        if (url.pathname.endsWith("/cp/dashboard"))
          return route.fulfill({
            json: {
              kpis: {
                windowFrom: "2026-11-16T00:00:00Z",
                windowTo: "2026-11-17T00:00:00Z",
                jobsCompleted: 24,
                jobsFailed: 2,
                bytesTransferred: 1024 ** 3,
                queueDepthPeak: 8,
                agentsHealthy: 6,
                agentsSick: 1,
                agentsOffline: 0,
                topUsers: [],
                topApps: [],
              },
            },
          });
        if (url.pathname.endsWith("/cp/software/overview"))
          return route.fulfill({ json: overview });
        if (url.pathname.endsWith("/metering/query"))
          return route.fulfill({ json: { rows: [], total: 0 } });
        if (url.pathname.endsWith("/audit-log")) {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          return route.fulfill({
            json: {
              total: 51,
              entries: Array.from({ length: 25 }, (_, i) => ({
                id: `audit-${offset + i}`,
                actor: "review@example.test",
                action: "job.submit",
                target: `计算任务 ${offset + i}`,
                createdAt: "2026-11-17T05:00:00Z",
              })),
            },
          });
        }
        if (
          url.pathname.endsWith("/sandbox/account-mapping-review-queue") ||
          url.pathname.endsWith("/sandbox/runtime-profiles")
        )
          return route.fulfill({ json: { success: true, data: [] } });
        if (url.pathname.endsWith("/agents")) return route.fulfill({ json: { agents: [] } });
        if (url.pathname.endsWith("/runtime-contract-bindings"))
          return route.fulfill({ json: { bindings: [] } });
        if (url.pathname.endsWith("/licensed-material-mappings"))
          return route.fulfill({ json: { mappings: [] } });
        if (url.pathname.endsWith("/spack/catalog"))
          return route.fulfill({
            json: { packages: [], total: 0, page: 1, pageSize: 100, hasNext: false, totalPages: 1 },
          });
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      await page.goto(`https://operations-ui.invalid/?scenario=${scenario}`);
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: javascript });
      if (scenario === "dashboard") {
        await expect(page.getByTestId("cp-kpi-jobsCompleted-value")).toHaveText("24");
        await expect(page.getByRole("heading", { name: "作业与调度" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "集群健康", exact: true })).toBeVisible();
      }
      if (scenario === "software") {
        await expect(page.getByTestId("cp-software-agent-agent-a")).toBeVisible();
        const refresh = page.getByRole("button", { name: "刷新", exact: true }).first();
        await expect(refresh).toBeVisible();
        expect(await refresh.evaluate((el) => el.textContent)).toBe("");
        expect((await refresh.boundingBox())?.width).toBeLessThanOrEqual(40);
      }
      if (scenario === "metering") {
        await expect(page.getByTestId("metering-period")).toBeVisible();
        if (width === 1161) {
          const period = await page.getByTestId("metering-period").boundingBox();
          const to = await page.getByTestId("metering-to").boundingBox();
          expect(Math.abs((period?.y ?? 0) - (to?.y ?? 0))).toBeLessThan(2);
        }
      }
      if (scenario === "audit") {
        await expect(page.getByTestId("log-viewer-records").getByRole("row")).toHaveCount(26);
        await page.getByRole("button", { name: "下一页" }).click();
        await expect(page.getByTestId("log-viewer-records")).toContainText("计算任务 25");
        await page.getByRole("searchbox").fill("job.submit");
        await page.getByRole("button", { name: "检索", exact: true }).click();
        await expect(page.getByTestId("log-viewer-records")).toContainText("计算任务 0");
      }
      if (scenario === "template") {
        await expect(page.getByTestId("software-node-types-template")).toContainText("用例计算");
        await expect(page.getByTestId("software-node-types-template")).not.toContainText(
          "SoftwareUsecaseComputing",
        );
        const types = page.getByTestId("software-node-types-template");
        await expect(types).toContainText("脚本");
        if (width === 1161) {
          const date = await page.getByText("11月14日", { exact: false }).boundingBox();
          const nodes = await page.getByText("节点", { exact: true }).boundingBox();
          expect(Math.abs((date?.y ?? 0) - (nodes?.y ?? 0))).toBeLessThan(3);
        }
      }
      if (scenario === "network") {
        await page.getByLabel("名称", { exact: true }).fill("同城高速网");
        await page.getByLabel("链路类型").selectOption("high-speed");
        for (const label of ["起点", "终点"]) {
          await page.getByRole("combobox", { name: label, exact: true }).click();
          await page
            .getByRole("option", { name: "研究算力中心 / 同城可用区", exact: true })
            .click();
        }
        await page.getByLabel("配置带宽（Mbps）").fill("10000");
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(page.getByTestId("saved-link")).toContainText(
          '"configuredBandwidthMbps":10000',
        );
        await expect(page.getByTestId("saved-link")).toContainText('"networkType":"high-speed"');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${scenario}-${width}.png`), fullPage: true });
    });
  }
}
