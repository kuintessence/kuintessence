import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: "zh-CN" },
    t: (key: string, opts?: { defaultValue?: string; provider?: string }) => {
      const messages: Record<string, string> = {
        "login.platformWelcome": "欢迎使用 Kuintessence 算力网络平台",
        "login.showDevLogin": "显示开发者登录",
        "login.signInWithSso": "使用 {{provider}} 登录",
        "login.ssoNote": "登录后将进入平台。",
        "login.ssoProvider": "统一身份认证",
        "login.ssoLoading": "正在载入统一身份认证",
        "login.ssoUnavailable": "平台尚未启用统一身份认证，请联系管理员。",
        "login.ssoConfigFailed": "暂时无法获取统一身份认证配置，请重试。",
        "login.retry": "重试",
      };
      return (messages[key] ?? opts?.defaultValue ?? key).replace(
        "{{provider}}",
        opts?.provider ?? "",
      );
    },
  }),
}));

// createFileRoute runs at module load; stub it to a passthrough so importing
// the route file doesn't pull in the router runtime. useNavigate is unused by
// these assertions but must be a function.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => ({ options: opts }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../assets/logo.svg", () => ({ default: "logo.svg" }));
vi.mock("../lib/auth", () => ({
  getAuthState: () => ({ isAuthenticated: false, email: null, role: null, expiresAt: null }),
  setAuth: vi.fn(),
}));

import { Login, shouldExposeDevLogin } from "./login";

function stubConfigPublic(body: {
  enabled: boolean;
  providerName: string;
  welcomeMessage?: { zh: string; en: string };
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ...body, welcomeMessage: body.welcomeMessage ?? { zh: "", en: "" } }),
          { status: 200 },
        ),
      ),
    ),
  );
}

describe("Login page SSO entry", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("does not expose dev login controls in a production build", async () => {
    expect(shouldExposeDevLogin(false)).toBe(false);
    expect(shouldExposeDevLogin(false, false)).toBe(false);
    stubConfigPublic({ enabled: true, providerName: "科研统一身份认证" });
    render(<Login devLoginAvailable={false} />);

    expect(await screen.findByTestId("sso-login-button")).toBeTruthy();
    expect(screen.queryByTestId("dev-login-toggle")).toBeNull();
    expect(screen.queryByTestId("login-form")).toBeNull();
  });

  test("allows the explicit preview build to expose development login", () => {
    expect(shouldExposeDevLogin(false, true)).toBe(true);
    expect(shouldExposeDevLogin(true, false)).toBe(true);
  });

  test("renders the SSO button and hides the dev-login form when SSO is enabled", async () => {
    stubConfigPublic({
      enabled: true,
      providerName: "科研统一身份认证",
      welcomeMessage: { zh: "欢迎访问科研算力平台", en: "Welcome" },
    });
    render(<Login devLoginAvailable />);

    // The SSO card appears once the public config resolves.
    expect(await screen.findByTestId("sso-login-button")).toBeTruthy();
    // Dev login is collapsed behind a toggle, not rendered, when SSO is the path.
    expect(screen.queryByTestId("login-form")).toBeNull();
    expect(screen.getByTestId("dev-login-toggle")).toBeTruthy();
    expect(screen.getByTestId("sso-login-button").textContent).toContain(
      "使用 科研统一身份认证 登录",
    );
    expect(screen.getByText("登录后将进入平台。")).toBeTruthy();
    expect(screen.getByText("显示开发者登录")).toBeTruthy();
    expect(screen.getByTestId("login-platform-message").textContent).toBe("欢迎访问科研算力平台");
    expect(screen.queryByText(/localhost|v0\.0\.1/)).toBeNull();
  });

  test("shows the dev-login form when SSO is disabled in development", async () => {
    stubConfigPublic({ enabled: false, providerName: "" });
    render(<Login devLoginAvailable />);

    // No SSO card; the passwordless dev form is shown.
    expect(await screen.findByTestId("login-form")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("sso-card")).toBeNull());
    expect(screen.getByTestId("login-platform-message").textContent).toBe(
      "欢迎使用 Kuintessence 算力网络平台",
    );
  });

  test("reports disabled SSO without exposing dev controls in production", async () => {
    stubConfigPublic({ enabled: false, providerName: "" });
    render(<Login devLoginAvailable={false} />);

    expect(await screen.findByTestId("sso-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("dev-login-toggle")).toBeNull();
    expect(screen.queryByTestId("login-form")).toBeNull();
  });

  test("retries a failed SSO config request in production", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: true,
            providerName: "科研统一身份认证",
            welcomeMessage: { zh: "欢迎访问科研算力平台", en: "Welcome" },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<Login devLoginAvailable={false} />);

    expect(await screen.findByTestId("sso-config-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByTestId("sso-login-button")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
