import type { JobDataInputs } from "@kuintessence/shared/browser";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { fmtBytes } from "../files/path-picker-utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ResourceSelectField } from "../ui/resource-select-field";
import { SearchInput } from "../ui/search-input";

interface DatasetOption {
  assetId: string;
  assetName: string;
  assetKind: string;
  tags: string[];
  versionId: string;
  version: string;
  manifestDigest: string;
  format: string | null;
  schemaUri: string | null;
  sizeBytes: number | null;
  input: DatasetInputValue;
}

type DatasetInputValue = Extract<JobDataInputs[string], { source: "data-market" }>;

export function asDatasetInput(
  value: JobDataInputs[string] | undefined,
): DatasetInputValue | undefined {
  return value?.source === "data-market" ? value : undefined;
}

interface DatasetOptionsResp {
  options: DatasetOption[];
  total: number;
  limit: number;
  offset: number;
}

export function DatasetInputPicker({
  activeOrganizationId,
  descriptor,
  onChange,
  onValidityChange,
  usecaseId,
  value,
}: {
  activeOrganizationId: string | null;
  descriptor: string;
  onChange: (value: DatasetInputValue | undefined) => void;
  onValidityChange: (valid: boolean) => void;
  usecaseId: string;
  value: DatasetInputValue | undefined;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectionVerified, setSelectionVerified] = useState(value === undefined);
  const optionsQ = useInfiniteQuery({
    queryKey: ["usecase-dataset-options", activeOrganizationId, usecaseId, descriptor, query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        descriptor,
        q: query.trim(),
        limit: "25",
        offset: String(pageParam),
      });
      return api.get<DatasetOptionsResp>(
        `/jobs/usecase/${usecaseId}/dataset-options?${params.toString()}`,
      );
    },
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.options.length;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    retry: false,
  });
  const options = optionsQ.data?.pages.flatMap((page) => page.options) ?? [];
  const selected = options.find((option) => option.versionId === value?.versionId);
  const selectionValid = value === undefined || selectionVerified;

  useEffect(() => {
    if (value === undefined) {
      setSelectionVerified(true);
      onValidityChange(true);
    } else if (optionsQ.isError) {
      setSelectionVerified(false);
      onValidityChange(false);
    } else if (!optionsQ.isFetching && query.trim().length === 0) {
      const valid = selected !== undefined;
      setSelectionVerified(valid);
      onValidityChange(valid);
    }
  }, [onValidityChange, optionsQ.isError, optionsQ.isFetching, query, selected, value]);

  const displayedOptions =
    value && !selected
      ? [
          {
            assetId: value.assetId,
            assetName: selectionValid
              ? t("jobs.usecase.datasetSelectedCurrent")
              : t("jobs.usecase.datasetSelectedUnavailable"),
            assetKind: "",
            tags: [],
            versionId: value.versionId,
            version: value.versionId,
            manifestDigest: value.manifestDigest,
            format: null,
            schemaUri: null,
            sizeBytes: null,
            input: value,
          },
          ...options,
        ]
      : options;

  return (
    <div className="space-y-2" data-testid={`submit-usecase-dataset-${descriptor}`}>
      <SearchInput
        aria-label={t("jobs.usecase.datasetSearchPlaceholder")}
        data-testid={`submit-usecase-dataset-search-${descriptor}`}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("jobs.usecase.datasetSearchPlaceholder")}
        value={query}
      />
      <div className="flex items-center gap-2">
        <ResourceSelectField
          searchable={false}
          resourceType="dataset-versions"
          recent
          className="min-w-0 flex-1"
          data-testid={`submit-usecase-dataset-select-${descriptor}`}
          disabled={optionsQ.isLoading || optionsQ.isError || displayedOptions.length === 0}
          onChange={(event) => {
            const option = options.find((candidate) => candidate.versionId === event.target.value);
            setSelectionVerified(option !== undefined);
            onValidityChange(option !== undefined);
            onChange(option?.input);
          }}
          value={value?.versionId ?? ""}
        >
          <option value="">
            {optionsQ.isLoading
              ? t("jobs.usecase.datasetLoading")
              : optionsQ.isError
                ? t("jobs.usecase.datasetLoadFailed")
                : options.length === 0
                  ? t("jobs.usecase.datasetEmpty")
                  : t("jobs.usecase.datasetPlaceholder")}
          </option>
          {displayedOptions.map((option) => (
            <option key={option.versionId} value={option.versionId}>
              {option.assetName} / {option.version}
            </option>
          ))}
        </ResourceSelectField>
        <Button
          aria-label={t("jobs.usecase.refreshDatasets")}
          data-testid={`submit-usecase-dataset-refresh-${descriptor}`}
          disabled={optionsQ.isFetching}
          onClick={() => optionsQ.refetch()}
          size="icon"
          type="button"
          variant="ghost"
        >
          <RefreshCw className={optionsQ.isFetching ? "animate-spin" : undefined} />
        </Button>
        {value ? (
          <Button
            aria-label={t("jobs.usecase.clearDataset")}
            data-testid={`submit-usecase-dataset-clear-${descriptor}`}
            onClick={() => onChange(undefined)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        ) : null}
      </div>
      {optionsQ.isError ? (
        <p className="text-xs text-status-failed" role="alert">
          {toUserFacingError(optionsQ.error, t("jobs.usecase.datasetLoadFailed"))}
        </p>
      ) : null}
      {value && !selectionValid ? (
        <p className="text-xs text-status-failed" role="alert">
          {optionsQ.isError
            ? t("jobs.usecase.datasetSelectionUnverified")
            : t("jobs.usecase.datasetSelectionUnavailable")}
        </p>
      ) : null}
      {!optionsQ.isLoading && !optionsQ.isError && options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("jobs.usecase.datasetEmptyHint")}</p>
      ) : null}
      {selected ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{selected.assetKind}</Badge>
          {selected.format ? <Badge variant="outline">{selected.format}</Badge> : null}
          {selected.sizeBytes !== null ? <span>{fmtBytes(selected.sizeBytes)}</span> : null}
          {selected.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      ) : null}
      {optionsQ.hasNextPage ? (
        <Button
          data-testid={`submit-usecase-dataset-load-more-${descriptor}`}
          disabled={optionsQ.isFetchingNextPage}
          onClick={() => optionsQ.fetchNextPage()}
          size="sm"
          type="button"
          variant="outline"
        >
          {optionsQ.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
          {t("jobs.usecase.datasetLoadMore")}
        </Button>
      ) : null}
    </div>
  );
}
