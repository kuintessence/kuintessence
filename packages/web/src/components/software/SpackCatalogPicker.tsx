import { Boxes, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  SpackCatalog,
  SpackCatalogPackage,
  SpackCatalogSourceFilter,
} from "../../lib/software-client";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { PaginationControls } from "../ui/pagination-controls";
import { SearchInput } from "../ui/search-input";
import { SmallEmpty } from "./SmallEmpty";
import { sourceLabel } from "./software-fields";
import { catalogPackageKey } from "./spack-catalog";

export function CatalogPackagePickerField({
  disabled = false,
  onOpen,
  selected,
}: {
  disabled?: boolean;
  onOpen: () => void;
  selected: SpackCatalogPackage | null;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 flex-col gap-2 border-border p-2 sm:flex-row sm:items-center sm:justify-between"
      data-testid="software-usecase-package-field"
    >
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground">
          {t("software.manage.selectedCatalogPackage")}
        </div>
        {selected ? (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-all font-mono text-sm font-semibold">{selected.name}</span>
            <Badge variant={selected.source === "upstream" ? "outline" : "brand"}>
              {sourceLabel(t, selected.source)}
            </Badge>
          </div>
        ) : (
          <div className="mt-1 text-sm text-muted-foreground">
            {t("software.manage.noSoftwareOption")}
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onOpen}
        disabled={disabled}
        data-testid="software-usecase-open-package-picker"
      >
        <Boxes />
        {selected
          ? t("software.manage.changeCatalogPackage")
          : t("software.manage.chooseCatalogPackage")}
      </Button>
    </div>
  );
}

export function SpackCatalogPickerDialog({
  catalog,
  onOpenChange,
  onSelect,
  open,
  search,
  selected,
  setPage,
  setSearch,
  setSource,
  source,
}: {
  catalog: SpackCatalog | null;
  onOpenChange: (value: boolean) => void;
  onSelect: (pkg: SpackCatalogPackage) => void;
  open: boolean;
  search: string;
  selected: SpackCatalogPackage | null;
  setPage: (value: number) => void;
  setSearch: (value: string) => void;
  setSource: (value: SpackCatalogSourceFilter) => void;
  source: SpackCatalogSourceFilter;
}) {
  const { t } = useTranslation();
  const packages = catalog?.packages ?? [];
  const selectedKey = selected ? catalogPackageKey(selected) : null;
  const choose = (pkg: SpackCatalogPackage) => {
    onSelect(pkg);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(88vh,900px)] w-[min(calc(100vw-1rem),1120px)]"
        data-testid="software-usecase-package-picker"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{t("software.manage.packagePickerTitle")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <SearchInput
              aria-label={t("software.manage.catalogSearch")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("software.manage.catalogSearch")}
              data-testid="software-usecase-catalog-search"
            />
            <div className="kq-fill-row gap-1.5" data-testid="software-usecase-source-filters">
              {(["all", "upstream", "official", "vendor"] satisfies SpackCatalogSourceFilter[]).map(
                (item) => (
                  <Button
                    key={item}
                    type="button"
                    variant={source === item ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSource(item)}
                  >
                    {sourceLabel(t, item)}
                  </Button>
                ),
              )}
            </div>
          </div>
          <CatalogPickerPagination catalog={catalog} onPageChange={setPage} />
          <div
            className="grid min-h-80 flex-1 auto-rows-max content-start gap-3 overflow-auto border-border p-2 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="software-usecase-catalog-grid"
          >
            {packages.length === 0 ? (
              <SmallEmpty icon={<Boxes />} text={t("software.manage.catalogNoMatches")} />
            ) : (
              packages.map((pkg) => {
                const key = catalogPackageKey(pkg);
                const active = key === selectedKey;
                return (
                  <button
                    key={key}
                    type="button"
                    className={cn(
                      "grid min-h-36 min-w-0 content-between gap-3 p-3 text-left transition-colors ",
                      active ? "text-brand" : "",
                    )}
                    onClick={() => choose(pkg)}
                    data-testid={`software-usecase-catalog-package-${pkg.source}-${pkg.name}`}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <span className="break-all font-mono text-sm font-semibold text-foreground">
                          {pkg.name}
                        </span>
                        <Badge variant={pkg.source === "upstream" ? "outline" : "brand"}>
                          {sourceLabel(t, pkg.source)}
                        </Badge>
                      </div>
                      {pkg.description ? (
                        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                          {pkg.description}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {pkg.metadata ? (
                          <>
                            <Badge variant="outline">
                              {t("software.manage.versionCount", {
                                count: pkg.metadata.versions.length,
                              })}
                            </Badge>
                            <Badge variant="outline">
                              {t("software.manage.variantCount", {
                                count: pkg.metadata.variants.length,
                              })}
                            </Badge>
                          </>
                        ) : null}
                        {pkg.tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex justify-end text-xs">
                      {active ? (
                        <span className="inline-flex items-center gap-1 font-medium text-brand">
                          <Check className="h-3.5 w-3.5" />
                          {t("software.manage.selected")}
                        </span>
                      ) : (
                        <span className="font-medium text-brand">
                          {t("software.manage.choose")}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <CatalogPickerPagination catalog={catalog} onPageChange={setPage} compact />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CatalogPickerPagination({
  catalog,
  compact = false,
  onPageChange,
}: {
  catalog: SpackCatalog | null;
  compact?: boolean;
  onPageChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-xs text-muted-foreground">
        {catalog
          ? t("software.manage.catalogResultCount", {
              shown: catalog.packages.length,
              total: catalog.totalCount,
            })
          : t("common.loading")}
      </div>
      {catalog ? (
        <PaginationControls
          previous={{
            disabled: !catalog.hasPrevious,
            onClick: () => onPageChange(Math.max(1, catalog.page - 1)),
            "data-testid": compact
              ? "software-usecase-catalog-prev-bottom"
              : "software-usecase-catalog-prev",
            children: (
              <>
                <ChevronLeft />
                {t("software.manage.previousPage")}
              </>
            ),
          }}
          next={{
            disabled: !catalog.hasNext,
            onClick: () => onPageChange(catalog.page + 1),
            "data-testid": compact
              ? "software-usecase-catalog-next-bottom"
              : "software-usecase-catalog-next",
            children: (
              <>
                {t("software.manage.nextPage")}
                <ChevronRight />
              </>
            ),
          }}
        >
          <span className="font-mono text-[11px] text-muted-foreground">
            {t("software.manage.catalogPageStatus", {
              page: catalog.page,
              total: catalog.totalPages,
            })}
          </span>
        </PaginationControls>
      ) : null}
    </div>
  );
}
