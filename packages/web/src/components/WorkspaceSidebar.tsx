import {
  EMPTY_PLATFORM_BRANDING,
  type PlatformBranding,
  type PlatformCapability,
} from "@kuintessence/shared/browser";
import { Link } from "@tanstack/react-router";
import { ChevronDown, CircleHelp, ExternalLink, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import defaultLogoUrl from "../assets/logo.svg";
import type { LocalCapabilities } from "../lib/local-mode";
import { resolveBrandingForLanguage, resolveImageSource } from "../lib/platform-branding";
import { cn } from "../lib/utils";
import {
  canAccessOperationsLink,
  OPERATIONS_AREAS,
  OPERATIONS_LINKS,
  operationsHrefForRole,
} from "./settings/operations-capabilities";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  canUseWorkspaceNavItem,
  WORKSPACE_DOMAINS,
  type WorkspaceDomainId,
  type WorkspaceIdentity,
  type WorkspaceNavItem,
} from "./workspace-navigation";

const DEFAULT_DOCS_URL = "https://kuintessence.github.io/kuintessence/";

export function resolveDocsUrl(configuredUrl: string | undefined): string {
  return configuredUrl?.trim() || DEFAULT_DOCS_URL;
}

interface WorkspaceSidebarProps {
  expanded: boolean;
  identity: WorkspaceIdentity;
  branding?: PlatformBranding;
  identities: ReadonlyArray<WorkspaceIdentity>;
  role: string | null;
  local: boolean;
  capabilities: LocalCapabilities | null;
  serverCapabilities?: ReadonlySet<PlatformCapability>;
  collapseOnNavigate: boolean;
  isNavItemActive: (item: WorkspaceNavItem) => boolean;
  onNavigate: () => void;
  onSelectDomain: (domain: WorkspaceDomainId) => void;
  onToggle: () => void;
}

export function WorkspaceSidebar({
  expanded,
  identity,
  branding = EMPTY_PLATFORM_BRANDING,
  identities,
  role,
  local,
  capabilities,
  serverCapabilities,
  collapseOnNavigate,
  isNavItemActive,
  onNavigate,
  onSelectDomain,
  onToggle,
}: WorkspaceSidebarProps) {
  const { i18n, t } = useTranslation();
  const brandingLanguage = i18n?.resolvedLanguage ?? i18n?.language ?? "zh";
  const localizedBranding = resolveBrandingForLanguage(branding, brandingLanguage);
  const sidebarLogo = resolveImageSource(localizedBranding.logoUrl, defaultLogoUrl);
  const availableDomains = WORKSPACE_DOMAINS.filter((domain) =>
    identities.some((item) => item.domain === domain.id),
  );
  const activeDomain = availableDomains.find((domain) => domain.id === identity.domain);
  const contextSections = identities
    .filter((item) => item.domain === identity.domain)
    .flatMap((item) => item.sections.map((section) => ({ identityId: item.id, section })));

  return (
    <aside
      data-testid="sidebar"
      data-expanded={expanded}
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-200",
        expanded ? "w-64 translate-x-0 xl:w-72" : "-translate-x-full md:w-16 md:translate-x-0",
      )}
      aria-label={t("workspace.navigation")}
    >
      <div className="flex h-14 w-full shrink-0 border-b border-sidebar-border">
        <div
          className={cn(
            "flex w-16 shrink-0 items-center justify-center border-r border-sidebar-border bg-sidebar/95 transition-[width] duration-200",
            expanded && "xl:w-24",
          )}
        >
          <img src={sidebarLogo} alt={localizedBranding.name} className="h-7 w-7" />
        </div>
        {expanded ? (
          <div className="flex min-w-0 flex-1 items-center px-4 text-base font-semibold tracking-tight">
            {localizedBranding.name}
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "flex w-16 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar/95 transition-[width] duration-200",
            expanded && "xl:w-24",
          )}
        >
          <nav className="flex w-full flex-1 flex-col items-center gap-1.5 px-2 py-3">
            {availableDomains.map((domain) => {
              const Icon = domain.icon;
              const active = identity.domain === domain.id;
              const label = t(domain.labelKey);
              return (
                <button
                  key={domain.id}
                  type="button"
                  data-testid={`workspace-domain-${domain.id}`}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  title={label}
                  className={cn(
                    "relative flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-muted hover:text-foreground",
                    expanded &&
                      "xl:h-auto xl:min-h-16 xl:w-full xl:flex-col xl:gap-1 xl:px-2 xl:py-2",
                    active &&
                      "bg-sidebar-active text-sidebar-active-foreground shadow-sm ring-1 ring-border",
                  )}
                  onClick={() => onSelectDomain(domain.id)}
                >
                  <Icon className={cn("h-5 w-5 shrink-0", expanded && "xl:h-6 xl:w-6")} />
                  {expanded ? (
                    <span className="hidden min-w-0 truncate text-xs font-medium xl:block">
                      {label}
                    </span>
                  ) : null}
                  {active ? (
                    <span className="absolute -left-2 h-5 w-0.5 rounded-r bg-primary" aria-hidden />
                  ) : null}
                </button>
              );
            })}
          </nav>

          <div
            className={cn(
              "flex w-full flex-col items-center gap-1 border-t border-sidebar-border py-2",
              expanded && "xl:flex-row xl:justify-center",
            )}
          >
            <Button asChild variant="ghost" size="icon">
              <a
                href={resolveDocsUrl(import.meta.env.VITE_DOCS_URL)}
                target="_blank"
                rel="noreferrer"
                aria-label={t("workspace.help")}
                title={t("workspace.help")}
                data-testid="workspace-help-link"
              >
                <CircleHelp />
              </a>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={expanded ? t("topbar.collapseSidebar") : t("topbar.expandSidebar")}
              title={expanded ? t("topbar.collapseSidebar") : t("topbar.expandSidebar")}
              data-testid="sidebar-toggle"
              onClick={onToggle}
            >
              {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          </div>
        </div>

        {expanded ? (
          <div className="flex min-w-0 flex-1 flex-col bg-sidebar">
            <div className="border-b border-sidebar-border p-3">
              {activeDomain ? (
                <WorkspaceContextHeader
                  domain={activeDomain}
                  role={role}
                  serverCapabilities={serverCapabilities}
                />
              ) : null}
            </div>

            <nav
              className="min-h-0 flex-1 overflow-y-auto px-3 py-4"
              data-testid="context-navigation"
            >
              {contextSections.map(({ identityId, section }) => {
                const items = section.items.filter((item) =>
                  canUseWorkspaceNavItem(item, role, local, capabilities, serverCapabilities),
                );
                if (items.length === 0) return null;
                return (
                  <section
                    key={`${identityId}:${section.labelKey}`}
                    className="mb-5 border-b border-sidebar-border pb-5 last:mb-0 last:border-b-0 last:pb-0"
                  >
                    <h2 className="mb-1.5 px-2 text-[11px] font-medium tracking-wide text-muted-foreground">
                      {t(section.labelKey)}
                    </h2>
                    <div className="space-y-1">
                      {items.map((item) => {
                        const Icon = item.icon;
                        const active = isNavItemActive(item);
                        return (
                          <Link
                            key={`${item.to}:${item.hash ?? ""}`}
                            to={item.to}
                            hash={item.hash}
                            data-testid={`workspace-nav-${item.labelKey.replace(/\./g, "-")}`}
                            onClick={() => {
                              if (collapseOnNavigate) onNavigate();
                            }}
                            className={cn(
                              "flex min-h-9 items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors",
                              active
                                ? "bg-sidebar-active font-medium text-sidebar-active-foreground"
                                : "text-sidebar-foreground hover:bg-muted/65",
                            )}
                          >
                            <Icon className="h-4 w-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </nav>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function WorkspaceContextHeader({
  domain,
  role,
  serverCapabilities,
}: {
  domain: (typeof WORKSPACE_DOMAINS)[number];
  role: string | null;
  serverCapabilities?: ReadonlySet<PlatformCapability>;
}) {
  const { t } = useTranslation();
  const Icon = domain.icon;
  const content = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-semibold">{t(domain.labelKey)}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {t("workspace.unifiedNavigation")}
        </span>
      </span>
    </>
  );

  if (domain.id === "platform") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="workspace-platform-capabilities-trigger"
            className="group flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-3 shadow-sm transition-colors hover:bg-muted/45 data-[state=open]:border-brand data-[state=open]:bg-brand-soft"
          >
            {content}
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          className="max-h-[min(38rem,calc(100vh-2rem))] w-[min(44rem,calc(100vw-2rem))] overflow-y-auto p-3"
          data-testid="workspace-platform-capabilities-menu"
        >
          <div className="mb-2 px-1">
            <div className="text-sm font-semibold">{t("settings.operations.title")}</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("settings.operations.popupSubtitle")}
            </p>
          </div>
          <DropdownMenuSeparator />
          <div className="grid gap-3 md:grid-cols-2">
            {OPERATIONS_AREAS.map((area) => (
              <div key={area}>
                <DropdownMenuLabel>{t(`settings.operations.area.${area}`)}</DropdownMenuLabel>
                <div className="space-y-1">
                  {OPERATIONS_LINKS.filter((item) => item.area === area).map((item) => {
                    const ItemIcon = item.icon;
                    const allowed = canAccessOperationsLink(role, item, serverCapabilities);
                    const itemContent = (
                      <>
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background">
                          <ItemIcon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">
                            {t(`settings.operations.link.${item.key}.title`)}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {allowed
                              ? t(`settings.operations.link.${item.key}.description`)
                              : t("settings.operations.requiresRole", {
                                  role: item.requiredRole,
                                })}
                          </span>
                        </span>
                        {allowed ? (
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : null}
                      </>
                    );
                    return allowed ? (
                      <DropdownMenuItem key={item.key} asChild>
                        <a
                          href={operationsHrefForRole(role, item, serverCapabilities)}
                          target="_blank"
                          rel="noreferrer"
                          data-testid={`platform-capability-${item.key}`}
                          className="min-h-12"
                        >
                          {itemContent}
                        </a>
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem key={item.key} disabled className="min-h-12">
                        {itemContent}
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      data-testid="workspace-context-header"
      className="flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-3 shadow-sm"
    >
      {content}
    </div>
  );
}
