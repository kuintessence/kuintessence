import type { SpackInstallBindingView } from "@kuintessence/shared/browser";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

export function SpackInstallBindingHistory({ view }: { view: SpackInstallBindingView }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(view.history.length / 10));
  return (
    <div className="min-w-0 space-y-2">
      <h4 className="text-xs font-medium">{t("materials.installBinding.history")}</h4>
      <div className="max-w-full overflow-x-auto">
        <table
          className="w-full min-w-[48rem] table-fixed text-left text-xs"
          aria-label={t("materials.installBinding.history")}
        >
          <thead className="border-b border-border">
            <tr>
              <th className="w-20 p-2">{t("materials.lifecycleRevision")}</th>
              <th className="w-24 p-2">{t("materials.status")}</th>
              <th className="w-24 p-2">{t("materials.installBinding.source")}</th>
              <th className="p-2">{t("materials.release")}</th>
              <th className="p-2">{t("materials.lifecycleOperator")}</th>
              <th className="p-2">{t("materials.lifecycleTime")}</th>
              <th className="p-2">{t("materials.lifecycleReason")}</th>
            </tr>
          </thead>
          <tbody>
            {view.history.slice(page * 10, (page + 1) * 10).map((event) => (
              <tr key={event.revision} className="border-b border-border align-top">
                <td className="p-2 tabular-nums">{event.revision}</td>
                <td className="p-2">{t(`materials.installBinding.state.${event.state}`)}</td>
                <td className="p-2">{event.source}</td>
                <td className="break-all p-2 font-mono">
                  {event.binding ? (
                    <>
                      <div>{event.binding.repositoryId}</div>
                      <div>{event.binding.manifestDigest}</div>
                    </>
                  ) : (
                    "-"
                  )}
                </td>
                <td className="break-all p-2 font-mono">{event.operatorId ?? "-"}</td>
                <td className="break-all p-2">
                  <time dateTime={event.createdAt}>{event.createdAt}</time>
                </td>
                <td className="break-all p-2">{event.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.history.length === 0 ? (
        <p className="text-xs">{t("materials.installBinding.historyEmpty")}</p>
      ) : null}
      <div className="flex items-center justify-end gap-2 text-xs">
        <span>
          {page + 1} / {pages}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={page === 0}
          title={t("materials.lifecyclePrevious")}
          aria-label={t("materials.lifecyclePrevious")}
          onClick={() => setPage((value) => Math.max(0, value - 1))}
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={page + 1 >= pages}
          title={t("materials.lifecycleNext")}
          aria-label={t("materials.lifecycleNext")}
          onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}
        >
          <ChevronRight />
        </Button>
      </div>
      {view.historyTruncated ? (
        <p className="text-xs">{t("materials.lifecycleHistoryTruncated")}</p>
      ) : null}
    </div>
  );
}
