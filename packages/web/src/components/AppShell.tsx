import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronRight,
  GitBranch,
  ListTodo,
  LogIn,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Settings as SettingsIcon,
  Sun,
  User,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import defaultLogoUrl from "../assets/logo.svg";
import { refreshAuthSession } from "../lib/api-client";
import {
  clearAuth,
  clearServerAuthSession,
  getAuthState,
  setAuth,
  subscribeAuthState,
} from "../lib/auth";
import { takePostLoginRedirect } from "../lib/auth-redirect";
import { isLocalMode, useLocalCapabilities } from "../lib/local-mode";
import { applyPlatformBrandingDocument, usePlatformBranding } from "../lib/platform-branding";
import { toCapabilitySet, useMeCapabilities } from "../lib/platform-capabilities";
import { resolveSoftwareSection, softwareCatalogDestination } from "../lib/software-navigation";
import { useMediaQuery } from "../lib/use-media-query";
import { cn } from "../lib/utils";

const toasterOptions = { classNames: { toast: "kq-motion--toast font-sans" } };

import { canCreateWorkflow } from "../lib/workflow-access";
import { CapabilityLoadingOverlay } from "./CapabilityLoadingOverlay";
import { useTheme } from "./ThemeProvider";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import {
  canUseWorkspaceIdentity,
  getWorkspaceIdentity,
  inferWorkspaceIdentity,
  isWorkspaceNavItemActive,
  WORKSPACE_IDENTITIES,
  type WorkspaceDomainId,
  type WorkspaceIdentity,
  type WorkspaceRoute,
} from "./workspace-navigation";

const SIDEBAR_KEY = "kq.sidebar-expanded";

interface ParentDestination {
  to: WorkspaceRoute;
  hash?: string;
}

function getParentDestination(pathname: string): ParentDestination | null {
  if (pathname === "/") return null;
  if (pathname.startsWith("/software/")) {
    const section = resolveSoftwareSection(pathname, "");
    if (section) return softwareCatalogDestination(section);
  }
  if (pathname.startsWith("/cp/") && pathname !== "/cp/") return { to: "/cp" };
  if (pathname.startsWith("/workflows/") && pathname !== "/workflows/new") {
    return { to: "/workflows" };
  }
  if (pathname.startsWith("/jobs/")) return { to: "/jobs" };
  return { to: "/" };
}

function readStoredExpanded(): boolean {
  if (typeof window === "undefined") return true;
  const v = window.localStorage.getItem(SIDEBAR_KEY);
  if (v === "true") return true;
  if (v === "false") return false;
  return window.matchMedia("(min-width: 768px)").matches;
}

function persistExpanded(next: boolean) {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, next ? "true" : "false");
  } catch {
    // localStorage unavailable — ignore
  }
}

/**
 * Picks up OIDC callback metadata once on mount, persists display/session
 * state via setAuth, then strips auth params from the URL.
 *
 * Runs synchronously inside the first render via a module-level guard so
 * other hooks (e.g. `getAuthState()` in the same component) see the
 * persisted session immediately.
 */
let oidcLandingHandled = false;
function consumeOidcLanding(): void {
  if (oidcLandingHandled) return;
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const cookieSession = params.get("session") === "cookie";
  if (!token && !cookieSession) return;
  oidcLandingHandled = true;
  const expiresIn = Number.parseInt(params.get("expiresIn") ?? "0", 10) || undefined;
  const email = params.get("email") ?? "";
  const role = cookieSession ? undefined : (params.get("role") ?? undefined);
  setAuth({ token: cookieSession ? null : (token ?? undefined), email, expiresIn, role });
  // Strip the auth params from the URL — preserve other params + hash.
  for (const k of ["token", "session", "expiresIn", "email", "role"]) params.delete(k);
  const next = params.toString();
  const cleanedUrl = `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`;
  const redirect = takePostLoginRedirect();
  if (redirect && redirect !== cleanedUrl) {
    window.location.replace(redirect);
    return;
  }
  window.history.replaceState({}, "", cleanedUrl);
}

export function AppShell() {
  consumeOidcLanding();
  const [, setAuthRevision] = useState(0);
  const [expanded, setExpanded] = useState<boolean>(() => readStoredExpanded());
  const collapseSidebarOnNavigate = useMediaQuery("(max-width: 767px)");
  const auth = getAuthState();
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const { theme, setTheme, resolved } = useTheme();
  const location = useRouterState({
    select: (state) => ({ pathname: state.location.pathname, hash: state.location.hash }),
  });
  const matchPath = location.pathname;
  const matchHash = location.hash ?? "";
  const parentDestination = getParentDestination(matchPath);
  const local = isLocalMode();
  const capabilities = useLocalCapabilities();
  const branding = usePlatformBranding(auth.isAuthenticated && !local && matchPath !== "/login");
  const brandingLanguage = i18n?.resolvedLanguage ?? i18n?.language ?? "zh";
  const capabilityState = useMeCapabilities(
    auth.isAuthenticated && !local && matchPath !== "/login",
  );
  const serverCapabilities = toCapabilitySet(capabilityState.data);
  const availableIdentities = WORKSPACE_IDENTITIES.filter((identity) =>
    canUseWorkspaceIdentity(identity, auth.role, local, capabilities, serverCapabilities),
  );
  const routeIdentityId = inferWorkspaceIdentity(matchPath, matchHash);
  const activeIdentity =
    availableIdentities.find((identity) => identity.id === routeIdentityId) ??
    availableIdentities[0] ??
    getWorkspaceIdentity("consumer");

  useEffect(() => {
    persistExpanded(expanded);
  }, [expanded]);

  useEffect(() => {
    applyPlatformBrandingDocument(branding, brandingLanguage, defaultLogoUrl);
  }, [branding, brandingLanguage]);

  useEffect(() => {
    const refreshAuthState = () => setAuthRevision((value) => value + 1);
    return subscribeAuthState(refreshAuthState);
  }, []);

  useEffect(() => {
    if (!auth.isAuthenticated) return;
    let cancelled = false;
    const refreshAheadMs = 60_000;
    const delay = auth.role
      ? Math.max(1_000, (auth.expiresAt ?? Date.now() + 300_000) - Date.now() - refreshAheadMs)
      : 0;
    const timer = window.setTimeout(
      () => {
        refreshAuthSession().then((refreshed) => {
          if (cancelled) return;
          if (refreshed) {
            setAuthRevision((value) => value + 1);
            return;
          }
          if (auth.expiresAt !== null && auth.expiresAt <= Date.now()) {
            clearAuth();
            navigate({ to: "/login" });
          }
        });
      },
      Math.min(delay, 2_147_000_000),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [auth.expiresAt, auth.isAuthenticated, auth.role, navigate]);

  if (matchPath === "/login") {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Outlet />
        <Toaster theme={resolved} richColors closeButton toastOptions={toasterOptions} />
      </div>
    );
  }

  const selectIdentity = (identity: WorkspaceIdentity) => {
    setExpanded(true);
    navigate(identity.entry);
  };

  const selectDomain = (domain: WorkspaceDomainId) => {
    const target = availableIdentities.find((identity) => identity.domain === domain);
    if (target) selectIdentity(target);
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-foreground">
      <WorkspaceSidebar
        expanded={expanded}
        identity={activeIdentity}
        branding={branding}
        identities={availableIdentities}
        role={auth.role}
        local={local}
        capabilities={capabilities}
        serverCapabilities={serverCapabilities}
        collapseOnNavigate={collapseSidebarOnNavigate}
        isNavItemActive={(item) => isWorkspaceNavItemActive(item, matchPath, matchHash)}
        onNavigate={() => setExpanded(false)}
        onSelectDomain={selectDomain}
        onToggle={() => setExpanded((value) => !value)}
      />
      <MobileBackdrop expanded={expanded} onClose={() => setExpanded(false)} />

      <div
        className={cn(
          "flex min-h-screen flex-col transition-[padding] duration-200",
          expanded ? "md:pl-64 xl:pl-72" : "md:pl-16",
        )}
      >
        <Topbar
          canCreateWorkflow={canCreateWorkflow(local, serverCapabilities)}
          canGoBack={parentDestination !== null}
          sidebarExpanded={expanded}
          onBack={() => {
            if (parentDestination) navigate(parentDestination);
          }}
          onOpenSidebar={() => setExpanded(true)}
          theme={theme}
          onThemeChange={setTheme}
          resolved={resolved}
          auth={auth}
          onOpenPersonal={() => selectIdentity(getWorkspaceIdentity("personal"))}
          onLogout={async () => {
            clearAuth();
            await clearServerAuthSession();
            navigate({ to: "/login" });
          }}
        />
        <main className="flex-1 px-4 py-5 sm:px-6 md:px-8 md:py-6">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>

      <Toaster theme={resolved} richColors closeButton toastOptions={toasterOptions} />
      {!local ? (
        <CapabilityLoadingOverlay
          state={capabilityState}
          branding={branding}
          onRetry={capabilityState.retry}
        />
      ) : null}
    </div>
  );
}

function MobileBackdrop({ expanded, onClose }: { expanded: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  if (!expanded) return null;
  return (
    <button
      type="button"
      aria-label={t("topbar.closeSidebar")}
      data-testid="sidebar-backdrop"
      className="fixed inset-0 z-30 bg-black/40 md:hidden"
      onClick={onClose}
    />
  );
}

interface TopbarProps {
  canCreateWorkflow: boolean;
  canGoBack: boolean;
  sidebarExpanded: boolean;
  onBack: () => void;
  onOpenSidebar: () => void;
  theme: "light" | "dark" | "system";
  onThemeChange: (next: "light" | "dark" | "system") => void;
  resolved: "light" | "dark";
  auth: ReturnType<typeof getAuthState>;
  onOpenPersonal: () => void;
  onLogout: () => void;
}

function Topbar({
  canCreateWorkflow,
  canGoBack,
  sidebarExpanded,
  onBack,
  onOpenSidebar,
  theme,
  onThemeChange,
  resolved,
  auth,
  onOpenPersonal,
  onLogout,
}: TopbarProps) {
  const { t } = useTranslation();
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:px-8">
      <Button
        variant="ghost"
        size="icon"
        data-testid="navigate-parent"
        aria-label={t("topbar.backToParent")}
        title={t("topbar.backToParent")}
        disabled={!canGoBack}
        onClick={onBack}
      >
        <ArrowLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        data-testid="mobile-sidebar-open"
        aria-label={t("topbar.expandSidebar")}
        aria-expanded={sidebarExpanded}
        onClick={onOpenSidebar}
      >
        <Menu />
      </Button>

      <div className="ml-auto flex items-center gap-2">
        {canCreateWorkflow ? <SubmitMenu /> : null}
        <ThemeMenu theme={theme} onThemeChange={onThemeChange} resolved={resolved} />
        <UserMenu auth={auth} onOpenPersonal={onOpenPersonal} onLogout={onLogout} />
      </div>
    </header>
  );
}

function SubmitMenu() {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" data-testid="submit-menu" className="px-3 sm:px-4">
          <Plus />
          <span className="hidden sm:inline">{t("topbar.submit")}</span>
          <ChevronRight className="hidden h-3 w-3 -rotate-90 opacity-70 sm:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("topbar.new")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/jobs">
            <ListTodo />
            <span>{t("topbar.job")}</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/workflows/new">
            <GitBranch />
            <span>{t("topbar.workflow")}</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ThemeMenuProps {
  theme: "light" | "dark" | "system";
  onThemeChange: (next: "light" | "dark" | "system") => void;
  resolved: "light" | "dark";
}

function ThemeMenu({ theme, onThemeChange, resolved }: ThemeMenuProps) {
  const { t } = useTranslation();
  const Icon = resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" data-testid="theme-menu" aria-label={t("topbar.theme")}>
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("topbar.theme")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeItem current={theme} value="light" onSelect={onThemeChange}>
          <Sun /> <span>{t("topbar.themeLight")}</span>
        </ThemeItem>
        <ThemeItem current={theme} value="dark" onSelect={onThemeChange}>
          <Moon /> <span>{t("topbar.themeDark")}</span>
        </ThemeItem>
        <ThemeItem current={theme} value="system" onSelect={onThemeChange}>
          <Monitor /> <span>{t("topbar.themeSystem")}</span>
        </ThemeItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeItem({
  current,
  value,
  onSelect,
  children,
}: {
  current: string;
  value: "light" | "dark" | "system";
  onSelect: (next: "light" | "dark" | "system") => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem
      data-testid={`theme-${value}`}
      onSelect={() => onSelect(value)}
      className={current === value ? "bg-muted/60" : undefined}
    >
      {children}
    </DropdownMenuItem>
  );
}

interface UserMenuProps {
  auth: ReturnType<typeof getAuthState>;
  onOpenPersonal: () => void;
  onLogout: () => void;
}

function UserMenu({ auth, onOpenPersonal, onLogout }: UserMenuProps) {
  const { t } = useTranslation();
  if (!auth.isAuthenticated) {
    return (
      <Button asChild variant="outline" size="sm" data-testid="login-link">
        <Link to="/login">
          <LogIn />
          {t("common.login")}
        </Link>
      </Button>
    );
  }
  const username = auth.email?.split("@", 1)[0]?.trim() || "User";
  const initials = username.slice(0, 2).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" data-testid="user-menu" className="gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold">
            {initials}
          </span>
          <span className="hidden text-xs lg:inline">{username}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex items-start gap-2">
          <User className="h-3.5 w-3.5" />
          <span className="grid gap-0.5">
            <span>{username}</span>
            <span className="font-normal text-[11px] text-muted-foreground">{auth.email}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenPersonal} data-testid="user-settings">
          <SettingsIcon /> <span>{t("workspace.domain.personal")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogout} data-testid="logout">
          <LogOut /> <span>{t("common.signOut")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
