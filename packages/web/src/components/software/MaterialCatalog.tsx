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
  const [page, setPage] = useState(0);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const latestCurrent = useRef(isCurrent);
  latestCurrent.current = isCurrent;
  const query = SpackMaterialCatalogQuerySchema.safeParse(repository === "" ? {} : { repository });
  const pageCount = Math.max(1, Math.ceil((catalog?.releases.length ?? 0) / PAGE_SIZE));

  const load = useCallback(async (input: SpackMaterialCatalogQuery) => {
    if (!mounted.current || !latestCurrent.current()) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setCatalog(null);
    setError(null);
    setPage(0);
    setLoading(true);
    const current = () =>
      mounted.current &&
      latestCurrent.current() &&
      active.current === controller &&
      !controller.signal.aborted;
    try {
      const result = await listSpackMaterials(input, controller.signal);
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
    setPage(0);
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
        <>
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[40rem] table-fixed text-left text-xs"
              aria-label={t("materials.catalogTitle")}
            >
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="w-[25%] p-2 font-medium">{t("materials.repository")}</th>
                  <th className="p-2 font-medium">Spec</th>
                  <th className="w-[20%] p-2 font-medium">{t("materials.target")}</th>
                  <th className="w-20 p-2 font-medium">{t("materials.catalogSourceCount")}</th>
                  <th className="w-28 p-2 font-medium">{t("materials.catalogTotalBytes")}</th>
                  <th className="w-16 p-2 font-medium">{t("materials.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {catalog.releases.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((release) => (
                  <tr
                    key={`${release.repositoryId}:${release.manifestDigest}`}
                    className="border-b border-border"
                  >
                    <td className="break-all p-2 align-top font-mono">{release.repository}</td>
                    <td className="break-all p-2 align-top font-mono">{release.spec}</td>
                    <td className="break-all p-2 align-top font-mono">{release.target}</td>
                    <td className="break-all p-2 align-top tabular-nums">{release.sourceCount}</td>
                    <td className="break-all p-2 align-top tabular-nums">{release.totalBytes}</td>
                    <td className="p-2 align-top">
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
                    </td>
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
              title={t("materials.catalogPrevious")}
              aria-label={t("materials.catalogPrevious")}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={page + 1 >= pageCount}
              title={t("materials.catalogNext")}
              aria-label={t("materials.catalogNext")}
              onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
            >
              <ChevronRight />
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
