import type { SpackMaterialLifecycleView } from "@kuintessence/shared/browser";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

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
            <Table
              className="w-full min-w-[42rem] table-fixed text-left text-xs"
              aria-label={t("materials.lifecycleHistory")}
            >
              <TableHeader className="border-b border-border text-muted-foreground">
                <TableRow>
                  <TableHead className="w-20 p-2 font-medium">
                    {t("materials.lifecycleRevision")}
                  </TableHead>
                  <TableHead className="w-24 p-2 font-medium">{t("materials.status")}</TableHead>
                  <TableHead className="w-44 p-2 font-medium">
                    {t("materials.lifecycleOperator")}
                  </TableHead>
                  <TableHead className="w-44 p-2 font-medium">
                    {t("materials.lifecycleTime")}
                  </TableHead>
                  <TableHead className="p-2 font-medium">
                    {t("materials.lifecycleReason")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.history.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((event) => (
                  <TableRow key={event.revision} className="border-b border-border">
                    <TableCell className="p-2 align-top tabular-nums">{event.revision}</TableCell>
                    <TableCell className="p-2 align-top">
                      {t(`materials.lifecycleState.${event.state}`)}
                    </TableCell>
                    <TableCell className="break-all p-2 align-top font-mono">
                      {event.operatorId}
                    </TableCell>
                    <TableCell className="break-all p-2 align-top font-mono">
                      <time dateTime={event.createdAt}>{event.createdAt}</time>
                    </TableCell>
                    <TableCell className="break-all p-2 align-top">{event.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
