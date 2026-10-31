import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { expect, test } from "patchright/test";

test("members can be found, edited, added and removed without entering internal IDs", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const writes: unknown[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let members = Array.from({ length: 24 }, (_, index) => ({
    id: `membership-${index}`,
    userId: `user-${index}`,
    displayName: `研究员 ${index + 1}`,
    email: `researcher-${index + 1}@example.test`,
    orgId: "org-1",
    orgName: "研究中心",
    role: "member",
    platformRole: "user",
  }));
  await page.addInitScript(() => {
    localStorage.setItem("kq_token", "fixture-token");
    localStorage.setItem("kq_email", "admin@example.test");
    localStorage.setItem("kq_role", "super_admin");
    localStorage.setItem("kq.lang", "zh");
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.includes("/api/")) {
      if (url.pathname.endsWith("/me/capabilities"))
        return json({
          principal: {
            userId: "00000000-0000-4000-8000-000000000001",
            email: "admin@example.test",
            role: "super_admin",
          },
          capabilities: ["workspace.platform.view", "workspace.platform.manage"],
          contexts: [{ id: "platform", type: "platform" }],
          activeContextId: "platform",
          devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
        });
      if (url.pathname.endsWith("/membership-options"))
        return json({
          data: {
            users: [
              { id: "new-user", email: "alice@example.test", displayName: "Alice", role: "user" },
            ],
            organizations: [{ id: "org-1", name: "研究中心" }],
            moreUsers: false,
            moreOrganizations: false,
          },
        });
      if (url.pathname.endsWith("/memberships") && route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as {
          userId: string;
          orgId: string;
          role: string;
          createOnly: boolean;
        };
        writes.push(body);
        const existing = members.find((item) => item.userId === body.userId);
        if (existing) existing.role = body.role;
        else
          members.unshift({
            id: "new",
            ...body,
            displayName: "Alice",
            email: "alice@example.test",
            orgName: "研究中心",
            platformRole: "user",
          });
        return json({ success: true });
      }
      if (url.pathname.includes("/memberships/") && route.request().method() === "DELETE") {
        writes.push({ remove: url.pathname });
        members = members.filter((item) => !url.pathname.endsWith(`/${item.userId}/${item.orgId}`));
        return json({ success: true });
      }
      if (url.pathname.endsWith("/memberships")) {
        const search = url.searchParams.get("search") ?? "";
        const filtered = members.filter((member) =>
          [member.displayName, member.email, member.orgName].some((value) =>
            value.includes(search),
          ),
        );
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return json({
          data: filtered.slice(offset, offset + 20),
          hasMore: filtered.length > offset + 20,
        });
      }
      if (/\/authz\/(health|readiness)$/.test(url.pathname))
        return json({
          data: {
            mode: "enforce",
            healthy: true,
            schemaWritten: true,
            schemaMatches: true,
            outbox: { pending: 0, processing: 0, dead: 0 },
            shadowDiffs: 0,
            enforceReady: true,
            blockers: [],
            externalSmokeRequired: false,
          },
        });
      if (url.pathname.includes("sandbox") || url.pathname.includes("authz"))
        return json({ data: [] });
      return json({});
    }
    const path = url.pathname.startsWith("/assets/") ? url.pathname.slice(1) : "index.html";
    const types: Record<string, string> = {
      ".js": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".html": "text/html",
    };
    return route.fulfill({
      body: await readFile(resolve(import.meta.dirname, "../dist", path)),
      contentType: types[extname(path)] ?? "application/octet-stream",
    });
  });
  await page.goto("/settings#security/authz");
  const panel = page.getByTestId("organization-membership-panel");
  await expect(panel.getByText("研究员 1", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "下一页" }).click();
  await expect(panel.getByText("研究员 24", { exact: true })).toBeVisible();
  await panel.getByLabel("搜索组织成员").fill("researcher-24@");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await panel.getByRole("button", { name: "编辑 研究员 24 的组织权限" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("组织角色").selectOption("operator");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const save = dialog.getByRole("button", { name: "保存", exact: true });
    await expect(save).toBeInViewport();
    if (width < 768) await expect(save).toBeDisabled();
    else await expect(save).toBeEnabled();
    const box = await save.boundingBox();
    expect(box).not.toBeNull();
    if (box && width >= 768)
      expect(
        await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent,
          { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        ),
      ).toBe("保存");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`member-edit-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes[0]).toEqual({
    userId: "user-23",
    orgId: "org-1",
    role: "operator",
    createOnly: false,
  });
  await expect(panel.getByText("运营人员", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "添加成员" }).click();
  await dialog
    .getByLabel("用户", { exact: true })
    .selectOption({ label: "Alice · alice@example.test" });
  await dialog.getByLabel("组织", { exact: true }).selectOption({ label: "研究中心" });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes[1]).toEqual({
    userId: "new-user",
    orgId: "org-1",
    role: "member",
    createOnly: true,
  });
  await panel.getByLabel("搜索组织成员").fill("Alice");
  await panel.getByRole("button", { name: "移除 Alice 的组织成员资格" }).click();
  expect(writes).toHaveLength(2);
  await dialog.getByRole("button", { name: "确认移除" }).click();
  await expect(panel.getByText("未找到匹配成员")).toBeVisible();
  expect(writes[2]).toEqual({ remove: "/platform/api/admin/authz/memberships/new-user/org-1" });
  expect(errors).toEqual([]);
});
