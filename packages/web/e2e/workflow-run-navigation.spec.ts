import { expect, test } from "patchright/test";

const runId = "00000000-0000-4000-8000-000000000001";
const jobId = "00000000-0000-4000-8000-000000000002";
const timestamp = "2026-01-01T00:00:00.000Z";

for (const width of [1440, 390]) {
  test(`opens a completed node's job with the keyboard at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      window.__KQ_LOCAL__ = { baseUrl: "http://127.0.0.1:9999/api", token: "ui-fixture" };
      localStorage.setItem("kq.theme", "dark");
    });
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/placement")) return route.fulfill({ status: 404, body: "{}" });
      let body: unknown = {};
      if (path.endsWith(`/workflows/${runId}`)) {
        body = {
          id: runId,
          name: "Completed workflow",
          description: null,
          status: "completed",
          createdAt: timestamp,
          stepJobs: { solve: jobId },
          graph: {
            nodes: [
              { id: "solve", name: "Solve", kind: "SoftwareUsecaseComputing" },
              { id: "finish", name: "Finish", kind: "NoAction" },
            ],
            edges: [{ source: "solve", target: "finish" }],
          },
          result: { status: { solve: "completed", finish: "completed" }, values: {} },
        };
      } else if (path.endsWith(`/jobs/${jobId}`)) {
        body = {
          id: jobId,
          name: "Solver job",
          status: "completed",
          submittedAt: timestamp,
          exitCode: 0,
        };
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });

    await page.goto(`/workflows/${runId}`);
    await expect(page.getByTestId("run-graph")).toHaveClass(/dark/);
    const jobLink = page.getByTestId("run-node-job-solve");
    await expect(jobLink).toHaveAttribute("href", `/jobs/${jobId}`);
    await expect(page.getByTestId("run-node-job-finish")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("run-dark.png"), animations: "disabled" });
    const configuration = page.getByTestId("workflow-run-configuration");
    await expect(configuration).not.toHaveAttribute("open");
    await configuration.locator("summary").click();
    await expect(configuration).toHaveAttribute("open", "");
    await jobLink.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("job-detail-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Solver job" })).toBeVisible();
    await expect(page.getByTestId("job-overview-tab")).toContainText("0");
    await expect(page.getByRole("tab", { name: /Logs|日志/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Files|文件/ })).toBeVisible();
  });
}
