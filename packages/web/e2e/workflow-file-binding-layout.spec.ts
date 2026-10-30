import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, test } from "patchright/test";
import { parse } from "yaml";

const PACKAGE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3321";
const REVISION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3322";
const LOCAL_BASE = "http://127.0.0.1:9999/api";
const LOCAL_TOKEN = "workflow-file-binding-layout-token";
const RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3324";
const JOB_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3325";
const OUTPUT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3326";
const OUTPUT_TEXT = "UI fixture result\n";

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
  // Chromium's download requests bypass page route interception.
  const outputServer = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="result.txt"',
    });
    response.end(OUTPUT_TEXT);
  });
  let outputUrl = "";
  test.beforeAll(async () => {
    await new Promise<void>((resolve) => outputServer.listen(0, "127.0.0.1", resolve));
    const address = outputServer.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture server port");
    outputUrl = `http://127.0.0.1:${address.port}/result.txt`;
  });
  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      outputServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test("keeps configured inputs through submission, job navigation, and result download", async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    let submittedNode: { id: string; name: string; type: string } | undefined;
    await page.addInitScript(
      ([baseUrl, token]) => {
        window.__KQ_LOCAL__ = { baseUrl, token };
        localStorage.setItem("kq.theme", "dark");
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
    await page.route("**/api/workflows**", (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.endsWith("/workflows")) {
        const body = request.postDataJSON() as { yaml: string; budgetCap: number };
        expect(body.budgetCap).toBe(10);
        expect(body.yaml).toContain(PACKAGE_ID);
        expect(body.yaml).toContain("layout-visible.txt");
        const workflow = parse(body.yaml) as {
          spec: { nodeDrafts: Array<{ id: string; name: string; type: string }> };
        };
        submittedNode = workflow.spec.nodeDrafts[0];
        return route.fulfill(json({ runId: RUN_ID, name: "File workflow" }));
      }
      if (path.endsWith(`/workflows/${RUN_ID}`)) {
        if (!submittedNode) throw new Error("Run was opened before workflow submission");
        return route.fulfill(
          json({
            id: RUN_ID,
            name: "File workflow",
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            stepJobs: { [submittedNode.id]: JOB_ID },
            graph: {
              nodes: [{ ...submittedNode, kind: submittedNode.type }],
              edges: [],
            },
            result: { status: { [submittedNode.id]: "completed" }, values: {} },
          }),
        );
      }
      return route.fulfill(json({ runs: [] }));
    });
    await page.route("**/api/workflows/drafts", (route) => route.fulfill(json({ drafts: [] })));
    await page.route("**/api/jobs**", (route) => route.fulfill(json({ jobs: [] })));
    await page.route(`**/api/jobs/${JOB_ID}`, (route) =>
      route.fulfill(
        json({
          id: JOB_ID,
          name: "File processing job",
          status: "completed",
          submittedAt: "2026-01-01T00:00:00.000Z",
          exitCode: 0,
          expectedOutputs: [{ descriptor: "result", path: "result.txt", isBatch: false }],
        }),
      ),
    );
    await page.route(`**/api/jobs/${JOB_ID}/logs?text=1`, (route) =>
      route.fulfill(json({ text: "Input received: layout-visible.txt\r\nResult: result.txt\r\n" })),
    );
    await page.route("**/api/agents**", (route) => route.fulfill(json({ agents: [] })));
    await page.route("**/api/audit-log**", (route) => route.fulfill(json({ entries: [] })));
    await page.route("**/api/auth/oidc/config-public", (route) =>
      route.fulfill(json({ enabled: false, providerName: "" })),
    );
    await page.route("**/software/api/usecase-packages**", (route) =>
      route.fulfill(json({ usecasePackages: [fileUsecase], packages: [fileUsecase], tags: [] })),
    );

    await page.route("**/api/netdrive/upload-url", (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            uploadUrl: "http://127.0.0.1:4173/ui-fixture-upload",
            storageKey: "fixture",
            commitToken: "fixture",
          },
        }),
      ),
    );
    await page.route("**/ui-fixture-upload", (route) => route.fulfill({ status: 200 }));
    await page.route("**/api/netdrive/files", (route) =>
      route.fulfill(
        json(
          route.request().method() === "GET"
            ? {
                success: true,
                data: {
                  files: [
                    {
                      id: OUTPUT_ID,
                      canUse: true,
                      canDelete: false,
                      path: `outputs/${JOB_ID}/result.txt`,
                      size: OUTPUT_TEXT.length,
                      mtime: "2026-01-01T00:00:00.000Z",
                    },
                  ],
                  total: 1,
                },
              }
            : {
                success: true,
                data: {
                  ...route.request().postDataJSON(),
                  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3323",
                },
              },
        ),
      ),
    );
    await page.route(`**/api/netdrive/files/${OUTPUT_ID}/download-url`, (route) =>
      route.fulfill(json({ success: true, data: { downloadUrl: outputUrl } })),
    );

    await page.goto("/");
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.getByTestId("workspace-nav-nav-workflows").click();
    await page.getByTestId("workflows-new").click();
    await page.getByTestId("workflow-start-scratch").click();
    await page.getByTestId("rf-palette-SoftwareUsecaseComputing").click();
    await page.getByTestId(`workflow-usecase-option-${PACKAGE_ID}`).dblclick();
    await expect(page.getByTestId("rf-editor").locator(".react-flow")).toHaveClass(/dark/);
    await page.screenshot({ path: testInfo.outputPath("editor-dark.png"), animations: "disabled" });
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

    await fileInput.setInputFiles({
      name: "layout-visible.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("x"),
    });
    await page.getByTestId("workflow-step-resources").click();
    await page.getByTestId("workflow-association-confirm-continue").click();
    await expect(page.getByTestId("workflow-resources-step")).toBeVisible();
    await page.getByTestId("workflow-resource-budget-cap").fill("10");
    await page.getByTestId("workflow-step-review").click();
    await expect(page.getByTestId("workflow-review-step")).toBeVisible();
    await page.getByTestId("workflow-step-resources").click();
    await expect(page.getByTestId("workflow-resource-budget-cap")).toHaveValue("10");
    await page.getByTestId("workflow-step-inputs").click();
    await expect(bindingName).toHaveText("layout-visible.txt");
    await page.getByTestId("workflow-step-review").click();
    await page.getByTestId("submit-workflow").click();
    await expect(page.getByTestId("workflow-submit-confirm-dialog")).toBeVisible();
    await page.getByTestId("workflow-submit-confirm").click();
    await expect(page).toHaveURL(`/workflows/${RUN_ID}`);
    const jobLink = page.locator('[data-testid^="run-node-job-"]');
    await expect(jobLink).toHaveAttribute("href", `/jobs/${JOB_ID}`);
    await jobLink.click();
    await expect(page.getByRole("heading", { name: "File processing job" })).toBeVisible();
    const logsResponse = page.waitForResponse((response) =>
      response.url().includes(`/${JOB_ID}/logs?`),
    );
    await page.getByRole("tab", { name: /Logs|日志/ }).click();
    expect((await (await logsResponse).json()).text).toContain(
      "Input received: layout-visible.txt",
    );
    await expect(page.getByTestId("job-logs-terminal")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("job-logs.png"), animations: "disabled" });
    await page.getByRole("tab", { name: /Files|文件/ }).click();
    const downloadButton = page.getByTestId(`job-file-output-download-cloud-result-${OUTPUT_ID}`);
    await expect(downloadButton).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("job-files.png"), animations: "disabled" });
    const downloadPromise = page.waitForEvent("download");
    await downloadButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("result.txt");
    const downloadPath = testInfo.outputPath("result.txt");
    await download.saveAs(downloadPath);
    expect(await readFile(downloadPath, "utf8")).toBe(OUTPUT_TEXT);
    expect(pageErrors).toEqual([]);
  });
});
