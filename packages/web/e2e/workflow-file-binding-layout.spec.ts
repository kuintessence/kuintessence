import { Buffer } from "node:buffer";
import { expect, test } from "patchright/test";

const PACKAGE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3321";
const REVISION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3322";
const LOCAL_BASE = "http://127.0.0.1:9999/api";
const LOCAL_TOKEN = "workflow-file-binding-layout-token";

const fileUsecase = {
  id: PACKAGE_ID,
  publishedSoftwareRevisionId: REVISION_ID,
  name: "File layout acceptance package",
  version: "1.0.0",
  description: "A package with one file input.",
  createdAt: "2026-08-26T00:00:00.000Z",
  spec: {
    description: "A package with one file input.",
    domain: "test",
    tags: [],
    citations: [],
    softwareRef: { source: "official-upstream", name: "zlib", version: "1.3.1" },
    inputs: [{ descriptor: "source", type: "File", required: true }],
    outputs: [],
    resources: {},
    materialMappings: [],
    dataRequirements: [],
    licensedMaterials: [],
    licenseRequirements: [],
    usecase: {
      commandFile: "run.sh",
      inputSlots: [
        {
          kind: "File",
          descriptor: "source",
          refMaterials: [{ kind: "FileInputRef", descriptor: "source" }],
        },
      ],
    },
    software: { kind: "Spack", name: "zlib", version: "1.3.1", argumentList: [] },
    arguments: [],
    environments: [],
    filesomeInputs: [{ descriptor: "source", fileKind: { kind: "Normal", name: "source.txt" } }],
    filesomeOutputs: [],
    valueOutputs: [],
  },
};

function json(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

test.describe("Workflow file binding layout", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps the bound file visible and its remove button pointer-clickable", async ({ page }) => {
    await page.addInitScript(
      ([baseUrl, token]) => {
        window.__KQ_LOCAL__ = { baseUrl, token };
      },
      [LOCAL_BASE, LOCAL_TOKEN] as const,
    );
    // Register the fallback first: Patchright uses reverse registration order,
    // so the narrower route mocks below take precedence.
    await page.route("**/api/**", (route) => route.fulfill(json({})));
    await page.route("**/api/capabilities", (route) =>
      route.fulfill(
        json({
          jobs: true,
          submit: true,
          logs: true,
          workflows: true,
          agents: false,
          metrics: true,
          software: true,
          ssh: false,
        }),
      ),
    );
    await page.route("**/api/workflows**", (route) => route.fulfill(json({ runs: [] })));
    await page.route("**/api/workflows/drafts", (route) => route.fulfill(json({ drafts: [] })));
    await page.route("**/api/jobs**", (route) => route.fulfill(json({ jobs: [] })));
    await page.route("**/api/agents**", (route) => route.fulfill(json({ agents: [] })));
    await page.route("**/api/audit-log**", (route) => route.fulfill(json({ entries: [] })));
    await page.route("**/api/auth/oidc/config-public", (route) =>
      route.fulfill(json({ enabled: false, providerName: "" })),
    );
    await page.route("**/software/api/usecase-packages**", (route) =>
      route.fulfill(json({ usecasePackages: [fileUsecase], packages: [fileUsecase], tags: [] })),
    );

    await page.goto("/");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.getByTestId("workspace-nav-nav-workflows").click();
    await page.getByTestId("workflows-new").click();
    await page.getByTestId("workflow-start-scratch").click();
    await page.getByTestId("rf-palette-SoftwareUsecaseComputing").click();
    await page.getByTestId(`workflow-usecase-option-${PACKAGE_ID}`).dblclick();
    await page.getByTestId("workflow-step-inputs").click();

    const fileInput = page.locator('[data-testid^="workflow-choose-local-file-slot:"]');
    const folderInput = page.locator('[data-testid^="workflow-choose-local-folder-slot:"]');
    await expect(fileInput).not.toHaveAttribute("webkitdirectory", "");
    await expect(folderInput).toHaveAttribute("webkitdirectory", "");
    await expect(folderInput).toHaveAttribute("multiple", "");

    await fileInput.setInputFiles({
      name: "layout-visible.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("x"),
    });
    const bindingName = page.locator('[data-testid^="workflow-file-binding-name-"]');
    await expect(bindingName).toHaveText("layout-visible.txt");
    const nameBox = await bindingName.boundingBox();
    expect(nameBox?.width).toBeGreaterThan(8);
    await expect(bindingName).toBeVisible();

    const remove = page.locator('[data-testid^="workflow-file-binding-remove-"]');
    const removeBox = await remove.boundingBox();
    expect(removeBox?.width).toBeGreaterThan(0);
    expect(removeBox?.height).toBeGreaterThan(0);
    await expect(remove).toBeVisible();
    await expect
      .poll(() =>
        remove.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit === element || element.contains(hit);
        }),
      )
      .toBe(true);
    await page.mouse.click(
      (removeBox?.x ?? 0) + (removeBox?.width ?? 0) / 2,
      (removeBox?.y ?? 0) + (removeBox?.height ?? 0) / 2,
    );
    await expect(bindingName).toHaveCount(0);
  });
});
