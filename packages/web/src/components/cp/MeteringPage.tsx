import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { downloadAuthedFile } from "../../lib/api-client";
import {
  type MeteringGrouping,
  type MeteringPeriod,
  useMeteringQuery,
} from "../../lib/use-metering-query";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { PageHeader, PageShell } from "../ui/page";
import { MeteringChart } from "./MeteringChart";
import { MeteringWebhooks } from "./MeteringWebhooks";

const PERIODS: MeteringPeriod[] = ["raw", "hourly", "daily", "monthly"];
const GROUPINGS: MeteringGrouping[] = ["user", "org", "cluster", "app"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a Date as a `datetime-local` input value (`YYYY-MM-DDTHH:mm`). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToIso(local: string): string | null {
  const t = Date.parse(local);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

const QUERY_LIMIT = 1000;

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
}

export interface MeteringPageProps {
  showWebhooks?: boolean;
  scopeToActiveOrganization?: boolean;
}

export function MeteringPage({
  showWebhooks = true,
  scopeToActiveOrganization = false,
}: MeteringPageProps) {
  const { t } = useTranslation();

  const now = useMemo(() => new Date(), []);
  const weekAgo = useMemo(() => new Date(now.getTime() - 7 * 24 * 3600 * 1000), [now]);

  const [from, setFrom] = useState<string>(() => toLocalInput(weekAgo));
  const [to, setTo] = useState<string>(() => toLocalInput(now));
  const [period, setPeriod] = useState<MeteringPeriod>("raw");
  const [grouping, setGrouping] = useState<MeteringGrouping>("org");
  const activeOrganizationId = useActiveOrganizationId(scopeToActiveOrganization);

  const fromIso = localToIso(from);
  const toIso = localToIso(to);
  const rangeError =
    !fromIso || !toIso
      ? t("cp.metering.invalidRange")
      : Date.parse(fromIso) > Date.parse(toIso)
        ? t("cp.metering.fromAfterTo")
        : null;
  const q = useMeteringQuery(
    {
      from: fromIso ?? "",
      to: toIso ?? "",
      period,
      grouping,
      limit: QUERY_LIMIT,
      ...(activeOrganizationId ? { orgIds: [activeOrganizationId] } : {}),
    },
    !rangeError,
  );
  const rows = q.data?.rows ?? [];

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function onExportCsv(): Promise<void> {
    if (!fromIso || !toIso || rangeError) return;
    setExporting(true);
    setExportError(null);
    try {
      const qs = new URLSearchParams({
        from: fromIso,
        to: toIso,
        period,
        grouping,
        format: "csv",
        limit: String(QUERY_LIMIT),
      });
      if (activeOrganizationId) qs.set("orgIds", activeOrganizationId);
      await downloadAuthedFile(
        `/metering/export?${qs.toString()}`,
        `metering-${period}-${grouping}.csv`,
      );
    } catch (err) {
      setExportError(toUserFacingError(err, t("cp.metering.loadFailed")));
    } finally {
      setExporting(false);
    }
  }

  return (
    <PageShell data-testid="cp-metering-page">
      <PageHeader
        title={t("cp.metering.title")}
        subtitle={t("cp.metering.subtitle")}
        actions={
          <Button
            variant="outline"
            size="sm"
            data-testid="metering-export"
            disabled={exporting || rows.length === 0 || Boolean(rangeError)}
            onClick={onExportCsv}
          >
            {exporting ? t("cp.metering.exporting") : t("cp.metering.export")}
          </Button>
        }
      />

      {exportError ? (
        <div className="text-xs text-status-failed" data-testid="metering-export-error">
          {t("cp.metering.exportFailed")}: {exportError}
        </div>
      ) : null}

      {rangeError ? (
        <div className="text-xs text-status-failed" data-testid="metering-range-error" role="alert">
          {rangeError}
        </div>
      ) : null}

      <Card>
        <CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="metering-period" className="text-xs font-medium">
              {t("cp.metering.periodLabel")}
            </label>
            <select
              id="metering-period"
              data-testid="metering-period"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={period}
              onChange={(e) => setPeriod(e.target.value as MeteringPeriod)}
            >
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`cp.metering.period.${p}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="metering-grouping" className="text-xs font-medium">
              {t("cp.metering.groupingLabel")}
            </label>
            <select
              id="metering-grouping"
              data-testid="metering-grouping"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={grouping}
              onChange={(e) => setGrouping(e.target.value as MeteringGrouping)}
            >
              {GROUPINGS.map((g) => (
                <option key={g} value={g}>
                  {t(`cp.metering.grouping.${g}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="metering-from" className="text-xs font-medium">
              {t("cp.metering.from")}
            </label>
            <Input
              id="metering-from"
              data-testid="metering-from"
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="metering-to" className="text-xs font-medium">
              {t("cp.metering.to")}
            </label>
            <Input
              id="metering-to"
              data-testid="metering-to"
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {q.error ? (
        <div
          className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
          data-testid="metering-error"
        >
          {toUserFacingError(q.error, t("cp.metering.loadFailed"))}
        </div>
      ) : q.isLoading ? (
        <div className="text-sm text-muted-foreground">{t("cp.metering.loading")}</div>
      ) : rows.length === 0 ? (
        <div
          className="flex h-32 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground"
          data-testid="metering-empty"
        >
          {t("cp.metering.empty")}
        </div>
      ) : (
        <>
          {q.data && q.data.total > rows.length ? (
            <div className="text-xs text-muted-foreground" data-testid="metering-partial-result">
              {t("cp.metering.partialResult", { shown: rows.length, total: q.data.total })}
            </div>
          ) : null}
          <Card>
            <CardContent className="pt-4">
              <div
                className="overflow-x-auto overscroll-x-contain rounded-md border border-border"
                data-testid="metering-table-scroll"
              >
                <table className="min-w-[44rem] w-full text-sm" data-testid="metering-table">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t("cp.metering.col.key")}</th>
                      <th className="px-3 py-2 font-medium text-right">
                        {t("cp.metering.col.cpuHours")}
                      </th>
                      <th className="px-3 py-2 font-medium text-right">
                        {t("cp.metering.col.gpuHours")}
                      </th>
                      <th className="px-3 py-2 font-medium text-right">
                        {t("cp.metering.col.memMbHours")}
                      </th>
                      <th className="px-3 py-2 font-medium text-right">
                        {t("cp.metering.col.jobCount")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr
                        key={r.groupKey}
                        data-testid={`metering-row-${i}`}
                        className="border-t border-border last:border-b-0"
                      >
                        <td className="px-3 py-2 font-mono text-xs">{r.groupKey}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                          {hours(r.cpuCoreSeconds)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                          {hours(r.gpuSeconds)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                          {hours(r.memoryMbSeconds)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                          {r.jobCount.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("cp.metering.col.cpuHours")}</CardTitle>
            </CardHeader>
            <CardContent>
              <MeteringChart rows={rows} />
            </CardContent>
          </Card>
        </>
      )}

      {showWebhooks ? <MeteringWebhooks organizationId={activeOrganizationId} /> : null}
    </PageShell>
  );
}
