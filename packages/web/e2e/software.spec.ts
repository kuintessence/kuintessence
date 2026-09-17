import { expect, test } from "patchright/test";

/**
 * Software registry acceptance:
 *   1. Cards render one per workflow template (name, version, tags).
 *   2. Clicking "Use template" navigates to /workflows/new with the editor populated.
 *   3. 503/404 from the upstream surfaces a "not reachable" banner.
 *   4. Empty list surfaces an empty-state.
 */
test.describe("Software registry", () => {
  async function login(page: import("patchright/test").Page) {
    await page.goto("/");
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.route("**/api/auth/login", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "tok-test", expiresIn: 900 }),
      }),
    );
    await page.route("**/api/jobs", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [] }),
      }),
    );
    await page.route("**/api/workflows", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      }),
    );
    await page.route("**/api/agents", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agents: [] }),
      }),
    );
    await page.route("**/api/audit-log**", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entries: [] }),
      }),
    );
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("demo@example.com");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL("/");
  }

  test("renders one card per template and Use lands on the editor", async ({ page }) => {
    const templates = [
      {
        id: "t-hello",
        name: "Hello world",
        version: "0.1.0",
        description: "Single-step demo",
        yamlContent: [
          "name: hello",
          "parameters: []",
          "spec:",
          "  nodeDrafts:",
          "    - type: SoftwareUsecaseComputing",
          "      id: a",
          "      name: A",
          '      usecaseVersionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301"',
          '      softwareVersionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"',
          "      inputSlots:",
          "        - type: Text",
          "          descriptor: script",
          "          from:",
          "            expr: \"'echo hi'\"",
          "  nodeRelations: []",
          "",
        ].join("\n"),
        tags: ["demo", "tutorial"],
        createdAt: new Date().toISOString(),
      },
      {
        id: "t-pipe",
        name: "Two-step pipeline",
        version: "0.2.0",
        description: "DAG demo",
        yamlContent: [
          "name: pipe",
          "parameters: []",
          "spec:",
          "  nodeDrafts:",
          "    - type: SoftwareUsecaseComputing",
          "      id: a",
          "      name: A",
          '      usecaseVersionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301"',
          '      softwareVersionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"',
          "      inputSlots:",
          "        - type: Text",
          "          descriptor: script",
          "          from:",
          "            expr: \"'echo a'\"",
          "    - type: SoftwareUsecaseComputing",
          "      id: b",
          "      name: B",
          '      usecaseVersionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301"',
          '      softwareVersionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7"',
          "      inputSlots:",
          "        - type: Text",
          "          descriptor: script",
          "          from:",
          "            expr: \"'echo b'\"",
          "  nodeRelations:",
          "    - fromId: a",
          "      toId: b",
          "      slotRelations: []",
          "",
        ].join("\n"),
        tags: ["pipeline"],
        createdAt: new Date().toISOString(),
      },
    ];
    await page.route("**/software/api/workflow-templates", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ workflowTemplates: templates }),
      }),
    );

    await login(page);
    await page.getByTestId("nav-software").click();
    await expect(page).toHaveURL("/software");
    await expect(page.getByTestId("software-grid")).toBeVisible();
    await expect(page.getByTestId("software-card-t-hello")).toBeVisible();
    await expect(page.getByTestId("software-card-t-pipe")).toBeVisible();
    await expect(page.getByTestId("software-count")).toContainText("2");
    await expect(page.getByTestId("software-tags-t-hello")).toContainText("demo");

    // Click "Use template" on the first card → /workflows/new with the editor populated.
    await page.getByTestId("software-use-t-hello").click();
    await expect(page).toHaveURL("/workflows/new");
    // The editor renders Monaco asynchronously; assert the parsed-summary panel reflects
    // the new YAML's step count rather than depending on Monaco internals.
    await expect(page.getByTestId("parsed-summary")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("parsed-summary")).toContainText("1");
  });

  test("503 from the upstream surfaces the unreachable banner", async ({ page }) => {
    await page.route("**/software/api/workflow-templates", async (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "not running" } }),
      }),
    );
    await login(page);
    await page.getByTestId("nav-software").click();
    await expect(page.getByTestId("software-banner-unreachable")).toBeVisible();
  });

  test("empty registry surfaces the empty-state", async ({ page }) => {
    await page.route("**/software/api/workflow-templates", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ workflowTemplates: [] }),
      }),
    );
    await login(page);
    await page.getByTestId("nav-software").click();
    await expect(page.getByTestId("software-empty")).toBeVisible();
  });
});
