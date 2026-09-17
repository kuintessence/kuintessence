import { expect, test } from "patchright/test";

test("serves the stable branding assets from the production SPA", async ({ page }) => {
  for (const assetPath of ["/branding/logo.svg", "/branding/favicon.svg"]) {
    const response = await page.goto(assetPath);

    expect(response?.status(), `${assetPath} status`).toBe(200);
    expect(response?.headers()["content-type"], `${assetPath} content type`).toContain(
      "image/svg+xml",
    );
    expect(await page.locator("svg").count(), `${assetPath} SVG root`).toBe(1);
  }
});
