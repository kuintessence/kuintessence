import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  Boxes,
  Container,
  DatabaseZap,
  Network,
  RefreshCw,
  ServerCog,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { getAuthState } from "../../lib/auth";
import { useCpAgents } from "../../lib/use-cp-agents";
import { useCpSoftwareOverview } from "../../lib/use-cp-software";
import { Button } from "../ui/button";

const LINKS = [
  { to: "/cp/software", key: "software", icon: DatabaseZap },
  { to: "/cp/queues", key: "queues", icon: Boxes },
  { to: "/cp/agent-registration", key: "registration", icon: Network },
  { to: "/cp/accounts", key: "accounts", icon: ServerCog },
  { to: "/settings", key: "sandbox", icon: Container },
] as const;

export function CpInfrastructurePage() {
  const { t } = useTranslation();
  const agentsQuery = useCpAgents();
  const softwareQuery = useCpSoftwareOverview();
  const agents = agentsQuery.data ?? [];
  const summary = softwareQuery.data?.summary;
  const hasError = agentsQuery.isError || softwareQuery.isError;
  const role = getAuthState().role;
  const canManagePlatform = role === "platform_admin" || role === "super_admin";

  const retryFailed = () => {
    if (agentsQuery.isError) void agentsQuery.refetch();
    if (softwareQuery.isError) void softwareQuery.refetch();
  };

  return (
    <div className="space-y-4" data-testid="cp-infrastructure-page">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{t("cp.infrastructure.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("cp.infrastructure.subtitle")}</p>
      </div>
      {hasError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4"
          data-testid="cp-infrastructure-error"
          role="alert"
        >
          <div className="flex min-w-0 items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="text-sm font-medium">{t("cp.infrastructure.loadError")}</p>
              <p className="text-xs text-muted-foreground">
                {t("cp.infrastructure.loadErrorDescription")}
              </p>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={retryFailed}>
            <RefreshCw />
            {t("common.retry")}
          </Button>
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-3">
        <Metric
          label={t("cp.infrastructure.agents")}
          value={agentsQuery.isSuccess ? agents.length : null}
        />
        <Metric
          label={t("cp.infrastructure.clusters")}
          value={softwareQuery.isSuccess ? (summary?.clusters ?? 0) : null}
        />
        <Metric
          label={t("cp.infrastructure.software")}
          value={softwareQuery.isSuccess ? (summary?.installedSpecs ?? 0) : null}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {LINKS.map(({ to, key, icon: Icon }) =>
          key === "sandbox" && !canManagePlatform ? (
            <div
              key={key}
              className="group flex min-h-28 gap-3 rounded-lg border border-dashed bg-card p-4"
              data-testid="cp-infrastructure-sandbox-restricted"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {t(`cp.infrastructure.link.${key}.title`)}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {t("cp.infrastructure.link.sandbox.restricted")}
                </span>
              </span>
            </div>
          ) : (
            <Link
              key={key}
              to={to}
              hash={key === "sandbox" ? "security/sandbox-security" : undefined}
              className="group flex min-h-28 gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/45"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {t(`cp.infrastructure.link.${key}.title`)}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {t(`cp.infrastructure.link.${key}.description`)}
                </span>
              </span>
            </Link>
          ),
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value ?? "--"}</div>
    </div>
  );
}
