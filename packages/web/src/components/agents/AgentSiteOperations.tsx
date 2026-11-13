import { SiteOperationsSchema } from "@kuintessence/shared/browser";
import { useTranslation } from "react-i18next";
import { relativeFromNow } from "../../lib/format";

export function AgentSiteOperations({ value, online }: { value: unknown; online: boolean }) {
  const { t, i18n } = useTranslation();
  const parsed = SiteOperationsSchema.safeParse(value);
  if (!parsed.success)
    return <p className="text-muted-foreground">{t("agents.operations.notReported")}</p>;
  const report = parsed.data;
  const stale = !online || Date.now() - report.observedAt > 300000;
  return (
    <details className="border-t border-border pt-2" data-testid="agent-site-operations">
      <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {t("agents.operations.title")}
      </summary>
      <p className="my-2 text-muted-foreground" role={stale ? "status" : undefined}>
        {t(stale ? "agents.operations.stale" : "agents.operations.observed", {
          time: relativeFromNow(
            new Date(report.observedAt).toISOString(),
            undefined,
            i18n?.resolvedLanguage ?? i18n?.language,
          ),
        })}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">{t("agents.operations.connection")}</dt>
        <dd className="min-w-0 break-words">
          {t(`agents.operations.transport.${report.transport}`)}
        </dd>
        <dt className="text-muted-foreground">{t("agents.operations.trust")}</dt>
        <dd>{t(`agents.operations.trustMode.${report.trust}`)}</dd>
        <dt className="text-muted-foreground">{t("agents.operations.executor")}</dt>
        <dd>{report.executor === "slurm" ? "Slurm" : t("agents.operations.local")}</dd>
        {(["materials", "installation", "jobs", "transfers"] as const).map((channel) => (
          <div key={channel} className="contents">
            <dt className="text-muted-foreground">{t(`agents.operations.${channel}`)}</dt>
            <dd>
              {t(`agents.operations.states.${report[channel].state}`)}
              {report[channel].active ? ` · ${report[channel].active}` : ""}
            </dd>
          </div>
        ))}
        <dt className="text-muted-foreground">{t("agents.operations.update")}</dt>
        <dd>{t(`agents.operations.updates.${report.update.phase}`)}</dd>
        {report.update.checkedAt ? (
          <>
            <dt className="text-muted-foreground">{t("agents.operations.updateChecked")}</dt>
            <dd>
              {relativeFromNow(
                new Date(report.update.checkedAt).toISOString(),
                undefined,
                i18n?.resolvedLanguage ?? i18n?.language,
              )}
            </dd>
          </>
        ) : null}
        {report.update.release ? (
          <>
            <dt className="text-muted-foreground">{t("agents.operations.release")}</dt>
            <dd className="break-all font-mono" title={report.update.release}>
              {report.update.release.slice(0, 12)}
            </dd>
          </>
        ) : null}
      </dl>
      {report.jobs.state === "blocked" ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("agents.operations.reconcileJobs")}</p>
      ) : null}
      {report.installation.state === "failed" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("agents.operations.reconcileInstallation")}
        </p>
      ) : null}
      {report.transfers.state === "failed" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("agents.operations.resumeTransfer")}
        </p>
      ) : null}
    </details>
  );
}
