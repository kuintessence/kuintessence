import type { PlatformBranding } from "@kuintessence/shared/browser";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ChevronDown, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import defaultLogoUrl from "../assets/logo.svg";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardFooter } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { api } from "../lib/api-client";
import { getAuthState, setAuth } from "../lib/auth";
import { readLoginRedirect, savePostLoginRedirect } from "../lib/auth-redirect";
import {
  applyPlatformBrandingDocument,
  normalizePlatformBranding,
  resolveBrandingForLanguage,
  resolveImageSource,
} from "../lib/platform-branding";
import { platformApiUrl } from "../lib/platform-paths";
import { toUserFacingError } from "../lib/user-facing-error";

interface SsoPublicConfig {
  enabled: boolean;
  providerName: string;
  welcomeMessage?: {
    zh: string;
    en: string;
  };
  branding?: PlatformBranding;
}

type SsoState =
  | { status: "loading" }
  | { status: "enabled"; config: SsoPublicConfig }
  | { status: "disabled"; config: SsoPublicConfig }
  | { status: "error" };

interface LoginProps {
  devLoginAvailable?: boolean;
}

const DEV_LOGIN_ROLES = ["user", "org_admin", "operator", "platform_admin", "super_admin"] as const;
type DevLoginRole = (typeof DEV_LOGIN_ROLES)[number];

export function shouldExposeDevLogin(devMode: boolean, previewMode = false): boolean {
  return devMode || previewMode;
}

export function Login({
  devLoginAvailable = shouldExposeDevLogin(
    import.meta.env.DEV,
    import.meta.env.VITE_PREVIEW_LOGIN === "true",
  ),
}: LoginProps = {}) {
  const { i18n, t } = useTranslation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<DevLoginRole>("platform_admin");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ssoState, setSsoState] = useState<SsoState>({ status: "loading" });
  const [showDevLogin, setShowDevLogin] = useState(devLoginAvailable);
  const redirect = readLoginRedirect();

  const loadSsoConfig = useCallback(async () => {
    setSsoState({ status: "loading" });
    try {
      const config = await api.get<SsoPublicConfig>("/auth/oidc/config-public");
      setSsoState({ status: config.enabled ? "enabled" : "disabled", config });
      if (config.enabled) {
        setShowDevLogin(false);
      }
    } catch {
      setSsoState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    if (getAuthState().isAuthenticated) {
      window.location.replace(redirect);
    }
  }, [redirect]);

  useEffect(() => {
    void loadSsoConfig();
  }, [loadSsoConfig]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post<{ token: string; expiresIn: number }>("/auth/login", {
        email,
        role,
      });
      setAuth({ token: res.token, email, expiresIn: res.expiresIn, role });
      if (redirect === "/") {
        navigate({ to: "/" });
      } else {
        window.location.assign(redirect);
      }
    } catch (err) {
      setError(toUserFacingError(err, t("login.failed")));
    } finally {
      setLoading(false);
    }
  }

  function onSsoClick() {
    // Full-page navigation keeps login and callback cookies in one browser context.
    savePostLoginRedirect(redirect);
    window.location.assign(platformApiUrl("/auth/oidc/login"));
  }

  const language = i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en";
  const sso =
    ssoState.status === "enabled" || ssoState.status === "disabled" ? ssoState.config : null;
  const branding = normalizePlatformBranding(sso?.branding);
  const localizedBranding = resolveBrandingForLanguage(branding, language);
  const providerName = sso?.providerName.trim() || t("login.ssoProvider");
  const configuredWelcome = branding.locales[language].welcome.trim();
  const platformMessage =
    configuredWelcome || sso?.welcomeMessage?.[language].trim() || localizedBranding.welcome;
  const loginLogo = resolveImageSource(localizedBranding.logoUrl, defaultLogoUrl);

  useEffect(() => {
    applyPlatformBrandingDocument(branding, language, defaultLogoUrl);
  }, [branding, language]);

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background px-4 py-12"
      data-testid="login-page"
    >
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <img src={loginLogo} alt={localizedBranding.name} className="h-9 w-9 text-brand" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {localizedBranding.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{localizedBranding.subtitle}</p>
          </div>
        </div>

        {ssoState.status === "enabled" ? (
          <Card data-testid="sso-card">
            <CardContent className="p-6 space-y-3">
              <Button
                type="button"
                onClick={onSsoClick}
                className="w-full"
                data-testid="sso-login-button"
              >
                <ShieldCheck />
                {t("login.signInWithSso", { provider: providerName })}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">{t("login.ssoNote")}</p>
            </CardContent>
          </Card>
        ) : null}

        {!devLoginAvailable && ssoState.status === "loading" ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("login.ssoLoading")}
          </div>
        ) : null}

        {!devLoginAvailable && ssoState.status === "disabled" ? (
          <div
            role="alert"
            data-testid="sso-unavailable"
            className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-[color-mix(in_oklab,var(--status-warning)_10%,transparent)] px-3 py-2 text-sm text-foreground"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
            <span>{t("login.ssoUnavailable")}</span>
          </div>
        ) : null}

        {!devLoginAvailable && ssoState.status === "error" ? (
          <div
            role="alert"
            data-testid="sso-config-error"
            className="space-y-3 rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] px-3 py-3 text-sm text-foreground"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-failed" />
              <span>{t("login.ssoConfigFailed")}</span>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadSsoConfig()}>
              {t("login.retry")}
            </Button>
          </div>
        ) : null}

        {devLoginAvailable && ssoState.status === "enabled" && !showDevLogin ? (
          <button
            type="button"
            data-testid="dev-login-toggle"
            onClick={() => setShowDevLogin(true)}
            className="flex w-full items-center justify-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
            {t("login.showDevLogin")}
          </button>
        ) : null}

        {devLoginAvailable && showDevLogin ? (
          <Card>
            <CardContent className="p-6">
              <form onSubmit={onSubmit} className="space-y-4" data-testid="login-form">
                <div className="space-y-1.5">
                  <label
                    htmlFor="login-email"
                    className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {t("login.emailLabel")}
                  </label>
                  <Input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("login.emailPlaceholder")}
                    autoComplete="email"
                    autoFocus
                    data-testid="login-email"
                    disabled={loading}
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="login-role"
                    className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {t("login.roleLabel", { defaultValue: "Role" })}
                  </label>
                  <select
                    id="login-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as DevLoginRole)}
                    disabled={loading}
                    data-testid="login-role"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {DEV_LOGIN_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                {error ? (
                  <div
                    role="alert"
                    data-testid="login-error"
                    className="flex items-start gap-2 rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] px-3 py-2 text-sm text-status-failed"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                ) : null}

                <Button
                  type="submit"
                  disabled={loading || email.length === 0}
                  className="w-full"
                  data-testid="login-submit"
                >
                  {loading ? (
                    <>
                      <Loader2 className="animate-spin" /> {t("login.signingIn")}
                    </>
                  ) : (
                    <>
                      <LogIn /> {t("login.signIn")}
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
            <CardFooter className="border-t border-border px-6 py-3">
              <p className="text-[11px] text-muted-foreground">{t("login.devModeNote")}</p>
            </CardFooter>
          </Card>
        ) : null}

        <p
          className="text-center text-xs leading-5 text-muted-foreground"
          data-testid="login-platform-message"
        >
          {platformMessage}
        </p>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/login")({ component: Login });
