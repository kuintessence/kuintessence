import {
  type SpackMaterialBinding,
  type SpackMaterialManagementCatalog,
  type SpackMaterialManagementQuery,
  SpackMaterialManagementQuerySchema,
} from "@kuintessence/shared/browser";
import { ChevronLeft, ChevronRight, ClipboardList, Loader2, RefreshCw, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listSpackMaterialManagement } from "../../lib/spack-material-management-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export type MaterialManagementFilter = Omit<SpackMaterialManagementQuery, "after">;

type Page = {
  catalog: SpackMaterialManagementCatalog;
  query: SpackMaterialManagementQuery;
  cursors: Array<string | undefined>;
};

export function MaterialManagementCatalog({
  isCurrent,
  canInspectRepository,
  onManage,
  inspectionDisabled = false,
  initialFilter = { repository: "", state: "all", limit: 10 },
  onFilterChange,
}: {
  isCurrent: () => boolean;
  canInspectRepository: (repository: string) => boolean;
  onManage: (binding: SpackMaterialBinding) => void;
  inspectionDisabled?: boolean;
  initialFilter?: MaterialManagementFilter;
  onFilterChange?: (filter: MaterialManagementFilter) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [filter, setFilter] = useState(initialFilter);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const selectable = useRef<Page | null>(null);
  const latest = useRef({ isCurrent, canInspectRepository, onManage, inspectionDisabled });
  latest.current = { isCurrent, canInspectRepository, onManage, inspectionDisabled };
  const query = SpackMaterialManagementQuerySchema.safeParse(filter);
  const permitted = isCurrent() && canInspectRepository(filter.repository);
  const visiblePage = permitted ? page : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selectable.current = null;
      active.current?.abort();
      active.current = null;
    };
  }, []);

  function clear() {
    active.current?.abort();
    active.current = null;
    selectable.current = null;
    setPage(null);
    setError(null);
    setLoading(false);
  }

  function edit(next: MaterialManagementFilter) {
    clear();
    setFilter(next);
    onFilterChange?.(next);
  }

  async function load(input: SpackMaterialManagementQuery, cursors: Page["cursors"]) {
    if (
      !mounted.current ||
      !latest.current.isCurrent() ||
      !latest.current.canInspectRepository(input.repository)
    ) {
      return;
    }
    clear();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    const current = () =>
      mounted.current &&
      active.current === controller &&
      !controller.signal.aborted &&
      latest.current.isCurrent() &&
      latest.current.canInspectRepository(input.repository);
    try {
      const catalog = await listSpackMaterialManagement(input, controller.signal);
      if (
        current() &&
        catalog.releases.every((release) => latest.current.canInspectRepository(release.repository))
      ) {
        const result = { catalog, query: input, cursors };
        selectable.current = result;
        setPage(result);
      }
    } catch (cause) {
      if (current()) setError({ cause });
    } finally {
      if (active.current === controller) {
        if (mounted.current) setLoading(false);
        active.current = null;
      }
    }
  }

  function search() {
    if (query.success) void load(query.data, [undefined]);
  }

  return (
    <section
      className="min-w-0 space-y-3 border-t border-border py-3"
      data-testid="material-management-catalog"
    >
      <h3 className="text-xs font-medium">{t("materials.managementTitle")}</h3>
      <form
        className="grid min-w-0 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <label htmlFor={`${id}-repository`} className="min-w-0 space-y-1 text-xs">
          <span>{t("materials.managementRepository")}</span>
          <Input
            id={`${id}-repository`}
            className="font-mono"
            required
            value={filter.repository}
            aria-invalid={filter.repository !== "" && !query.success}
            aria-describedby={
              filter.repository !== "" && !query.success ? `${id}-invalid` : undefined
            }
            onChange={(event) => edit({ ...filter, repository: event.target.value })}
          />
        </label>
        <label htmlFor={`${id}-state`} className="min-w-0 space-y-1 text-xs">
          <span id={`${id}-state-label`}>{t("materials.managementState")}</span>
          <select
            id={`${id}-state`}
            aria-labelledby={`${id}-state-label`}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={filter.state}
            onChange={(event) => {
              const state = event.target.value;
              if (state === "all" || state === "available" || state === "withdrawn") {
                edit({ ...filter, state });
              }
            }}
          >
            <option value="all">{t("materials.managementAll")}</option>
            <option value="available">{t("materials.lifecycleState.available")}</option>
            <option value="withdrawn">{t("materials.lifecycleState.withdrawn")}</option>
          </select>
        </label>
        <label htmlFor={`${id}-limit`} className="min-w-0 space-y-1 text-xs">
          <span id={`${id}-limit-label`}>{t("materials.managementPageSize")}</span>
          <select
            id={`${id}-limit`}
            aria-labelledby={`${id}-limit-label`}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={filter.limit}
            onChange={(event) => edit({ ...filter, limit: Number(event.target.value) })}
          >
            {[1, 5, 10, 20].map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </select>
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="submit"
            size="icon"
            variant="outline"
            disabled={!query.success || !permitted}
            title={t("materials.managementSearch")}
            aria-label={t("materials.managementSearch")}
          >
            {loading ? <Loader2 className="animate-spin" /> : <Search />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={!query.success || !permitted}
            title={t("materials.managementRefresh")}
            aria-label={t("materials.managementRefresh")}
            onClick={search}
          >
            <RefreshCw />
          </Button>
        </div>
      </form>
      {filter.repository !== "" && !query.success ? (
        <p id={`${id}-invalid`} className="text-xs text-status-failed">
          {t("materials.catalogInvalidRepository")}
        </p>
      ) : null}
      {query.success && !permitted ? (
        <p role="alert" className="text-xs text-status-failed">
          {t("materials.managementForbidden")}
        </p>
      ) : null}
      {loading && permitted ? (
        <p role="status" className="text-xs">
          {t("materials.managementLoading")}
        </p>
      ) : null}
      {error && permitted ? (
        <p role="alert" className="text-xs text-status-failed">
          {toUserFacingError(error.cause, t("materials.managementFailed"))}
        </p>
      ) : null}
      {visiblePage?.catalog.releases.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("materials.managementEmpty")}
        </p>
      ) : null}
      {visiblePage && visiblePage.catalog.releases.length > 0 ? (
        <div className="overflow-x-auto">
          <table
            className="w-full min-w-[48rem] table-fixed text-left text-xs"
            aria-label={t("materials.managementTitle")}
          >
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                <th className="w-[24%] p-2 font-medium">{t("materials.repository")}</th>
                <th className="p-2 font-medium">Spec / SHA-256</th>
                <th className="w-[18%] p-2 font-medium">{t("materials.target")}</th>
                <th className="w-24 p-2 font-medium">{t("materials.status")}</th>
                <th className="w-20 p-2 font-medium">{t("materials.lifecycleRevision")}</th>
                <th className="w-16 p-2 font-medium">{t("materials.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {visiblePage.catalog.releases.map((release) => (
                <tr key={release.manifestDigest} className="border-b border-border">
                  <td className="break-all p-2 align-top font-mono">{release.repository}</td>
                  <td className="break-all p-2 align-top font-mono">
                    <div>{release.spec}</div>
                    <div className="text-muted-foreground">{release.manifestDigest}</div>
                  </td>
                  <td className="break-all p-2 align-top font-mono">{release.target}</td>
                  <td className="break-words p-2 align-top">
                    {t(`materials.lifecycleState.${release.state}`)}
                  </td>
                  <td className="break-all p-2 align-top tabular-nums">{release.revision}</td>
                  <td className="p-2 align-top">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={inspectionDisabled}
                      title={t("materials.managementManage")}
                      aria-label={t("materials.managementManage")}
                      onClick={() => {
                        if (
                          mounted.current &&
                          selectable.current === visiblePage &&
                          !latest.current.inspectionDisabled &&
                          latest.current.isCurrent() &&
                          latest.current.canInspectRepository(release.repository)
                        ) {
                          latest.current.onManage({
                            repositoryId: release.repositoryId,
                            manifestDigest: release.manifestDigest,
                          });
                        }
                      }}
                    >
                      <ClipboardList />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {visiblePage ? (
        <div className="flex items-center justify-end gap-2 text-xs">
          <span className="tabular-nums">
            {t("materials.managementPage", { page: visiblePage.cursors.length })}
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={visiblePage.cursors.length < 2}
            title={t("materials.managementPrevious")}
            aria-label={t("materials.managementPrevious")}
            onClick={() => {
              if (selectable.current !== visiblePage || visiblePage.cursors.length < 2) return;
              const cursors = visiblePage.cursors.slice(0, -1);
              void load({ ...visiblePage.query, after: cursors.at(-1) }, cursors);
            }}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={visiblePage.catalog.nextCursor === null}
            title={t("materials.managementNext")}
            aria-label={t("materials.managementNext")}
            onClick={() => {
              const after = visiblePage.catalog.nextCursor;
              if (selectable.current !== visiblePage || after === null) return;
              void load({ ...visiblePage.query, after }, [...visiblePage.cursors, after]);
            }}
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </section>
  );
}
