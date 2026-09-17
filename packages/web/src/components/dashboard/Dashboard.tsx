import { hasRole, Role, type RoleName } from "@kuintessence/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, GitBranch, ListTodo, Server } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../lib/api-client";
import { getAuthState } from "../../lib/auth";
import {
  type AgentRow,
  type AuditEntry,
  activeJobCount,
  activeWorkflowCount,
  bucketHourly,
  isPlatformBootstrap,
  type JobRow,
  onlineAgentCount,
  type WorkflowRunRow,
} from "../../lib/dashboard-data";
import { isLocalMode, useLocalCapabilities } from "../../lib/local-mode";
import { usePlatformCapability } from "../../lib/platform-capabilities";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { PageHeader, PageShell } from "../ui/page";
import { AgentsTable } from "./AgentsTable";
import { EventsList } from "./EventsList";
import { QuickStart } from "./QuickStart";
import { StatCard } from "./StatCard";
import { ThroughputChart } from "./ThroughputChart";

const REFETCH_MS = 10_000;

interface JobsResp {
  jobs: JobRow[];
}
interface WorkflowsResp {
  runs: WorkflowRunRow[];
}
interface AgentsResp {
  agents: AgentRow[];
}
interface AuditResp {
  entries: AuditEntry[];
}

export function Dashboard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Audit log is operator+ on the platform branch. Skip the request when the
  // local role can't see it, otherwise every dashboard load eats a 403 in
  // the browser console (and a wasted round-trip). The queryFn still defends
  // against role drift between localStorage and the server.
  const local = isLocalMode();
  const role = getAuthState().role;
  const auditAccess = usePlatformCapability("audit.view");
  const canViewAuditLog =
    !local && (auditAccess.allowed || (role ? hasRole(role as RoleName, Role.OPERATOR) : false));

  // A bare-node local server may not back an agent registry (capability false →
  // /api/agents 501s). Skip the fetch in that case to avoid a console error,
  // mirroring the audit-log skip above. Server mode always fetches.
  const localCaps = useLocalCapabilities();
  const canViewAgents = !local || localCaps?.agents === true;

  const jobsQ = useQuery({
    queryKey: ["dashboard", "jobs"],
    queryFn: () => api.get<JobsResp>("/jobs"),
    refetchInterval: REFETCH_MS,
  });
  const workflowsQ = useQuery({
    queryKey: ["dashboard", "workflows"],
    queryFn: () => api.get<WorkflowsResp>("/workflows"),
    refetchInterval: REFETCH_MS,
  });
  const agentsQ = useQuery({
    queryKey: ["dashboard", "agents"],
    queryFn: () => api.get<AgentsResp>("/agents"),
    refetchInterval: REFETCH_MS,
    enabled: canViewAgents,
  });
  const auditQ = useQuery({
    queryKey: ["dashboard", "audit"],
    queryFn: async () => {
      try {
        return await api.get<AuditResp>("/audit-log?limit=10");
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          return { entries: [], forbidden: true } satisfies AuditResp & { forbidden: true };
        }
        throw err;
      }
    },
    refetchInterval: REFETCH_MS,
    retry: false,
    enabled: canViewAuditLog,
  });

  const jobs = jobsQ.data?.jobs;
  const runs = workflowsQ.data?.runs;
  const agents = agentsQ.data?.agents ?? [];
  const dashboardError = jobsQ.error ?? workflowsQ.error ?? agentsQ.error;

  const buckets = useMemo(() => bucketHourly(jobs), [jobs]);
  const hourlyTotal = useMemo(() => buckets.reduce((acc, b) => acc + b.count, 0), [buckets]);

  const bootstrap = isPlatformBootstrap(jobs, runs);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  return (
    <PageShell className="space-y-6" data-testid="dashboard">
      <PageHeader
        title={t("dashboard.title")}
        subtitle={t("dashboard.subtitle")}
        actions={
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            data-testid="dashboard-refresh-hint"
            title="Auto-refresh interval"
          >
            {t("dashboard.refreshHint")}
          </span>
        }
      />

      {dashboardError ? (
        <div
          className="rounded-md border border-status-failed/40 bg-status-failed/5 p-3 text-sm text-status-failed"
          data-testid="dashboard-load-error"
          role="alert"
        >
          {toUserFacingError(dashboardError, t("dashboard.loadFailed"))}
        </div>
      ) : null}

      {!dashboardError && bootstrap && !jobsQ.isLoading && !workflowsQ.isLoading ? (
        <QuickStart onSubmitted={refresh} />
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={t("dashboard.activeJobs")}
          icon={ListTodo}
          tone="running"
          value={jobsQ.error ? "—" : activeJobCount(jobs)}
          hint={
            jobsQ.error ? t("dashboard.unavailable") : `${jobs?.length ?? 0} ${t("common.total")}`
          }
          testId="stat-active-jobs"
        />
        <StatCard
          title={t("dashboard.workflowsInFlight")}
          icon={GitBranch}
          tone="running"
          value={workflowsQ.error ? "—" : activeWorkflowCount(runs)}
          hint={
            workflowsQ.error
              ? t("dashboard.unavailable")
              : `${runs?.length ?? 0} ${t("common.total")}`
          }
          testId="stat-active-workflows"
        />
        <StatCard
          title={t("dashboard.agentsOnline")}
          icon={Server}
          value={agentsQ.error ? "—" : onlineAgentCount(agents)}
          hint={
            agentsQ.error
              ? t("dashboard.unavailable")
              : `${agents.length} ${t("common.registered")}`
          }
          testId="stat-agents-online"
        />
        <StatCard
          title={t("dashboard.submissions24h")}
          icon={Activity}
          value={jobsQ.error ? "—" : hourlyTotal}
          hint={jobsQ.error ? t("dashboard.unavailable") : t("dashboard.hourlyBuckets")}
          testId="stat-throughput-total"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" data-testid="throughput-card">
          <CardHeader>
            <CardTitle>{t("dashboard.submissionsLast24h")}</CardTitle>
          </CardHeader>
          <CardContent>
            {jobsQ.error ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                {t("dashboard.unavailable")}
              </div>
            ) : (
              <ThroughputChart data={buckets} />
            )}
          </CardContent>
        </Card>

        <Card data-testid="agents-card">
          <CardHeader>
            <CardTitle>{t("dashboard.agents")}</CardTitle>
          </CardHeader>
          <CardContent>
            {agentsQ.error ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                {t("dashboard.unavailable")}
              </div>
            ) : (
              <AgentsTable agents={agents} />
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="events-card">
        <CardHeader>
          <CardTitle>{t("dashboard.recentActivity")}</CardTitle>
        </CardHeader>
        <CardContent>
          <EventsList
            entries={auditQ.data?.entries ?? []}
            forbidden={
              !canViewAuditLog || (auditQ.data as { forbidden?: boolean } | undefined)?.forbidden
            }
          />
        </CardContent>
      </Card>
    </PageShell>
  );
}
