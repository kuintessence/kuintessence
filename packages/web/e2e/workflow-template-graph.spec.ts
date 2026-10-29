import { expect, test } from "patchright/test";

const templateId = "00000000-0000-4000-8000-000000000003";
const yamlContent = `# ${"Long source line ".repeat(20)}
name: Connected template
parameters: []
spec:
  nodeDrafts:
    - id: start
      name: Start
      type: NoAction
    - id: middle
      name: Middle
      type: NoAction
    - id: finish
      name: Finish
      type: NoAction
  nodeRelations:
    - fromId: start
      toId: middle
      slotRelations: []
    - fromId: middle
      toId: finish
      slotRelations: []
`;

test("template preview draws dependencies and follows theme changes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => {
    window.__KQ_LOCAL__ = { baseUrl: "http://127.0.0.1:9999/api", token: "ui-fixture" };
    localStorage.setItem("kq.theme", "dark");
    localStorage.setItem("kq.lang", "en");
  });
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname.endsWith(`/workflow-templates/${templateId}`)
      ? {
          id: templateId,
          name: "Connected template",
          version: "1.0.0",
          createdAt: "2026-01-01T00:00:00Z",
          description: "",
          tags: [],
          yamlContent,
        }
      : {};
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`/software/workflow-templates/${templateId}`);
  const graph = page.getByTestId("software-template-flow");
  await expect(graph.locator(".react-flow__node")).toHaveCount(3);
  await expect(graph.locator(".react-flow__edge-path")).toHaveCount(2);
  await expect(graph.locator(".react-flow")).toHaveClass(/dark/);
  await expect
    .poll(() =>
      page.locator('[data-testid="software-template-flow"], main pre').evaluateAll((elements) =>
        elements.every((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.width > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth;
        }),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.locator("main pre").evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);
  await expect
    .poll(() =>
      graph.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll(".react-flow__node")].every((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left >= bounds.left && rect.right <= bounds.right;
        });
      }),
    )
    .toBe(true);
  await page.getByTestId("theme-menu").click();
  await page.getByRole("menuitem", { name: /Light/ }).click();
  await expect(graph.locator(".react-flow")).toHaveClass(/light/);
  await expect(graph.locator(".react-flow__edge-path")).toHaveCount(2);
});
