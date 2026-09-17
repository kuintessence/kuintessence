import { expect, test } from "patchright/test";

const cases = [
  {
    language: "en",
    role: "platform_admin",
    hash: "infrastructure/cluster-file-roots",
    expected: "Cluster file roots",
  },
  {
    language: "zh",
    role: "platform_admin",
    hash: "security/sandbox-security",
    expected: "隔离运行环境安全",
  },
  {
    language: "en",
    role: "org_admin",
    hash: "infrastructure/cluster-file-roots",
    expected: "Platform configuration is restricted",
  },
  {
    language: "zh",
    role: "org_admin",
    hash: "security/sandbox-security",
    expected: "平台配置受限",
  },
] as const;

for (const { expected, hash, language, role } of cases) {
  test(`${language} ${role} keeps Settings deep-link access explicit after refresh`, async ({
    page,
  }) => {
    await page.addInitScript(
      ({ language, role }: { language: string; role: string }) => {
        localStorage.setItem("kq.lang", language);
        localStorage.setItem("kq_email", "fixture@example.test");
        localStorage.setItem("kq_role", role);
        localStorage.setItem("kq_token", "fixture-token");
        localStorage.setItem("kq_token_expires_at", String(Date.now() + 3_600_000));
      },
      { language, role },
    );
    await page.route("**/platform/api/branding", (route) =>
      route.fulfill({ contentType: "application/json", body: "{}" }),
    );

    await page.goto(`/settings#${hash}`);
    await expect(page.getByTestId("settings-page")).toContainText(expected);
    if (role === "org_admin") {
      await expect(page.getByTestId("settings-restricted-deep-link")).toBeVisible();
      await expect(page.getByText(/Account and session|账户与会话/)).toHaveCount(0);
    }
    await page.reload();
    await expect(page.getByTestId("settings-page")).toContainText(expected);
  });
}
