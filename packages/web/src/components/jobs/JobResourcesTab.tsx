import { useTranslation } from "react-i18next";
import type { JobDetail } from "./types";

interface JobResourcesTabProps {
  job: JobDetail | undefined;
  loading: boolean;
}

function fmtMem(mb: number | undefined): string {
  if (!mb) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GiB`;
  return `${mb} MiB`;
}

export function JobResourcesTab({ job, loading }: JobResourcesTabProps) {
  const { t } = useTranslation();
  if (loading || !job) {
    return <div className="text-sm text-muted-foreground">{t("common.loading")}</div>;
  }
  const r = job.resources ?? {};
  return (
    <div className="space-y-3" data-testid="job-resources-tab">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3 text-sm">
        <div className="min-w-0">
          <div className="text-xs uppercase text-muted-foreground">
            {t("jobs.resources.cpu", { defaultValue: "CPU" })}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{r.cpus ?? "—"}</div>
        </div>
        <div className="min-w-0">
          <div className="text-xs uppercase text-muted-foreground">
            {t("jobs.resources.memory", { defaultValue: "Memory" })}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtMem(r.memoryMb)}</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("jobs.resources.description", {
          defaultValue:
            "Server returns the resources actually requested at submit time. Placement reasoning, accounting, and per-step resource breakdowns surface in subsequent panels.",
        })}
      </p>
    </div>
  );
}
