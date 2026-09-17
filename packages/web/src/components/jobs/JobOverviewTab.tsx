import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { relativeFromNow, statusToBadgeVariant } from "../../lib/format";
import { toUserFacingExecutionFailure } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import type { JobDetail } from "./types";

interface JobOverviewTabProps {
  job: JobDetail | undefined;
  loading: boolean;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 rounded-md border border-border bg-card px-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-start sm:gap-3">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-words font-mono text-xs">{value ?? "—"}</span>
    </div>
  );
}

function MonoValue({ value }: { value: string }) {
  return (
    <span className="block min-w-0 truncate" title={value}>
      {value}
    </span>
  );
}

function CommandValue({ value }: { value: string }) {
  return (
    <code className="block max-h-32 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/40 px-2 py-1">
      {value}
    </code>
  );
}

export function JobOverviewTab({ job, loading }: JobOverviewTabProps) {
  const { t } = useTranslation();
  if (loading || !job) {
    return <div className="text-sm text-muted-foreground">{t("common.loading")}</div>;
  }
  const failed = job.status.toLowerCase() === "failed";
  const recordedFailure = job.errorMessage ?? job.reason;
  const failureReason = recordedFailure
    ? toUserFacingExecutionFailure(recordedFailure, t("jobs.overview.failureUnavailable"))
    : t("jobs.overview.failureUnavailable");
  const schedulerReason = job.reason
    ? toUserFacingExecutionFailure(job.reason, t("jobs.overview.schedulerReasonUnavailable"))
    : null;
  return (
    <div className="space-y-3" data-testid="job-overview-tab">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusToBadgeVariant(job.status)}>{job.status}</Badge>
        {job.exitCode !== null && job.exitCode !== undefined ? (
          <Badge variant="outline">exit {job.exitCode}</Badge>
        ) : null}
      </div>
      {failed ? (
        <section
          className="space-y-2 rounded-md border border-status-failed/30 bg-[color-mix(in_oklab,var(--status-failed)_8%,transparent)] px-3 py-3"
          data-testid="job-error-summary"
          aria-label={t("jobs.overview.failureDetails")}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-status-failed">
            <CircleAlert className="h-4 w-4 shrink-0" />
            {t("jobs.overview.failureDetails")}
          </div>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {failureReason}
          </p>
          {job.exitCode !== null && job.exitCode !== undefined ? (
            <p className="text-xs text-muted-foreground">
              {t("jobs.overview.exitCode", { value: job.exitCode })}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("jobs.overview.failureGuidance")}</p>
        </section>
      ) : null}
      <div className="grid gap-2">
        <Field label={t("jobs.overview.jobId")} value={<MonoValue value={job.id} />} />
        <Field label={t("jobs.overview.name")} value={<MonoValue value={job.name} />} />
        {job.usecasePackageName ? (
          <Field
            label={t("jobs.overview.usecase", { defaultValue: "Usecase" })}
            value={
              <MonoValue
                value={`${job.usecasePackageName}@${job.usecasePackageVersion ?? "unknown"}`}
              />
            }
          />
        ) : null}
        {job.appTemplateKey ? (
          <Field
            label={t("jobs.overview.app", { defaultValue: "Application" })}
            value={<MonoValue value={job.appTemplateKey} />}
          />
        ) : null}
        {job.softwareRequirements && job.softwareRequirements.length > 0 ? (
          <Field
            label={t("jobs.overview.software", { defaultValue: "Software" })}
            value={job.softwareRequirements
              .map((item) => `${item.name}${item.version ? `@${item.version}` : ""}`)
              .join(", ")}
          />
        ) : null}
        {job.command ? (
          <Field label={t("jobs.overview.command")} value={<CommandValue value={job.command} />} />
        ) : null}
        <Field
          label={t("jobs.overview.schedulerId")}
          value={job.schedulerJobId ? <MonoValue value={job.schedulerJobId} /> : "—"}
        />
        <Field
          label={t("jobs.overview.agent")}
          value={job.agentId ? <MonoValue value={job.agentId} /> : "—"}
        />
        {job.node ? (
          <Field label={t("jobs.overview.node")} value={<MonoValue value={job.node} />} />
        ) : null}
        {schedulerReason ? (
          <Field
            label={t("jobs.overview.schedulerReason")}
            value={<MonoValue value={schedulerReason} />}
          />
        ) : null}
        <Field
          label={t("jobs.overview.submitted")}
          value={
            <>
              {relativeFromNow(job.submittedAt)}{" "}
              <span className="text-muted-foreground">({job.submittedAt})</span>
            </>
          }
        />
        <Field
          label={t("jobs.overview.started")}
          value={job.startedAt ? relativeFromNow(job.startedAt) : "—"}
        />
        <Field
          label={t("jobs.overview.completed")}
          value={job.completedAt ? relativeFromNow(job.completedAt) : "—"}
        />
      </div>
    </div>
  );
}
