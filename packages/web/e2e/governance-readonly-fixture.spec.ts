import { writeFileSync } from "node:fs";
import type { Page } from "patchright";
import { expect, test } from "patchright/test";

const ORG_A = "00000000-0000-4000-8000-000000000010";
const ORG_B = "00000000-0000-4000-8000-000000000020";
const ORG_C = "00000000-0000-4000-8000-000000000030";
const USER_ID = "00000000-0000-4000-8000-000000000001";

function capabilityResponse(organizationId: string) {
  return {
    activeContextId: `organization:${organizationId}`,
    capabilities: ["workspace.provider.view", "workspace.provider.manage"],
    contexts: [
      {
        id: `organization:${organizationId}`,
        membershipRole: "admin",
        organizationId,
        type: "organization",
      },
    ],
    devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
    principal: { email: "qa@example.test", role: "user", userId: USER_ID },
  };
}

async function prepareAuthenticatedPage(page: Page, organizationId: string, evidence: string[]) {
  await page.addInitScript(
    ({ id }: { id: string }) => {
      localStorage.setItem("kq_active_organization_id", id);
      localStorage.setItem("kq_email", "qa@example.test");
      localStorage.setItem("kq_role", "user");
      localStorage.setItem("kq_token", "fixture-token");
      localStorage.setItem("kq_token_expires_at", String(Date.now() + 3_600_000));
    },
    { id: organizationId },
  );
  await page.route("**/platform/api/branding", async (route) => {
    evidence.push(`${route.request().method()} ${route.request().url()} -> 200 branding`);
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.route("**/platform/api/me/capabilities", async (route) => {
    const headers = route.request().headers();
    expect(headers.authorization).toBe("Bearer fixture-token");
    const organization = headers["x-kq-active-organization"] ?? organizationId;
    evidence.push(`${route.request().method()} ${route.request().url()} -> 200 raw capabilities`);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(capabilityResponse(organization)),
    });
  });
  await page.route("**/api/me/active-organization", async (route) => {
    evidence.push(
      `${route.request().method()} ${route.request().url()} -> 200 raw active organization`,
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        activeOrganizationId: organizationId,
        organizations: [
          { name: "Organization A", orgId: ORG_A, role: "admin" },
          { name: "Organization B", orgId: ORG_B, role: "admin" },
        ],
      }),
    });
  });
}

function setActiveOrganization(page: Page, organizationId: string | null) {
  return page.evaluate((id) => {
    if (id) localStorage.setItem("kq_active_organization_id", id);
    else localStorage.removeItem("kq_active_organization_id");
    window.dispatchEvent(new Event("kq:active-organization-change"));
  }, organizationId);
}

test("governance read-only browser fixture keeps historical values, organization scope, and GET-only retries", async ({
  page,
}, testInfo) => {
  const evidence: string[] = [];
  let delayOrgA = false;
  let releaseDelayedOrgA: (() => void) | undefined;
  let errorMode = false;
  let retryRead = false;

  await prepareAuthenticatedPage(page, ORG_A, evidence);
  await page.route("**/platform/api/cp/users**", async (route) => {
    const request = route.request();
    const headers = request.headers();
    const organization = headers["x-kq-active-organization"];
    expect(request.method()).toBe("GET");
    expect(organization === ORG_A || organization === ORG_B || organization === ORG_C).toBe(true);

    if (errorMode) {
      evidence.push(
        `${request.method()} ${request.url()} org=${organization} -> 503 ordinary read error`,
      );
      await route.fulfill({
        contentType: "application/json",
        status: 503,
        body: JSON.stringify({
          error: { code: "SERVICE_UNAVAILABLE", message: "fixture unavailable" },
        }),
      });
      return;
    }
    if (retryRead) {
      evidence.push(`${request.method()} ${request.url()} org=${organization} -> 200 retry`);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          total: 1,
          items: [
            {
              id: "b-retry",
              email: "retry@example.test",
              role: "user",
              suspended: false,
              quota: 3,
            },
          ],
        }),
      });
      return;
    }
    if (organization === ORG_A && delayOrgA) {
      evidence.push(`${request.method()} ${request.url()} org=${organization} -> delayed 200`);
      await new Promise<void>((resolve) => {
        releaseDelayedOrgA = resolve;
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          total: 1,
          items: [
            {
              id: "a-late",
              email: "late-a@example.test",
              role: "user",
              suspended: false,
              quota: 2,
            },
          ],
        }),
      });
      return;
    }
    if (organization === ORG_B) {
      evidence.push(
        `${request.method()} ${request.url()} org=${organization} -> 200 current organization`,
      );
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          total: 1,
          items: [{ id: "b", email: "b@example.test", role: "user", suspended: false, quota: 2 }],
        }),
      });
      return;
    }

    evidence.push(
      `${request.method()} ${request.url()} org=${organization} -> 200 historical values`,
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        total: 3,
        items: [
          { id: "a-marked", email: "marked@example.test", role: "user", suspended: true, quota: 0 },
          {
            id: "a-not-marked",
            email: "not-marked@example.test",
            role: "user",
            suspended: false,
            quota: 7,
          },
          { id: "a-missing", email: "missing@example.test", role: "user" },
        ],
      }),
    });
  });

  await page.goto("/cp/users");
  await expect(page.getByTestId("cp-users-row-a-marked")).toBeVisible();
  await expect(page.getByTestId("cp-users-readonly-notice")).toBeVisible();
  await expect(page.getByText("0 (legacy API value)")).toBeVisible();
  await expect(
    page
      .getByTestId("cp-users-row-a-marked")
      .getByText("Marked (historical field)", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("cp-users-row-a-not-marked")
      .getByText("Not marked (historical field)", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Cannot determine (historical field)")).toBeVisible();
  await expect(page.getByText("Not provided")).toBeVisible();
  await expect(page.getByTestId("cp-users-suspend-a-marked")).toHaveCount(0);
  await expect(page.getByTestId("cp-users-edit-quota-a-marked")).toHaveCount(0);

  const userGetsBeforeNoOrganization = evidence.filter((entry) =>
    entry.includes("/platform/api/cp/users"),
  ).length;
  await setActiveOrganization(page, null);
  await expect(page.getByTestId("cp-users-organization-required")).toBeVisible();
  await expect(page.getByTestId("cp-users-row-a-marked")).toHaveCount(0);
  await page.waitForTimeout(250);
  expect(evidence.filter((entry) => entry.includes("/platform/api/cp/users")).length).toBe(
    userGetsBeforeNoOrganization,
  );

  delayOrgA = true;
  await page.reload();
  await expect.poll(() => releaseDelayedOrgA !== undefined).toBe(true);
  await setActiveOrganization(page, ORG_B);
  await expect(page.getByTestId("cp-users-row-b")).toBeVisible();
  releaseDelayedOrgA?.();
  await page.waitForTimeout(250);
  await expect(page.getByTestId("cp-users-row-a-late")).toHaveCount(0);
  await expect(page.getByTestId("cp-users-row-b")).toBeVisible();

  errorMode = true;
  await setActiveOrganization(page, ORG_C);
  await expect(page.getByTestId("cp-users-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("cp-users-error")).not.toContainText("write disabled");
  errorMode = false;
  retryRead = true;
  await page.getByText("Retry reading").click();
  await expect(page.getByTestId("cp-users-row-b-retry")).toBeVisible();

  await page.context().setOffline(true);
  await expect(page.getByTestId("cp-users-offline")).toBeVisible();
  await expect(page.getByTestId("cp-users-row-b-retry")).toHaveCount(0);
  await page.context().setOffline(false);

  const posts = evidence.filter((entry) => entry.startsWith("POST "));
  const userGets = evidence.filter((entry) => entry.includes("/platform/api/cp/users"));
  expect(userGets.length).toBeGreaterThanOrEqual(4);
  expect(posts.filter((entry) => /\/suspend|\/quota/.test(entry))).toHaveLength(0);
  expect(evidence.some((entry) => entry.includes(`org=${ORG_A}`))).toBe(true);
  expect(evidence.some((entry) => entry.includes(`org=${ORG_B}`))).toBe(true);
  writeFileSync(testInfo.outputPath("governance-request-log.txt"), `${evidence.join("\n")}\n`);
});
