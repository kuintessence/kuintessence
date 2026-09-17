/**
 * SSOConfigForm component tests.
 *
 * Covers:
 *   - initial GET → form fields populate
 *   - "(unchanged)" placeholder appears when an existing secret is stored
 *   - Test connection button POSTs to /admin/sso/test and shows banner
 *   - Save button PUTs the formToWire payload (omits clientSecret when blank)
 *   - error path on save toasts
 *   - load failure shows error card and exposes no write actions
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

import { SSOConfigForm } from "./SSOConfigForm";

const REDACTED = "__redacted__";

interface SsoView {
  enabled: boolean;
  providerType: "oidc" | "saml" | "ldap";
  providerDisplayName?: string;
  loginWelcomeZh?: string;
  loginWelcomeEn?: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: typeof REDACTED | "";
  redirectUri: string;
  groupMapping: Record<string, string>;
  autoCreateUsers: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

function makeFetchMock(handlers: Array<(input: Request | string) => Response | Promise<Response>>) {
  const queue = [...handlers];
  return vi.fn(async (...args: unknown[]) => {
    const [input] = args as [Request | string];
    const handler = queue.shift();
    if (!handler) throw new Error("Unexpected fetch call");
    return handler(typeof input === "string" ? input : input.url);
  });
}

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SSOConfigForm", () => {
  test("loads current config and populates the form", async () => {
    const view: SsoView = {
      enabled: true,
      providerType: "oidc",
      providerDisplayName: "Research SSO",
      loginWelcomeZh: "欢迎访问科研平台",
      loginWelcomeEn: "Welcome to the research platform",
      issuerUrl: "https://idp.example.com",
      clientId: "kq-prod",
      clientSecret: REDACTED,
      redirectUri: "https://kq.example.com/api/auth/oidc/callback",
      groupMapping: { admins: "platform_admin" },
      autoCreateUsers: true,
      updatedAt: null,
      updatedBy: "admin@x",
    };
    vi.stubGlobal(
      "fetch",
      makeFetchMock([() => new Response(JSON.stringify(view), { status: 200 })]),
    );

    render(<SSOConfigForm />);

    await waitFor(() => screen.getByTestId("sso-issuer-url"));

    const issuer = screen.getByTestId("sso-issuer-url") as HTMLInputElement;
    expect(issuer.value).toBe("https://idp.example.com");
    const clientId = screen.getByTestId("sso-client-id") as HTMLInputElement;
    expect(clientId.value).toBe("kq-prod");
    const enabled = screen.getByTestId("sso-enabled") as HTMLInputElement;
    expect(enabled.checked).toBe(true);
    expect((screen.getByTestId("sso-provider-display-name") as HTMLInputElement).value).toBe(
      "Research SSO",
    );
    expect((screen.getByTestId("sso-login-welcome-zh") as HTMLInputElement).value).toBe(
      "欢迎访问科研平台",
    );
    const auto = screen.getByTestId("sso-autocreate") as HTMLInputElement;
    expect(auto.checked).toBe(true);

    // The stored-secret indicator is visible.
    expect(screen.getByTestId("sso-secret-stored")).toBeDefined();

    // Group mapping row rendered for each entry.
    expect(screen.getByTestId("sso-group-key-0")).toBeDefined();
    const groupKey = screen.getByTestId("sso-group-key-0") as HTMLInputElement;
    expect(groupKey.value).toBe("admins");
  });

  test("shows '(unchanged)' placeholder when secret is stored", async () => {
    const view: SsoView = {
      enabled: false,
      providerType: "oidc",
      issuerUrl: "",
      clientId: "",
      clientSecret: REDACTED,
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedAt: null,
      updatedBy: null,
    };
    vi.stubGlobal(
      "fetch",
      makeFetchMock([() => new Response(JSON.stringify(view), { status: 200 })]),
    );

    render(<SSOConfigForm />);

    await waitFor(() => screen.getByTestId("sso-client-secret"));
    const secret = screen.getByTestId("sso-client-secret") as HTMLInputElement;
    expect(secret.placeholder).toContain("unchanged");
  });

  test("Test connection: success path renders banner with discovered endpoints", async () => {
    const view: SsoView = {
      enabled: true,
      providerType: "oidc",
      issuerUrl: "https://idp.example.com",
      clientId: "kq",
      clientSecret: "",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedAt: null,
      updatedBy: null,
    };
    const testResponse = {
      success: true,
      issuer: "https://idp.example.com",
      authorizationEndpoint: "https://idp.example.com/auth",
      tokenEndpoint: "https://idp.example.com/token",
      userinfoEndpoint: "https://idp.example.com/userinfo",
      jwksUri: "https://idp.example.com/jwks",
      error: null,
    };
    vi.stubGlobal(
      "fetch",
      makeFetchMock([
        () => new Response(JSON.stringify(view), { status: 200 }),
        () => new Response(JSON.stringify(testResponse), { status: 200 }),
      ]),
    );

    render(<SSOConfigForm />);
    await waitFor(() => screen.getByTestId("sso-test"));

    fireEvent.click(screen.getByTestId("sso-test"));
    await waitFor(() => screen.getByTestId("sso-test-result"));
    const banner = screen.getByTestId("sso-test-result");
    expect(banner.textContent).toContain("Discovery succeeded");
    expect(banner.textContent).toContain("https://idp.example.com/auth");
  });

  test("Test connection: failure path renders error banner", async () => {
    const view: SsoView = {
      enabled: false,
      providerType: "oidc",
      issuerUrl: "https://bad.example.com",
      clientId: "kq",
      clientSecret: "",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedAt: null,
      updatedBy: null,
    };
    vi.stubGlobal(
      "fetch",
      makeFetchMock([
        () => new Response(JSON.stringify(view), { status: 200 }),
        () =>
          new Response(
            JSON.stringify({
              success: false,
              issuer: null,
              authorizationEndpoint: null,
              tokenEndpoint: null,
              userinfoEndpoint: null,
              jwksUri: null,
              error: "ENOTFOUND bad.example.com",
            }),
            { status: 200 },
          ),
      ]),
    );

    render(<SSOConfigForm />);
    await waitFor(() => screen.getByTestId("sso-test"));
    fireEvent.click(screen.getByTestId("sso-test"));
    await waitFor(() => screen.getByTestId("sso-test-result"));
    const banner = screen.getByTestId("sso-test-result");
    expect(banner.textContent).toContain("连接测试失败");
    expect(banner.textContent).not.toContain("ENOTFOUND");
    expect(banner.textContent).not.toContain("bad.example.com");
  });

  test("Save: PUTs and toasts on success; omits clientSecret when blank", async () => {
    const view: SsoView = {
      enabled: false,
      providerType: "oidc",
      issuerUrl: "https://idp.example.com",
      clientId: "kq",
      clientSecret: REDACTED,
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedAt: null,
      updatedBy: null,
    };
    let capturedBody: unknown = null;
    let capturedMethod = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (init?.method === "PUT" || (typeof input !== "string" && input.method === "PUT")) {
          capturedMethod = "PUT";
          capturedBody = JSON.parse((init?.body as string) ?? "{}");
          return new Response(JSON.stringify({ ...view, enabled: true } satisfies SsoView), {
            status: 200,
          });
        }
        if (url.includes("/admin/sso/config")) {
          return new Response(JSON.stringify(view), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    );

    render(<SSOConfigForm />);
    await waitFor(() => screen.getByTestId("sso-enabled"));
    fireEvent.click(screen.getByTestId("sso-enabled"));
    fireEvent.change(screen.getByTestId("sso-provider-display-name"), {
      target: { value: "Platform Identity" },
    });
    fireEvent.change(screen.getByTestId("sso-login-welcome-zh"), {
      target: { value: "欢迎访问平台" },
    });
    fireEvent.change(screen.getByTestId("sso-login-welcome-en"), {
      target: { value: "Welcome to the platform" },
    });
    fireEvent.click(screen.getByTestId("sso-save"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(capturedMethod).toBe("PUT");
    expect(capturedBody).toMatchObject({
      enabled: true,
      providerDisplayName: "Platform Identity",
      loginWelcomeZh: "欢迎访问平台",
      loginWelcomeEn: "Welcome to the platform",
      issuerUrl: "https://idp.example.com",
      clientId: "kq",
    });
    // Critical: clientSecret is NOT in the body when input is empty.
    expect((capturedBody as Record<string, unknown>).clientSecret).toBeUndefined();
  });

  test("Save: error from server triggers toast.error", async () => {
    const view: SsoView = {
      enabled: false,
      providerType: "oidc",
      issuerUrl: "https://idp.example.com",
      clientId: "kq",
      clientSecret: "",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedAt: null,
      updatedBy: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | Request, init?: RequestInit) => {
        if (init?.method === "PUT") {
          return new Response(
            JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "boom" } }),
            { status: 400 },
          );
        }
        return new Response(JSON.stringify(view), { status: 200 });
      }),
    );

    render(<SSOConfigForm />);
    await waitFor(() => screen.getByTestId("sso-save"));
    fireEvent.click(screen.getByTestId("sso-save"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]?.[0]).toContain("保存 SSO 配置失败");
    expect(toastError.mock.calls[0]?.[0]).not.toContain("boom");
    expect(toastError.mock.calls[0]?.[0]).not.toContain("VALIDATION_ERROR");
  });

  test("Add and remove a group mapping row", async () => {
    const view: SsoView = {
      enabled: false,
      providerType: "oidc",
      issuerUrl: "",
      clientId: "",
      clientSecret: "",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedAt: null,
      updatedBy: null,
    };
    vi.stubGlobal(
      "fetch",
      makeFetchMock([() => new Response(JSON.stringify(view), { status: 200 })]),
    );

    render(<SSOConfigForm />);
    await waitFor(() => screen.getByTestId("sso-group-add"));
    fireEvent.click(screen.getByTestId("sso-group-add"));
    expect(screen.getByTestId("sso-group-key-0")).toBeDefined();
    fireEvent.click(screen.getByTestId("sso-group-remove-0"));
    expect(screen.queryByTestId("sso-group-key-0")).toBeNull();
  });

  test("Load failure renders error card", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock([
        () =>
          new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "nope" } }), {
            status: 403,
          }),
      ]),
    );

    render(<SSOConfigForm />);
    await waitFor(() => screen.getByTestId("sso-load-error"));
    expect(screen.getByTestId("sso-load-error").textContent).toMatch(
      /没有执行此操作的权限|does not have permission/,
    );
    expect(screen.getByTestId("sso-load-error").textContent).not.toContain("nope");
    expect(screen.getByTestId("sso-load-error").textContent).not.toContain("FORBIDDEN");
    expect(screen.queryByTestId("sso-save")).toBeNull();
    expect(screen.queryByTestId("sso-test")).toBeNull();
    expect(screen.queryByTestId("sso-group-add")).toBeNull();
  });
});
