import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { InterconnectSnapshot, MapView } from "@kuintessence/shared/browser";
import { expect, test } from "patchright/test";

const orgId = "00000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date().toISOString();
function fixture(): InterconnectSnapshot {
  return {
    centers: [
      ["北京一号中心", 116.4, 39.9, "北京"],
      ["北京二号中心", 116.42, 39.92, "北京"],
      ["上海中心", 121.5, 31.2, "上海"],
    ].map(([name, longitude, latitude, province], i) => ({
      id: uuid(i + 2),
      orgId,
      updatedAt: now,
      metadata: {
        name: String(name),
        country: "中国",
        province: String(province),
        city: String(province),
        longitude: Number(longitude),
        latitude: Number(latitude),
        status: i === 1 ? "degraded" : "operational",
      },
    })),
    clusters: [0, 1, 2].map((i) => ({
      id: uuid(i + 5),
      centerId: uuid(i + 2),
      updatedAt: now,
      metadata: {
        name: `计算集群 ${i + 1}`,
        status: "operational",
        computeTypes: i === 1 ? ["GPU"] : ["CPU"],
        cpuCores: i === 2 ? null : 64,
        storageBytes: i === 2 ? null : 1024 ** 4,
        storageTypes: ["Ceph"],
        applications: [],
      },
      agentIds: [`agent-${i}`],
      agents: [{ id: `agent-${i}`, status: "online", observedAt: now }],
      software: [{ name: "gromacs", source: "inventory", observedAt: now }],
      jobs24h: { succeeded: 3, failed: i === 1 ? 1 : 0 },
    })),
    links: [
      {
        id: uuid(8),
        fromCenterId: uuid(2),
        toCenterId: uuid(4),
        updatedAt: now,
        metadata: {
          name: "北京—上海",
          status: "operational",
          bandwidthMbps: 1000,
          throughputMbps: null,
          latencyMs: 25,
          packetLossPercent: null,
          observedAt: now,
          source: "测试观测",
        },
      },
    ],
    agents: [],
    organizations: [{ id: orgId, name: "测试提供者" }],
    defaultView: null,
    generatedAt: now,
    canManage: true,
  };
}
test("resource drilldown, map defaults, metadata and responsive layout", async ({
  page,
}, testInfo) => {
  const snapshot = fixture();
  const errors: string[] = [];
  const writes: unknown[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript((organizationId) => {
    localStorage.setItem("kq_token", "fixture-token");
    localStorage.setItem("kq_email", "fixture@example.test");
    localStorage.setItem("kq_role", "platform_admin");
    localStorage.setItem("kq.lang", "zh");
    localStorage.setItem("kq.theme", "light");
    localStorage.setItem("kq_active_organization_id", organizationId);
  }, orgId);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.includes("/api/")) {
      if (url.pathname.endsWith("/me/capabilities"))
        return json({
          principal: { userId: uuid(10), email: "fixture@example.test", role: "platform_admin" },
          capabilities: [
            "workspace.provider.view",
            "workspace.provider.manage",
            "workspace.platform.view",
            "workspace.platform.manage",
          ],
          contexts: [{ id: "platform", type: "platform" }],
          activeContextId: "platform",
          devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
        });
      if (url.pathname.endsWith("/me/active-organization"))
        return json({
          activeOrganizationId: orgId,
          organizations: [{ orgId, name: "测试提供者", role: "admin" }],
        });
      if (url.pathname.endsWith("/snapshot")) return json(snapshot);
      if (url.pathname.endsWith("/default-view")) {
        snapshot.defaultView = route.request().postDataJSON() as MapView;
        return json({ saved: true });
      }
      if (url.pathname.includes("/interconnect/") && route.request().method() === "POST") {
        writes.push(route.request().postDataJSON());
        return json({ id: uuid(11) });
      }
      return json({});
    }
    const path =
      url.pathname.startsWith("/assets/") || url.pathname.startsWith("/maps/")
        ? url.pathname.slice(1)
        : "index.html";
    const contentTypes: Record<string, string> = {
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".html": "text/html",
    };
    return route.fulfill({
      body: await readFile(resolve(import.meta.dirname, "../dist", path)),
      contentType: contentTypes[extname(path)] ?? "application/octet-stream",
    });
  });
  await page.goto("/interconnect");
  await expect(page.getByRole("heading", { name: "多算力中心互联仪表盘" })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  // Locate the amber portion of the aggregate ring on the real canvas, then click it.
  const mapCanvas = page.getByRole("region", { name: "算力中心地图" }).locator("canvas").first();
  const aggregatePosition = async () =>
    mapCanvas.evaluate((canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = canvas.width,
        maxX = 0,
        minY = canvas.height,
        maxY = 0;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const offset = (y * canvas.width + x) * 4;
          const red = pixels[offset] ?? 0,
            green = pixels[offset + 1] ?? 0,
            blue = pixels[offset + 2] ?? 0;
          if (
            red > 180 &&
            green > 80 &&
            green < 180 &&
            blue < 120 &&
            (pixels[offset + 3] ?? 0) > 0
          ) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      if (maxX === 0) return null;
      const bounds = canvas.getBoundingClientRect();
      return {
        x: bounds.x + ((minX + maxX) / 2 / canvas.width) * bounds.width,
        y: bounds.y + ((minY + maxY) / 2 / canvas.height) * bounds.height,
      };
    });
  await expect.poll(aggregatePosition).not.toBeNull();
  await page.screenshot({
    path: testInfo.outputPath("interconnect-aggregated.png"),
    fullPage: true,
  });
  const position = await aggregatePosition();
  if (!position) throw new Error("Aggregate ring was not painted");
  await page.mouse.click(position.x, position.y);
  await expect(page.getByLabel("地图层级")).toHaveValue("province");
  await expect(
    page.getByRole("region", { name: "资源明细" }).getByText("2 个地图节点"),
  ).toBeVisible();
  await page.getByLabel("地图层级").selectOption("china");
  // Separate the second fixture center so the Beijing–Shanghai link has two visible endpoints.
  const secondCenter = snapshot.centers[1];
  if (!secondCenter) throw new Error("Missing fixture center");
  secondCenter.metadata = {
    ...secondCenter.metadata,
    name: "成都中心",
    province: "四川",
    city: "成都",
    longitude: 104,
    latitude: 30,
  };
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "资源明细" })
      .getByRole("button", { name: "成都中心", exact: true }),
  ).toBeVisible();
  const linkPosition = async () =>
    mapCanvas.evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d");
      if (!context) return null;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const points: { x: number; y: number }[] = [];
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          const r = pixels[i] ?? 0,
            g = pixels[i + 1] ?? 0,
            b = pixels[i + 2] ?? 0;
          if (g > 110 && g > r * 1.3 && g > b * 1.3 && r < 140 && (pixels[i + 3] ?? 0) > 0)
            points.push({ x, y });
        }
      if (!points.length) return null;
      const middle =
        (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2;
      const line = points.filter((p) => Math.abs(p.y - middle) < 1);
      if (!line.length) return null;
      const bounds = canvas.getBoundingClientRect();
      return {
        x:
          bounds.x +
          (line.reduce((n, p) => n + p.x, 0) / line.length / canvas.width) * bounds.width,
        y: bounds.y + (middle / canvas.height) * bounds.height,
      };
    });
  await expect.poll(linkPosition).not.toBeNull();
  const linkPoint = await linkPosition();
  if (!linkPoint) throw new Error("Link was not painted");
  await page.mouse.click(linkPoint.x, linkPoint.y);
  await expect(page.getByRole("dialog").getByText("1000 Mbps")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /CPU 核心 128/ }).click();
  const details = page.getByRole("region", { name: "资源明细" });
  await expect(details.getByText("计算集群 1", { exact: true })).toBeVisible();
  await expect(details.getByText("未提供", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /24 小时作业成功率/ }).click();
  await expect(details.getByRole("columnheader", { name: "24h 成功 / 失败" })).toBeVisible();
  await page.getByRole("button", { name: /Agent 在线健康率/ }).click();
  await expect(details.getByRole("columnheader", { name: "在线健康 / Agent" })).toBeVisible();
  await page.getByRole("button", { name: /应用软件 1/ }).click();
  await expect(details.getByText("1 种软件 · 3 条集群关联")).toBeVisible();
  await details.getByLabel("筛选算力中心").selectOption(uuid(2));
  await expect(details.getByText("1 种软件 · 1 条集群关联")).toBeVisible();
  await page.getByRole("button", { name: /互联链路 1/ }).click();
  await details.getByRole("button", { name: "北京—上海" }).click();
  await expect(page.getByRole("dialog").getByText("1000 Mbps")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("未采集")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.getByLabel("地图层级").selectOption("province");
  await page.getByLabel("省份", { exact: true }).selectOption("北京");
  await page.getByRole("button", { name: "放大地图", exact: true }).click();
  await page.getByRole("button", { name: "保存默认视图" }).click();
  await expect.poll(() => snapshot.defaultView?.level).toBe("province");
  expect(snapshot.defaultView?.zoom).toBe(1.5);
  const beforePan = JSON.stringify(snapshot.defaultView?.center);
  await mapCanvas.scrollIntoViewIfNeeded();
  const bounds = await mapCanvas.boundingBox();
  if (!bounds) throw new Error("Map canvas is missing");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + bounds.height / 2 + 30, {
    steps: 4,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "保存默认视图" }).click();
  await expect.poll(() => JSON.stringify(snapshot.defaultView?.center)).not.toBe(beforePan);
  await page.reload();
  await expect(page.getByLabel("地图层级")).toHaveValue("province");
  await expect(page.getByLabel("省份", { exact: true })).toHaveValue("北京");
  await page.getByRole("button", { name: "新增中心", exact: true }).click();
  await page.getByRole("dialog").getByLabel("名称", { exact: true }).fill("新建测试中心");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    orgId,
    metadata: { name: "新建测试中心", longitude: null, latitude: null, status: "unknown" },
  });
  await page.goto("/cp/interconnect");
  await expect(page.getByRole("heading", { name: "多算力中心互联仪表盘" })).toBeVisible();
  await page.getByLabel("地图层级").selectOption("china");
  await page.screenshot({ path: testInfo.outputPath("interconnect-desktop.png"), fullPage: true });
  for (const width of Array.from({ length: 30 }, (_, i) => [390, 768, 1440][i % 3] ?? 1440)) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByTestId("interconnect-dashboard")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
  }
  await page.getByTestId("theme-menu").click();
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
  await expect(page.getByTestId("interconnect-dashboard")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("interconnect-dark.png"), fullPage: true });
  expect(errors).toEqual([]);
});
