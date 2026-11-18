import { Check, ChevronLeft, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  SpackCatalog,
  SpackCatalogPackage,
  SpackCatalogSourceFilter,
  SpackVariantMetadata,
} from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { ResourceSelectField } from "../ui/resource-select-field";
import { SearchInput } from "../ui/search-input";

function buildSpackCatalogSpec(
  pkg: SpackCatalogPackage,
  version: string,
  variantOverrides: Record<string, string>,
) {
  if (
    pkg.defaultSpec &&
    !version.trim() &&
    !Object.values(variantOverrides).some((value) => value.trim())
  )
    return pkg.defaultSpec;
  const versionPart = version.trim().length > 0 ? `@${version.trim()}` : "";
  const variantSpecs =
    pkg.metadata?.variants
      .map((variant) => {
        const override = variantOverrides[variant.name]?.trim();
        if (!override) return null;
        if (override === "+") return `+${variant.name}`;
        if (override === "~") return `~${variant.name}`;
        return `${variant.name}=${override}`;
      })
      .filter((spec): spec is string => spec !== null) ?? [];
  const variantPart = variantSpecs.length > 0 ? ` ${variantSpecs.join(" ")}` : "";
  return `${pkg.metadata?.name ?? pkg.name}${versionPart}${variantPart}`;
}

function isBooleanSpackVariant(variant: SpackVariantMetadata) {
  const values = variant.values.map((value) => value.toLowerCase());
  const defaultValue = variant.default?.toLowerCase();
  return (
    (values.length === 0 && (defaultValue === "true" || defaultValue === "false")) ||
    (values.length > 0 &&
      values.length <= 2 &&
      values.every((value) => value === "true" || value === "false"))
  );
}

export function SpackCatalogPickerDialog({
  catalog,
  error,
  loading,
  onOpenChange,
  onPageChange,
  onRefresh,
  onSelect,
  open,
  search,
  setSearch,
  setSource,
  source,
}: {
  catalog: SpackCatalog | null;
  error: Error | null;
  loading: boolean;
  onOpenChange: (value: boolean) => void;
  onPageChange: (value: number) => void;
  onRefresh: () => void;
  onSelect: (spec: string) => void;
  open: boolean;
  search: string;
  setSearch: (value: string) => void;
  setSource: (value: SpackCatalogSourceFilter) => void;
  source: SpackCatalogSourceFilter;
}) {
  const { t } = useTranslation();
  const packages = catalog?.packages ?? [];
  const [selectedPackage, setSelectedPackage] = useState<SpackCatalogPackage | null>(null);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [variantOverrides, setVariantOverrides] = useState<Record<string, string>>({});
  const selectedSpec = selectedPackage
    ? buildSpackCatalogSpec(selectedPackage, selectedVersion, variantOverrides)
    : "";
  const selectedVariants = selectedPackage?.metadata?.variants ?? [];
  const invalidVariantValue = selectedVariants.find((variant) => {
    if (isBooleanSpackVariant(variant)) return false;
    const override = variantOverrides[variant.name]?.trim();
    return override ? /\s/.test(override) : false;
  });

  const resetCatalogSelection = useCallback(() => {
    setSelectedPackage(null);
    setSelectedVersion("");
    setVariantOverrides({});
  }, []);

  useEffect(() => {
    if (!open) {
      resetCatalogSelection();
    }
  }, [open, resetCatalogSelection]);

  useEffect(() => {
    if (!selectedPackage) return;
    const stillVisible = packages.some(
      (pkg) => pkg.source === selectedPackage.source && pkg.name === selectedPackage.name,
    );
    if (!stillVisible) {
      resetCatalogSelection();
    }
  }, [packages, resetCatalogSelection, selectedPackage]);

  const choosePackage = (pkg: SpackCatalogPackage) => {
    setSelectedPackage(pkg);
    setSelectedVersion("");
    setVariantOverrides({});
  };

  const changeCatalogPage = (page: number) => {
    resetCatalogSelection();
    onPageChange(page);
  };

  const setVariantOverride = (name: string, value: string) => {
    setVariantOverrides((current) => {
      const next = { ...current };
      const normalized = value.trim();
      if (normalized.length === 0) {
        delete next[name];
      } else {
        next[name] = normalized;
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(88vh,860px)] w-[min(calc(100vw-1rem),1120px)]"
        data-testid="cp-software-catalog-picker"
      >
        <DialogHeader>
          <DialogTitle>{t("cp.software.operations.catalogTitle")}</DialogTitle>
          <DialogDescription>{t("cp.software.operations.catalogDescription")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <SearchInput
              aria-label={t("cp.software.operations.catalogSearch")}
              value={search}
              onChange={(event) => {
                resetCatalogSelection();
                setSearch(event.target.value);
                onPageChange(1);
              }}
              placeholder={t("cp.software.operations.catalogSearch")}
              data-testid="cp-software-catalog-search"
            />
            <div className="kq-fill-row gap-1.5">
              {(["all", "upstream", "official", "vendor"] satisfies SpackCatalogSourceFilter[]).map(
                (item) => (
                  <Button
                    key={item}
                    type="button"
                    variant={source === item ? "default" : "outline"}
                    size="sm"
                    onClick={() => {
                      resetCatalogSelection();
                      setSource(item);
                      onPageChange(1);
                    }}
                  >
                    {t(`cp.software.operations.catalogSource.${item}`)}
                  </Button>
                ),
              )}
            </div>
          </div>
          <CatalogPagination catalog={catalog} onPageChange={changeCatalogPage} />
          {error ? (
            <div className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm text-status-failed">
              <span>{toUserFacingError(error, t("cp.software.operations.catalogRetry"))}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={loading}
                data-testid="cp-software-catalog-retry"
              >
                <RotateCcw />
                {t("cp.software.operations.catalogRetry")}
              </Button>
            </div>
          ) : null}
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div
              className="grid min-h-72 auto-rows-max content-start gap-3 overflow-auto border-border p-2 sm:grid-cols-2"
              data-testid="cp-software-catalog-grid"
            >
              {loading ? (
                <div className="col-span-full flex h-32 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("cp.common.loading")}
                </div>
              ) : packages.length === 0 ? (
                <div className="col-span-full flex h-32 items-center justify-center text-sm text-muted-foreground">
                  {t("cp.software.operations.catalogEmpty")}
                </div>
              ) : (
                packages.map((pkg) => (
                  <button
                    key={`${pkg.source}:${pkg.name}`}
                    type="button"
                    className={`grid min-h-32 min-w-0 content-between gap-3 p-3 text-left transition-colors ${
                      selectedPackage?.source === pkg.source && selectedPackage.name === pkg.name
                        ? " "
                        : "border-border"
                    }`}
                    onClick={() => choosePackage(pkg)}
                    data-testid={`cp-software-catalog-package-${pkg.source}-${pkg.name}`}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <span className="break-all font-mono text-sm font-semibold">
                          {pkg.name}
                        </span>
                        <Badge variant={pkg.source === "upstream" ? "outline" : "brand"}>
                          {t(`cp.software.operations.catalogSource.${pkg.source}`)}
                        </Badge>
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                        {pkg.description ?? t("cp.software.operations.catalogNoDescription")}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">
                        {pkg.metadata
                          ? t("cp.software.operations.catalogMeta", {
                              versions: pkg.metadata.versions.length,
                              variants: pkg.metadata.variants.length,
                            })
                          : t("cp.software.operations.catalogNoMetadata")}
                      </span>
                      <span className="inline-flex items-center gap-1 font-medium text-brand">
                        <Check className="h-3.5 w-3.5" />
                        {t("cp.software.operations.catalogChoose")}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="flex min-h-0 flex-col gap-3 border-border p-3">
              <div>
                <div className="text-sm font-medium">
                  {t("cp.software.operations.catalogSpecTitle")}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {selectedPackage
                    ? (selectedPackage.description ??
                      t("cp.software.operations.catalogNoDescription"))
                    : t("cp.software.operations.catalogSpecEmpty")}
                </div>
              </div>
              {selectedPackage ? (
                <>
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium" htmlFor="cp-spack-catalog-version">
                      {t("cp.software.operations.catalogVersion")}
                    </label>
                    <ResourceSelectField
                      resourceType="software-versions"
                      id="cp-spack-catalog-version"
                      value={selectedVersion}
                      onChange={(event) => setSelectedVersion(event.target.value)}
                      data-testid="cp-software-catalog-version"
                    >
                      <option value="">{t("cp.software.operations.catalogVersionDefault")}</option>
                      {(selectedPackage.metadata?.versions ?? []).map((version) => (
                        <option key={version} value={version}>
                          {version}
                        </option>
                      ))}
                    </ResourceSelectField>
                  </div>
                  <div className="min-h-0">
                    <div className="mb-1.5 text-xs font-medium">
                      {t("cp.software.operations.catalogVariants")}
                    </div>
                    {selectedVariants.length > 0 ? (
                      <div className="max-h-44 space-y-1 overflow-auto border-border p-2">
                        {selectedVariants.map((variant) => {
                          const booleanVariant = isBooleanSpackVariant(variant);
                          const variantInputId = `cp-spack-catalog-variant-${variant.name}`;
                          const variantListId = `${variantInputId}-values`;
                          return (
                            <div
                              key={variant.name}
                              className="grid min-w-0 gap-1 px-1.5 py-1 text-xs "
                            >
                              <label
                                className="flex min-w-0 items-center justify-between gap-2"
                                htmlFor={`cp-spack-catalog-variant-${variant.name}`}
                              >
                                <span className="min-w-0">
                                  <span className="font-mono">{variant.name}</span>
                                  {variant.default ? (
                                    <span className="ml-1 text-muted-foreground">
                                      {t("cp.software.operations.catalogVariantDefault", {
                                        value: variant.default,
                                      })}
                                    </span>
                                  ) : null}
                                </span>
                                {booleanVariant ? (
                                  <NativeSelect
                                    id={variantInputId}
                                    className="h-8 max-w-32 text-xs"
                                    value={variantOverrides[variant.name] ?? ""}
                                    onChange={(event) =>
                                      setVariantOverride(variant.name, event.target.value)
                                    }
                                    data-testid={`cp-software-catalog-variant-${variant.name}`}
                                  >
                                    <option value="">
                                      {t("cp.software.operations.catalogVariantUseDefault")}
                                    </option>
                                    <option value="+">
                                      {t("cp.software.operations.catalogVariantEnable")}
                                    </option>
                                    <option value="~">
                                      {t("cp.software.operations.catalogVariantDisable")}
                                    </option>
                                  </NativeSelect>
                                ) : (
                                  <span className="grid gap-1">
                                    <Input
                                      id={variantInputId}
                                      list={variant.values.length > 0 ? variantListId : undefined}
                                      className="h-8 max-w-36 bg-background px-2 text-xs"
                                      value={variantOverrides[variant.name] ?? ""}
                                      onChange={(event) =>
                                        setVariantOverride(variant.name, event.target.value)
                                      }
                                      placeholder={t(
                                        "cp.software.operations.catalogVariantValuePlaceholder",
                                      )}
                                      data-testid={`cp-software-catalog-variant-${variant.name}`}
                                    />
                                    {variant.values.length > 0 ? (
                                      <datalist id={variantListId}>
                                        {variant.values.map((value) => (
                                          <option key={value} value={value} />
                                        ))}
                                      </datalist>
                                    ) : null}
                                  </span>
                                )}
                              </label>
                              {variant.description ? (
                                <span className="text-muted-foreground">{variant.description}</span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className=" border-border p-2 text-xs text-muted-foreground">
                        {t("cp.software.operations.catalogVariantsEmpty")}
                      </div>
                    )}
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium" htmlFor="cp-spack-catalog-spec">
                      {t("cp.software.operations.catalogSpec")}
                    </label>
                    <Input
                      id="cp-spack-catalog-spec"
                      value={selectedSpec}
                      readOnly
                      className="font-mono text-xs"
                      data-testid="cp-software-catalog-spec"
                    />
                    {invalidVariantValue ? (
                      <div
                        className="text-xs text-status-failed"
                        data-testid="cp-software-catalog-spec-validation"
                      >
                        {t("cp.software.operations.catalogVariantValueInvalid", {
                          name: invalidVariantValue.name,
                        })}
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-auto grid gap-2">
                    <Button
                      type="button"
                      onClick={() => onSelect(selectedSpec)}
                      disabled={Boolean(invalidVariantValue)}
                    >
                      <Check />
                      {t("cp.software.operations.catalogUseSpec")}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <CatalogPagination catalog={catalog} onPageChange={changeCatalogPage} compact />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function CatalogPagination({
  catalog,
  compact = false,
  onPageChange,
}: {
  catalog: SpackCatalog | null;
  compact?: boolean;
  onPageChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  if (!catalog) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {t("cp.software.operations.catalogPage", {
          page: catalog.page,
          totalPages: catalog.totalPages,
          totalCount: catalog.totalCount,
        })}
      </span>
      <div className="flex gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.max(1, catalog.page - 1))}
          disabled={!catalog.hasPrevious}
          title={t("cp.software.operations.catalogPrev")}
        >
          <ChevronLeft />
          {compact ? null : t("cp.software.operations.catalogPrev")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(catalog.page + 1)}
          disabled={!catalog.hasNext}
          title={t("cp.software.operations.catalogNext")}
        >
          {compact ? null : t("cp.software.operations.catalogNext")}
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
