import type { PlatformCapability } from "@kuintessence/shared/browser";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  BadgeDollarSign,
  ExternalLink,
  Loader2,
  LogOut,
  Monitor,
  Moon,
  Network,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import {
  clearAuth,
  clearServerAuthSession,
  getAuthState,
  setAuth,
  subscribeAuthState,
} from "../../lib/auth";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { type ThemePreference, useTheme } from "../ThemeProvider";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { PageHeader, PageShell } from "../ui/page";
import { AgentCertsPanel } from "./AgentCertsPanel";
import { AuthzAdminPanel } from "./AuthzAdminPanel";
import { ClusterFileRootsPanel } from "./ClusterFileRootsPanel";
import { CostRatesForm } from "./CostRatesForm";
import { DesensitizeAdminPanel } from "./DesensitizeAdminPanel";
import {
  canAccessOperation,
  canAccessOperationsLink,
  OPERATIONS_AREAS,
  OPERATIONS_LINKS,
  type OperationsArea,
  type OperationsLink,
  operationsHrefForRole,
} from "./operations-capabilities";
import { PlatformBrandingForm } from "./PlatformBrandingForm";
import { SandboxAccountMappingsPanel } from "./SandboxAccountMappingsPanel";
import { SandboxSecurityPanel } from "./SandboxSecurityPanel";
import { SSOConfigForm } from "./SSOConfigForm";
import { SshActiveSessions } from "./SshActiveSessions";
import { SshCredentialsForm } from "./SshCredentialsForm";
import { SshRecordingPlayer } from "./SshRecordingPlayer";

const ROLES = ["user", "org_admin", "operator", "platform_admin", "super_admin"] as const;

function fmtDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function ThemeRow() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const items: Array<{ value: ThemePreference; labelKey: string; icon: typeof Sun }> = [
    { value: "light", labelKey: "settings.themeLight", icon: Sun },
    { value: "dark", labelKey: "settings.themeDark", icon: Moon },
    { value: "system", labelKey: "settings.themeSystem", icon: Monitor },
  ];
  return (
    <div className="flex flex-wrap gap-2" data-testid="settings-theme">
      {items.map(({ value, labelKey, icon: Icon }) => (
        <button
          key={value}
          type="button"
          data-testid={`settings-theme-${value}`}
          onClick={() => setTheme(value)}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs",
            theme === value
              ? "border-brand bg-brand-soft"
              : "border-border text-muted-foreground hover:bg-muted/60",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}

interface RoleRowProps {
  email: string | null;
  role: string | null;
}

function RoleRow({ email, role }: RoleRowProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  // Role switching uses the Server's development-only login endpoint.
  if (!email) return null;
  return (
    <div className="space-y-1.5" data-testid="settings-role">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {t("settings.roleDev")}
      </div>
      <div className="flex flex-wrap gap-2">
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            data-testid={`settings-role-${r}`}
            disabled={busy !== null}
            onClick={async () => {
              setBusy(r);
              try {
                const res = await api.post<{ token: string; expiresIn: number }>("/auth/login", {
                  email,
                  role: r,
                });
                setAuth({ token: res.token, email, expiresIn: res.expiresIn, role: r });
                toast.success(t("settings.roleSwitched", { role: r }));
              } catch (err) {
                toast.error(toUserFacingError(err, t("settings.roleSwitchFailed")));
              } finally {
                setBusy(null);
              }
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs",
              role === r
                ? "border-brand bg-brand-soft"
                : "border-border text-muted-foreground hover:bg-muted/60",
            )}
          >
            {busy === r ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {r}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{t("settings.roleNote")}</p>
    </div>
  );
}

interface ExpiryRowProps {
  expiresAt: number | null;
}

function ExpiryRow({ expiresAt }: ExpiryRowProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  if (expiresAt == null) {
    return (
      <div className="text-xs text-muted-foreground" data-testid="settings-expiry-unknown">
        {t("settings.tokenExpiryUnknown")}
      </div>
    );
  }

  const remaining = expiresAt - now;
  return (
    <div
      data-testid="settings-expiry"
      className="flex items-baseline gap-2 text-xs text-muted-foreground"
    >
      <span>{t("settings.tokenExpiresIn")}</span>
      <span className="font-mono tabular-nums" data-testid="settings-expiry-value">
        {fmtDuration(remaining)}
      </span>
    </div>
  );
}

interface OperationsSummaryProps {
  role: string | null;
  capabilities?: ReadonlySet<PlatformCapability>;
}

export function OperationsSummary({ role, capabilities }: OperationsSummaryProps) {
  const { t } = useTranslation();
  const visibleCount = OPERATIONS_LINKS.filter((item) =>
    canAccessOperationsLink(role, item, capabilities),
  ).length;
  const totalCount = OPERATIONS_LINKS.length;
  const platformEnabled = canAccessOperation(role, "platform_admin");
  const cpEnabled = canAccessOperation(role, "org_admin");
  const superEnabled = canAccessOperation(role, "super_admin");
  const summary = [
    {
      key: "coverage",
      value: `${visibleCount}/${totalCount}`,
      label: t("settings.operations.summary.coverage"),
      icon: Activity,
    },
    {
      key: "platform",
      value: platformEnabled
        ? t("settings.operations.summary.enabled")
        : t("settings.operations.summary.locked"),
      label: t("settings.operations.summary.platformOps"),
      icon: ShieldCheck,
    },
    {
      key: "provider",
      value: cpEnabled
        ? t("settings.operations.summary.enabled")
        : t("settings.operations.summary.locked"),
      label: t("settings.operations.summary.providerOps"),
      icon: Network,
    },
    {
      key: "cost",
      value: superEnabled
        ? t("settings.operations.summary.enabled")
        : t("settings.operations.summary.locked"),
      label: t("settings.operations.summary.costOps"),
      icon: BadgeDollarSign,
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="settings-ops-summary">
      {summary.map(({ key, value, label, icon: Icon }) => (
        <Card key={key}>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="text-xl font-semibold tabular-nums">{value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{label}</div>
            </div>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/35">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

interface OperationsMapProps {
  role: string | null;
  areas?: ReadonlyArray<OperationsArea>;
  capabilities?: ReadonlySet<PlatformCapability>;
}

export function OperationsMap({
  role,
  areas = OPERATIONS_AREAS,
  capabilities,
}: OperationsMapProps) {
  const { t } = useTranslation();
  const focused = areas.length === 1;
  return (
    <Card data-testid="settings-operations-map">
      <CardHeader>
        <CardTitle>{t("settings.operations.title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("settings.operations.subtitle")}</p>
      </CardHeader>
      <CardContent className={cn("grid gap-4", !focused && "xl:grid-cols-4")}>
        {areas.map((area) => (
          <div
            key={area}
            id={area}
            data-testid={`operations-area-${area}`}
            className="scroll-mt-4 space-y-2"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(`settings.operations.area.${area}`)}
            </div>
            <div className={cn("grid gap-2", focused && "md:grid-cols-2 xl:grid-cols-3")}>
              {OPERATIONS_LINKS.filter((item) => item.area === area).map((item) => (
                <OperationLink key={item.key} item={item} role={role} capabilities={capabilities} />
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface OperationLinkProps {
  item: OperationsLink;
  role: string | null;
  capabilities?: ReadonlySet<PlatformCapability>;
}

function OperationLink({ item, role, capabilities }: OperationLinkProps) {
  const { t } = useTranslation();
  const allowed = canAccessOperationsLink(role, item, capabilities);
  const Icon = item.icon;
  const content = (
    <>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {t(`settings.operations.link.${item.key}.title`)}
        </div>
        <div className="line-clamp-2 text-xs text-muted-foreground">
          {t(`settings.operations.link.${item.key}.description`)}
        </div>
      </div>
      <Badge variant={allowed ? "brand" : "outline"} className="shrink-0">
        {allowed
          ? t("settings.operations.available")
          : t("settings.operations.requiresRole", { role: item.requiredRole })}
      </Badge>
      {allowed ? <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
    </>
  );

  if (!allowed) {
    return (
      <div className="flex min-h-20 items-center gap-3 rounded-md border border-dashed p-3 opacity-70">
        {content}
      </div>
    );
  }

  return (
    <a
      href={operationsHrefForRole(role, item, capabilities)}
      target="_blank"
      rel="noreferrer"
      className="flex min-h-20 items-center gap-3 rounded-md border p-3 transition-colors hover:bg-muted/55"
      data-testid={`settings-ops-link-${item.key}`}
    >
      {content}
    </a>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const [, setAuthRevision] = useState(0);
  const auth = getAuthState();
  const canManagePlatform = auth.role === "platform_admin" || auth.role === "super_admin";
  const canManageCost = auth.role === "super_admin";
  const navigate = useNavigate();
  const locationHash = useRouterState({ select: (state) => state.location.hash ?? "" }).replace(
    /^#/,
    "",
  );
  const [requestedTab, requestedSection] = locationHash.split("/");
  const requestedPlatformTab =
    requestedTab === "security" || requestedTab === "infrastructure" ? requestedTab : null;
  const requestedPlatformSection =
    requestedPlatformTab && requestedSection ? requestedSection : null;
  const activeTab = canManagePlatform && requestedPlatformTab ? requestedPlatformTab : "personal";
  const personalSection =
    requestedSection === "execution-accounts" || requestedSection === "appearance"
      ? requestedSection
      : "account";
  const pageTitle =
    activeTab === "personal"
      ? t(`settings.personalSections.${personalSection}.title`)
      : t(`settings.tabs.${activeTab}`);
  const pageSubtitle =
    activeTab === "personal"
      ? t(`settings.personalSections.${personalSection}.description`)
      : t(`settings.sectionSubtitle.${activeTab}`);

  useEffect(() => subscribeAuthState(() => setAuthRevision((value) => value + 1)), []);

  useEffect(() => {
    if (!requestedSection || activeTab !== requestedPlatformTab) return;
    window.requestAnimationFrame(() => {
      document.getElementById(requestedSection)?.scrollIntoView({ block: "start" });
    });
  }, [activeTab, requestedPlatformTab, requestedSection]);
  return (
    <PageShell data-testid="settings-page">
      {requestedPlatformSection && !canManagePlatform ? (
        <div data-testid="settings-restricted-deep-link" className="space-y-4">
          <PageHeader
            title={t("settings.restrictedDeepLink.title")}
            subtitle={t("settings.restrictedDeepLink.description")}
          />
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <p className="text-sm text-muted-foreground">
                {t("settings.restrictedDeepLink.guidance")}
              </p>
              <Button type="button" variant="outline" onClick={() => navigate({ to: "/settings" })}>
                {t("settings.restrictedDeepLink.returnToAccessible")}
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : (
        <>
          <PageHeader title={pageTitle} subtitle={pageSubtitle} />

          {activeTab === "personal" ? (
            <div className="space-y-4">
              {personalSection === "account" ? (
                <Card>
                  <CardHeader>
                    <CardTitle>{t("settings.account")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
                      <span className="text-muted-foreground">{t("settings.signedInAs")}</span>
                      <span className="font-mono">{auth.email ?? "—"}</span>
                      <span className="text-muted-foreground">{t("settings.role")}</span>
                      <span className="font-mono">{auth.role ?? "user"}</span>
                    </div>
                    <ExpiryRow expiresAt={auth.expiresAt} />
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="settings-logout"
                      onClick={async () => {
                        clearAuth();
                        await clearServerAuthSession();
                        navigate({ to: "/login" });
                      }}
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      {t("common.signOut")}
                    </Button>
                  </CardContent>
                </Card>
              ) : null}

              {personalSection === "execution-accounts" ? <SandboxAccountMappingsPanel /> : null}

              {personalSection === "appearance" ? (
                <Card>
                  <CardHeader>
                    <CardTitle>{t("settings.appearance")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <ThemeRow />
                    <p className="text-[11px] text-muted-foreground">
                      {t("settings.themePersistedNote")}
                    </p>
                  </CardContent>
                </Card>
              ) : null}

              {personalSection === "account" && import.meta.env.DEV ? (
                <Card data-testid="settings-developer-card">
                  <CardHeader>
                    <CardTitle>{t("settings.developer")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <RoleRow email={auth.email} role={auth.role} />
                    <div className="text-xs text-muted-foreground">
                      {t("settings.serverUrl")}:{" "}
                      <code>{import.meta.env.VITE_SERVER_URL ?? window.location.origin}</code>
                    </div>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          ) : null}

          {activeTab === "security" ? (
            <div className="space-y-4">
              {canManagePlatform ? (
                <section id="branding" className="scroll-mt-4">
                  <PlatformBrandingForm />
                </section>
              ) : null}
              {canManagePlatform ? (
                <section id="sandbox-security" className="scroll-mt-4">
                  <SandboxSecurityPanel />
                </section>
              ) : null}
              {canManagePlatform ? (
                <section id="authz" className="scroll-mt-4">
                  <AuthzAdminPanel showBreakGlass={auth.role === "super_admin"} />
                </section>
              ) : null}
              {canManagePlatform ? (
                <section id="sso" className="scroll-mt-4">
                  <SSOConfigForm />
                </section>
              ) : null}
              {canManagePlatform ? (
                <section id="desensitize" className="scroll-mt-4">
                  <DesensitizeAdminPanel />
                </section>
              ) : null}
              {canManagePlatform ? (
                <section id="ssh-vault" className="scroll-mt-4">
                  <SshCredentialsForm />
                </section>
              ) : null}
              {canManagePlatform ? (
                <section id="agent-certs" className="scroll-mt-4">
                  <AgentCertsPanel />
                </section>
              ) : null}
              {canManagePlatform ? (
                <section id="ssh-sessions" className="scroll-mt-4">
                  <SshActiveSessions />
                </section>
              ) : null}
              {canManagePlatform ? (
                <section id="ssh-recordings" className="scroll-mt-4">
                  <SshRecordingPlayer />
                </section>
              ) : null}
            </div>
          ) : null}

          {activeTab === "infrastructure" ? (
            <div className="space-y-4">
              {canAccessOperation(auth.role, "org_admin") ? (
                <section id="cluster-file-roots" className="scroll-mt-4">
                  <ClusterFileRootsPanel />
                </section>
              ) : null}
              {canManageCost ? (
                <section id="cost-rates" className="scroll-mt-4">
                  <CostRatesForm />
                </section>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </PageShell>
  );
}
