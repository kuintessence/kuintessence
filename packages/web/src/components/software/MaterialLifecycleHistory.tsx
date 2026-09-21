import type { SpackMaterialLifecycleView } from "@kuintessence/shared/browser";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

const PAGE_SIZE = 10;

export function MaterialLifecycleHistory({ view }: { view: SpackMaterialLifecycleView }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(view.history.length / PAGE_SIZE));
  return (
    <div className="min-w-0 space-y-2">
      <h4 className="text-xs font-medium">{t("materials.lifecycleHistory")}</h4>
      {view.history.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("materials.lifecycleHistoryEmpty")}</p>
      ) : (
        <>
          <div className="max-w-full overflow-x-auto">
            <table
              className="w-full min-w-[42rem] table-fixed text-left text-xs"
              aria-label={t("materials.lifecycleHistory")}
            >
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="w-20 p-2 font-medium">{t("materials.lifecycleRevision")}</th>
                  <th className="w-24 p-2 font-medium">{t("materials.status")}</th>
                  <th className="w-44 p-2 font-medium">{t("materials.lifecycleOperator")}</th>
                  <th className="w-44 p-2 font-medium">{t("materials.lifecycleTime")}</th>
                  <th className="p-2 font-medium">{t("materials.lifecycleReason")}</th>
                </tr>
              </thead>
              <tbody>
                {view.history.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((event) => (
                  <tr key={event.revision} className="border-b border-border">
                    <td className="p-2 align-top tabular-nums">{event.revision}</td>
                    <td className="p-2 align-top">{t(`materials.lifecycleState.${event.state}`)}</td>
                    <td className="break-all p-2 align-top font-mono">{event.operatorId}</td>
                    <td className="break-all p-2 align-top font-mono">
                      <time dateTime={event.createdAt}>{event.createdAt}</time>
                    </td>
                    <td className="break-all p-2 align-top">{event.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2 text-xs">
            <span className="tabular-nums">
              {page + 1} / {pageCount}
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
              disabled={page + 1 >= pageCount}
              title={t("materials.lifecycleNext")}
              aria-label={t("materials.lifecycleNext")}
              onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
            >
              <ChevronRight />
            </Button>
          </div>
        </>
      )}
      {view.historyTruncated ? (
        <p className="text-xs text-muted-foreground">{t("materials.lifecycleHistoryTruncated")}</p>
      ) : null}
    </div>
  );
}
