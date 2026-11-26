import {
  type SpackMaterialBinding,
  type SpackMaterialCatalog,
  type SpackMaterialCatalogQuery,
  SpackMaterialCatalogQuerySchema,
} from "@kuintessence/shared/browser";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SoftwareError } from "../../lib/software-client";
import { listSpackMaterials } from "../../lib/spack-materials-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

const PAGE_SIZE = 20;

export function MaterialCatalog({
  isCurrent,
  onInspect,
  inspectionDisabled = false,
}: {
  isCurrent: () => boolean;
  onInspect: (binding: SpackMaterialBinding) => void;
  inspectionDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [repository, setRepository] = useState("");
  const [catalog, setCatalog] = useState<SpackMaterialCatalog | null>(null);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursors, setCursors] = useState<string[]>([]);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const latestCurrent = useRef(isCurrent);
  latestCurrent.current = isCurrent;
  const query = SpackMaterialCatalogQuerySchema.safeParse(repository === "" ? {} : { repository });

  const load = useCallback(async (input: SpackMaterialCatalogQuery, history: string[] = []) => {
    if (!mounted.current || !latestCurrent.current()) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setCatalog(null);
    setError(null);
    setCursors(history);
    setLoading(true);
    const current = () =>
      mounted.current &&
      latestCurrent.current() &&
      active.current === controller &&
      !controller.signal.aborted;
    try {
      const result = await listSpackMaterials(
        { ...input, limit: PAGE_SIZE, after: history.at(-1) },
        controller.signal,
      );
      if (current()) setCatalog(result);
    } catch (cause) {
      if (current()) setError({ cause });
    } finally {
      if (current()) setLoading(false);
      if (active.current === controller) active.current = null;
    }
  }, []);

  // Translation and callback identity changes must not restart the session's initial read.
  useEffect(() => {
    mounted.current = true;
    void load({});
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
    };
  }, [load]);

  function editFilter(value: string) {
    active.current?.abort();
    active.current = null;
    setRepository(value);
    setCatalog(null);
    setError(null);
    setLoading(false);
    setCursors([]);
  }

  return (
    <div className="min-w-0 space-y-3 py-2">
      <h3 className="text-xs font-medium">{t("materials.catalogTitle")}</h3>
      <form
        className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.success) void load(query.data);
        }}
      >
        <label htmlFor={`${id}-repository`} className="min-w-0 flex-1 space-y-1 text-xs">
          <span>{t("materials.catalogRepository")}</span>
          <Input
            id={`${id}-repository`}
            className="font-mono"
            value={repository}
            aria-invalid={!query.success}
            aria-describedby={!query.success ? `${id}-invalid` : undefined}
            onChange={(event) => editFilter(event.target.value)}
          />
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="submit"
            size="icon"
            variant="outline"
            disabled={!query.success}
            title={t("materials.catalogSearch")}
            aria-label={t("materials.catalogSearch")}
          >
            {loading ? <Loader2 className="animate-spin" /> : <Search />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={!query.success}
            title={t("materials.catalogRefresh")}
            aria-label={t("materials.catalogRefresh")}
            onClick={() => {
              if (query.success) void load(query.data);
            }}
          >
            <RefreshCw />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={repository === ""}
            title={t("materials.catalogReset")}
            aria-label={t("materials.catalogReset")}
            onClick={() => {
              editFilter("");
              void load({});
            }}
          >
            <RotateCcw />
          </Button>
        </div>
      </form>
      {!query.success ? (
        <p id={`${id}-invalid`} className="text-xs text-status-failed">
          {t("materials.catalogInvalidRepository")}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-xs">
          {t("materials.catalogLoading")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-status-failed">
          {error.cause instanceof SoftwareError && error.cause.code === "MATERIAL_CATALOG_LIMIT"
            ? t("materials.catalogLimit")
            : toUserFacingError(error.cause, t("materials.catalogFailed"))}
        </p>
      ) : null}
      {catalog?.releases.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("materials.catalogEmpty")}
        </p>
      ) : null}
      {catalog && catalog.releases.length > 0 ? (
        <div className="max-h-[28rem] overflow-auto">
          <Table
            className="w-full min-w-[40rem] table-fixed text-left text-xs"
            aria-label={t("materials.catalogTitle")}
          >
            <TableHeader className="sticky top-0 z-10 border-b border-border text-muted-foreground">
              <TableRow>
                <TableHead className="w-[25%] p-2 font-medium">
                  {t("materials.repository")}
                </TableHead>
                <TableHead className="p-2 font-medium">Spec</TableHead>
                <TableHead className="w-[20%] p-2 font-medium">{t("materials.target")}</TableHead>
                <TableHead className="w-20 p-2 font-medium">
                  {t("materials.catalogSourceCount")}
                </TableHead>
                <TableHead className="w-28 p-2 font-medium">
                  {t("materials.catalogTotalBytes")}
                </TableHead>
                <TableHead className="w-16 p-2 font-medium">{t("materials.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {catalog.releases.map((release) => (
                <TableRow
                  key={`${release.repositoryId}:${release.manifestDigest}`}
                  className="border-b border-border"
                >
                  <TableCell className="break-all p-2 align-top font-mono">
                    {release.repository}
                  </TableCell>
                  <TableCell className="break-all p-2 align-top font-mono">
                    {release.spec}
                  </TableCell>
                  <TableCell className="break-all p-2 align-top font-mono">
                    {release.target}
                  </TableCell>
                  <TableCell className="break-all p-2 align-top tabular-nums">
                    {release.sourceCount}
                  </TableCell>
                  <TableCell className="break-all p-2 align-top tabular-nums">
                    {release.totalBytes}
                  </TableCell>
                  <TableCell className="p-2 align-top">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      title={t("materials.inspect")}
                      aria-label={t("materials.inspect")}
                      disabled={inspectionDisabled}
                      onClick={() => {
                        if (mounted.current && latestCurrent.current()) {
                          onInspect({
                            repositoryId: release.repositoryId,
                            manifestDigest: release.manifestDigest,
                          });
                        }
                      }}
                    >
                      <Eye />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {catalog && (catalog.releases.length > 0 || cursors.length > 0) ? (
        <div className="flex items-center justify-end gap-2 text-xs">
          <span className="tabular-nums">
            {t("materials.catalogPage", { page: cursors.length + 1 })}
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={cursors.length === 0}
            title={t("materials.catalogPrevious")}
            aria-label={t("materials.catalogPrevious")}
            onClick={() => {
              if (query.success) void load(query.data, cursors.slice(0, -1));
            }}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={!catalog.nextCursor}
            title={t("materials.catalogNext")}
            aria-label={t("materials.catalogNext")}
            onClick={() => {
              if (query.success && catalog.nextCursor)
                void load(query.data, [...cursors, catalog.nextCursor]);
            }}
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
