import { Check } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsecasePackage } from "../../lib/software-client";
import { Badge } from "../ui/badge";
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
import { SearchInput } from "../ui/search-input";
import {
  datasetInputs,
  isBatchFileSlot,
  isStdinTextSlot,
  softwareSummary,
  usecaseInputCount,
  visibleInputSlots,
} from "./job-usecase-inputs";

type UsecaseRuntimeFilter = "all" | "Spack" | "Singularity" | "Bare";

type UsecaseInputFilter = "all" | "text" | "file" | "batch" | "stdin" | "dataset";

const RUNTIME_FILTERS: UsecaseRuntimeFilter[] = ["all", "Spack", "Singularity", "Bare"];

const INPUT_FILTERS: UsecaseInputFilter[] = ["all", "text", "file", "batch", "stdin", "dataset"];

function usecaseMatches(pkg: UsecasePackage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    pkg.name,
    pkg.version,
    pkg.description ?? "",
    softwareSummary(pkg),
    ...visibleInputSlots(pkg).map((slot) => slot.descriptor),
    ...datasetInputs(pkg).map((input) => input.descriptor),
    ...(pkg.spec.filesomeOutputs ?? []).map((slot) => slot.descriptor),
  ].some((value) => value.toLowerCase().includes(q));
}

function matchesUsecaseSoftware(pkg: UsecasePackage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const software = pkg.spec.software;
  const values = [softwareSummary(pkg), software.kind];
  if (software.kind === "Spack") values.push(software.name, software.version ?? "");
  if (software.kind === "Singularity") values.push(software.image, software.tag);
  return values.some((value) => value.toLowerCase().includes(q));
}

function usecaseInputKinds(pkg: UsecasePackage): Set<UsecaseInputFilter> {
  const kinds = new Set<UsecaseInputFilter>();
  for (const slot of visibleInputSlots(pkg)) {
    if (slot.kind === "Text") {
      kinds.add(isStdinTextSlot(pkg, slot.descriptor) ? "stdin" : "text");
    } else {
      kinds.add(isBatchFileSlot(pkg, slot.descriptor) ? "batch" : "file");
    }
  }
  if (datasetInputs(pkg).length > 0) kinds.add("dataset");
  return kinds;
}

function matchesInputFilter(pkg: UsecasePackage, filter: UsecaseInputFilter): boolean {
  return filter === "all" || usecaseInputKinds(pkg).has(filter);
}

function runtimeFilterLabel(
  t: ReturnType<typeof useTranslation>["t"],
  filter: UsecaseRuntimeFilter,
): string {
  if (filter === "all") {
    return t("jobs.usecase.allRuntimes", { defaultValue: "All runtimes" });
  }
  return filter;
}

function inputFilterLabel(
  t: ReturnType<typeof useTranslation>["t"],
  filter: UsecaseInputFilter,
): string {
  const labels = {
    all: t("jobs.usecase.allInputs", { defaultValue: "All inputs" }),
    text: t("jobs.usecase.textInputs", { defaultValue: "Text" }),
    file: t("jobs.usecase.fileInputs", { defaultValue: "File" }),
    batch: t("jobs.usecase.batchInputs", { defaultValue: "Batch file" }),
    stdin: t("jobs.usecase.stdinInputs", { defaultValue: "Stdin" }),
    dataset: t("jobs.usecase.datasetInputs", { defaultValue: "Dataset" }),
  };
  return labels[filter];
}

export function UsecasePickerDialog({
  error,
  loading,
  onOpenChange,
  onSelect,
  open,
  packages,
  selectedId,
}: {
  error: boolean;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  open: boolean;
  packages: UsecasePackage[];
  selectedId: string | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [runtime, setRuntime] = useState<UsecaseRuntimeFilter>("all");
  const [input, setInput] = useState<UsecaseInputFilter>("all");
  const [software, setSoftware] = useState("");
  const filtered = useMemo(
    () =>
      packages.filter(
        (pkg) =>
          usecaseMatches(pkg, query) &&
          (runtime === "all" || pkg.spec.software.kind === runtime) &&
          matchesInputFilter(pkg, input) &&
          matchesUsecaseSoftware(pkg, software),
      ),
    [input, packages, query, runtime, software],
  );
  const choose = (pkg: UsecasePackage) => {
    onSelect(pkg.id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(88vh,900px)] w-[min(calc(100vw-1rem),1120px)]"
        data-testid="submit-usecase-picker-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {t("jobs.usecase.pickerTitle", { defaultValue: "Choose usecase" })}
          </DialogTitle>
          <DialogDescription>
            {t("jobs.usecase.pickerDescription", {
              defaultValue: "Filter by runtime, input shape, and bound software.",
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_160px_160px_minmax(180px,240px)]">
            <SearchInput
              aria-label={t("software.usecaseSearchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("software.usecaseSearchPlaceholder")}
              data-testid="submit-usecase-catalog-search"
            />
            <NativeSelect
              aria-label={t("jobs.usecase.runtimeFilter", {
                defaultValue: "Runtime filter",
              })}
              value={runtime}
              onChange={(event) => setRuntime(event.target.value as UsecaseRuntimeFilter)}
              data-testid="submit-usecase-runtime-filter"
            >
              {RUNTIME_FILTERS.map((filter) => (
                <option key={filter} value={filter}>
                  {runtimeFilterLabel(t, filter)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t("jobs.usecase.inputFilter", { defaultValue: "Input filter" })}
              value={input}
              onChange={(event) => setInput(event.target.value as UsecaseInputFilter)}
              data-testid="submit-usecase-input-filter"
            >
              {INPUT_FILTERS.map((filter) => (
                <option key={filter} value={filter}>
                  {inputFilterLabel(t, filter)}
                </option>
              ))}
            </NativeSelect>
            <Input
              value={software}
              onChange={(event) => setSoftware(event.target.value)}
              placeholder={t("jobs.usecase.softwareFilterPlaceholder", {
                defaultValue: "Software, e.g. gromacs",
              })}
              data-testid="submit-usecase-software-filter"
            />
          </div>
          <div
            className="grid min-h-80 flex-1 auto-rows-max content-start gap-3 overflow-auto border-border p-2 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="submit-usecase-catalog-grid"
          >
            {loading ? (
              <div className=" border-border p-3 text-sm text-muted-foreground">
                {t("common.loading")}
              </div>
            ) : error ? (
              <div className=" p-3 text-sm text-status-failed">{t("software.unreachable")}</div>
            ) : filtered.length === 0 ? (
              <div className=" border-border p-3 text-sm text-muted-foreground">
                {t("software.noMatches")}
              </div>
            ) : (
              filtered.map((pkg) => {
                const selected = pkg.id === selectedId;
                const inputLabels = Array.from(usecaseInputKinds(pkg)).map((kind) =>
                  inputFilterLabel(t, kind),
                );
                return (
                  <button
                    key={pkg.id}
                    type="button"
                    className={`grid min-h-36 min-w-0 content-between gap-3 p-3 text-left transition-colors ${
                      selected ? "text-brand font-semibold" : ""
                    }`}
                    onClick={() => choose(pkg)}
                    data-testid={`submit-usecase-option-${pkg.id}`}
                    aria-pressed={selected}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                          {pkg.name}
                        </span>
                        <Badge variant={pkg.spec.software.kind === "Spack" ? "brand" : "outline"}>
                          {pkg.spec.software.kind}
                        </Badge>
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {softwareSummary(pkg)}
                      </p>
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                        {pkg.description ??
                          t("software.card.noDescription", {
                            defaultValue: "No description",
                          })}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Badge variant="outline">v{pkg.version}</Badge>
                        <Badge variant="outline">
                          {t("jobs.usecase.inputCount", {
                            count: usecaseInputCount(pkg),
                            defaultValue: "{{count}} inputs",
                          })}
                        </Badge>
                        <Badge variant="outline">
                          {t("jobs.usecase.outputCount", {
                            count: pkg.spec.filesomeOutputs?.length ?? 0,
                            defaultValue: "{{count}} outputs",
                          })}
                        </Badge>
                        {inputLabels.map((label) => (
                          <Badge key={label} variant="outline">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex justify-end text-xs">
                      {selected ? (
                        <span className="inline-flex items-center gap-1 font-medium text-brand">
                          <Check className="h-3.5 w-3.5" />
                          {t("software.manage.selected", { defaultValue: "Selected" })}
                        </span>
                      ) : (
                        <span className="font-medium text-brand">
                          {t("software.manage.choose", { defaultValue: "Choose" })}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
