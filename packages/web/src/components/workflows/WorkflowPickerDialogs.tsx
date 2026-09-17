import { Check, Search, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsecasePackage, WorkflowTemplate } from "../../lib/software-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { parsePublishedWorkflowTemplate } from "../../lib/workflow-parser";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

type UsecaseRuntime = "all" | "Spack" | "Singularity" | "Bare";
type UsecaseInput = "all" | "Text" | "File";
const TEMPLATE_FAVORITES_KEY = "kq_workflow_template_favorites";

function storedTemplateIds(key: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function WorkflowTemplatePickerDialog({
  error,
  hasNext,
  loading,
  onApply,
  onFiltersChange,
  onOpenChange,
  onPageChange,
  open,
  page,
  selectedId,
  tags,
  templates,
  total,
}: {
  error: unknown;
  hasNext: boolean;
  loading: boolean;
  onApply: (template: WorkflowTemplate) => void;
  onFiltersChange: (filters: { query: string; tag: string }) => void;
  onOpenChange: (open: boolean) => void;
  onPageChange: (page: number) => void;
  open: boolean;
  page: number;
  selectedId: string | null;
  tags: string[];
  templates: WorkflowTemplate[];
  total: number;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() =>
    storedTemplateIds(TEMPLATE_FAVORITES_KEY),
  );
  const [draftId, setDraftId] = useState<string | null>(selectedId);
  const templateValidity = useMemo(
    () =>
      new Map(
        templates.map((template) => [
          template.id,
          parsePublishedWorkflowTemplate(template.yamlContent).ok,
        ]),
      ),
    [templates],
  );
  const draft =
    templates.find(
      (template) => template.id === draftId && templateValidity.get(template.id) === true,
    ) ?? null;

  useEffect(() => {
    if (open) {
      setDraftId(selectedId);
      setQuery("");
      setTag("");
      onFiltersChange({ query: "", tag: "" });
    }
  }, [onFiltersChange, open, selectedId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(86vh,820px)] w-[min(calc(100vw-1rem),1040px)]"
        data-testid="workflow-template-picker-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("workflows.templates.pickerTitle")}</DialogTitle>
          <DialogDescription>{t("workflows.templates.pickerDescription")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px]">
            <div className="relative min-w-0">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setQuery(nextQuery);
                  onFiltersChange({ query: nextQuery, tag });
                }}
                placeholder={t("workflows.templates.searchPlaceholder")}
                className="pl-8"
                data-testid="workflow-template-search"
              />
            </div>
            <select
              value={tag}
              onChange={(event) => {
                const nextTag = event.target.value;
                setTag(nextTag);
                onFiltersChange({ query, tag: nextTag });
              }}
              aria-label={t("workflows.templates.tagFilter")}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              data-testid="workflow-template-tag-filter"
            >
              <option value="">{t("workflows.templates.allTags")}</option>
              {tags.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div
            className="grid min-h-72 flex-1 auto-rows-max content-start gap-3 overflow-auto rounded-md border border-border bg-background p-2 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="workflow-template-grid"
          >
            {loading ? (
              <PickerState text={t("common.loading")} />
            ) : error ? (
              <PickerState
                failed
                text={toUserFacingError(error, t("workflows.templates.loadFailed"))}
              />
            ) : templates.length === 0 ? (
              <PickerState seamless text={t("workflows.templates.noMatches")} />
            ) : (
              templates.map((template) => {
                const valid = templateValidity.get(template.id) === true;
                const selected = valid && template.id === draftId;
                return (
                  <article
                    key={template.id}
                    className={`relative min-h-40 min-w-0 rounded-md border bg-card p-3 text-left transition-colors hover:border-brand/50 hover:bg-muted/30 ${
                      selected ? "border-brand ring-1 ring-brand/40" : "border-border"
                    }`}
                  >
                    <button
                      type="button"
                      className="absolute inset-0 z-0 rounded-md"
                      aria-label={template.name}
                      aria-pressed={selected}
                      disabled={!valid}
                      title={valid ? undefined : t("software.card.invalidUseUnavailable")}
                      data-testid={`workflow-template-option-${template.id}`}
                      onClick={() => valid && setDraftId(template.id)}
                    />
                    <div className="pointer-events-none relative z-[1] flex min-w-0 items-start justify-between gap-2 pr-7">
                      <span className="truncate text-sm font-semibold">{template.name}</span>
                      {selected ? (
                        <Check className="h-4 w-4 shrink-0 text-brand" />
                      ) : !valid ? (
                        <Badge variant="failed">{t("software.card.invalidWorkflow")}</Badge>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="absolute right-2 top-2 z-10 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-brand"
                      aria-label={t("workflows.templates.toggleFavorite", { name: template.name })}
                      onClick={() => {
                        const next = favoriteIds.includes(template.id)
                          ? favoriteIds.filter((id) => id !== template.id)
                          : [...favoriteIds, template.id];
                        setFavoriteIds(next);
                        window.localStorage.setItem(TEMPLATE_FAVORITES_KEY, JSON.stringify(next));
                      }}
                    >
                      <Star className={favoriteIds.includes(template.id) ? "fill-current" : ""} />
                    </button>
                    <p className="pointer-events-none relative z-[1] mt-1 font-mono text-[11px] text-muted-foreground">
                      v{template.version}
                    </p>
                    <p className="pointer-events-none relative z-[1] mt-3 line-clamp-3 text-xs leading-5 text-muted-foreground">
                      {template.description ?? t("software.card.noDescription")}
                    </p>
                    <div className="pointer-events-none relative z-[1] mt-3 flex flex-wrap gap-1">
                      {template.tags.slice(0, 4).map((value) => (
                        <Badge key={value} variant="outline">
                          {value}
                        </Badge>
                      ))}
                    </div>
                  </article>
                );
              })
            )}
          </div>
          {!loading && !error && total > 0 ? (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t("workflows.templates.resultCount", { count: total })}</span>
              <div className="flex gap-2">
                <Button
                  disabled={page === 1}
                  onClick={() => onPageChange(page - 1)}
                  size="sm"
                  type="button"
                  variant="outline"
                  data-testid="workflow-template-previous-page"
                >
                  {t("common.previous")}
                </Button>
                <Button
                  disabled={!hasNext}
                  onClick={() => onPageChange(page + 1)}
                  size="sm"
                  type="button"
                  variant="outline"
                  data-testid="workflow-template-next-page"
                >
                  {t("common.next")}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {draft
              ? t("workflows.templates.pendingSelection", { name: draft.name })
              : t("workflows.templates.noSelection")}
          </span>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!draft}
              onClick={() => {
                if (draft) {
                  onApply(draft);
                }
              }}
              data-testid="workflow-template-apply"
            >
              {t("workflows.templates.apply")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function softwareSummary(pkg: UsecasePackage): string {
  const software = pkg.spec.software;
  if (software.kind === "Spack") {
    return `${software.name}${software.version ? `@${software.version}` : ""}`;
  }
  if (software.kind === "Singularity") return `${software.image}:${software.tag}`;
  return "Bare";
}

function usecaseMatches(
  pkg: UsecasePackage,
  query: string,
  runtime: UsecaseRuntime,
  input: UsecaseInput,
): boolean {
  const needle = query.trim().toLowerCase();
  const matchesQuery =
    needle.length === 0 ||
    [pkg.name, pkg.version, pkg.description ?? "", softwareSummary(pkg)].some((value) =>
      value.toLowerCase().includes(needle),
    );
  const matchesRuntime = runtime === "all" || pkg.spec.software.kind === runtime;
  const matchesInput =
    input === "all" || pkg.spec.usecase.inputSlots.some((slot) => slot.kind === input);
  return matchesQuery && matchesRuntime && matchesInput;
}

export function WorkflowUsecasePickerDialog({
  error,
  loading,
  onApply,
  onOpenChange,
  open,
  packages,
}: {
  error: unknown;
  loading: boolean;
  onApply: (pkg: UsecasePackage) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  packages: UsecasePackage[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [runtime, setRuntime] = useState<UsecaseRuntime>("all");
  const [input, setInput] = useState<UsecaseInput>("all");
  const [draftId, setDraftId] = useState<string | null>(null);
  const filtered = useMemo(
    () => packages.filter((pkg) => usecaseMatches(pkg, query, runtime, input)),
    [input, packages, query, runtime],
  );
  const draft = packages.find((pkg) => pkg.id === draftId) ?? null;

  useEffect(() => {
    if (!open) setDraftId(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[min(86vh,820px)] w-[min(calc(100vw-1rem),1040px)]"
        data-testid="workflow-usecase-picker-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("workflow.editor.usecasePicker.title")}</DialogTitle>
          <DialogDescription>{t("workflow.editor.usecasePicker.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_180px]">
            <div className="relative min-w-0">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("software.usecaseSearchPlaceholder")}
                className="pl-8"
                data-testid="workflow-usecase-search"
              />
            </div>
            <select
              value={runtime}
              onChange={(event) => setRuntime(event.target.value as UsecaseRuntime)}
              aria-label={t("jobs.usecase.runtimeFilter")}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              data-testid="workflow-usecase-runtime-filter"
            >
              <option value="all">{t("jobs.usecase.allRuntimes")}</option>
              <option value="Spack">Spack</option>
              <option value="Singularity">Apptainer</option>
              <option value="Bare">Bare</option>
            </select>
            <select
              value={input}
              onChange={(event) => setInput(event.target.value as UsecaseInput)}
              aria-label={t("jobs.usecase.inputFilter")}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              data-testid="workflow-usecase-input-filter"
            >
              <option value="all">{t("jobs.usecase.allInputs")}</option>
              <option value="Text">{t("jobs.usecase.textInputs")}</option>
              <option value="File">{t("jobs.usecase.fileInputs")}</option>
            </select>
          </div>
          <div className="grid min-h-72 flex-1 auto-rows-max content-start gap-3 overflow-auto rounded-md border border-border bg-background p-2 sm:grid-cols-2 lg:grid-cols-3">
            {loading ? (
              <PickerState text={t("common.loading")} />
            ) : error ? (
              <PickerState
                failed
                text={toUserFacingError(error, t("workflow.editor.usecasePicker.loadFailed"))}
              />
            ) : filtered.length === 0 ? (
              <PickerState text={t("software.noMatches")} />
            ) : (
              filtered.map((pkg) => {
                const selectable = Boolean(pkg.publishedSoftwareRevisionId);
                const selected = selectable && pkg.id === draftId;
                return (
                  <button
                    key={pkg.id}
                    type="button"
                    onClick={() => selectable && setDraftId(pkg.id)}
                    onDoubleClick={() => selectable && onApply(pkg)}
                    disabled={!selectable}
                    className={`min-h-40 min-w-0 rounded-md border bg-card p-3 text-left transition-colors hover:border-brand/50 hover:bg-muted/30 ${
                      selected ? "border-brand ring-1 ring-brand/40" : "border-border"
                    }`}
                    data-testid={`workflow-usecase-option-${pkg.id}`}
                    aria-pressed={selected}
                    title={
                      selectable
                        ? t("workflow.editor.usecasePicker.doubleClickHint")
                        : t("workflow.editor.usecasePicker.invalidRevision")
                    }
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{pkg.name}</span>
                      <Badge variant={pkg.spec.software.kind === "Spack" ? "brand" : "outline"}>
                        {pkg.spec.software.kind}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {softwareSummary(pkg)}
                    </p>
                    <p className="mt-3 line-clamp-3 text-xs leading-5 text-muted-foreground">
                      {pkg.description ?? t("software.card.noDescription")}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1">
                      <Badge variant="outline">v{pkg.version}</Badge>
                      <Badge variant="outline">
                        {t("jobs.usecase.inputCount", {
                          count: pkg.spec.usecase.inputSlots.length,
                        })}
                      </Badge>
                      <Badge variant="outline">
                        {t("jobs.usecase.outputCount", {
                          count: pkg.spec.filesomeOutputs?.length ?? 0,
                        })}
                      </Badge>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </DialogBody>
        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {draft
              ? t("workflow.editor.usecasePicker.pendingSelection", { name: draft.name })
              : t("workflow.editor.usecasePicker.noSelection")}
          </span>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!draft}
              onClick={() => {
                if (draft) onApply(draft);
              }}
              data-testid="workflow-usecase-apply"
            >
              {t("workflow.editor.usecasePicker.add")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickerState({
  failed = false,
  seamless = false,
  text,
}: {
  failed?: boolean;
  seamless?: boolean;
  text: string;
}) {
  return (
    <div
      className={`col-span-full flex min-h-64 items-center justify-center p-4 text-center text-sm ${
        failed
          ? "rounded-md border border-status-failed/40 bg-card text-status-failed"
          : seamless
            ? "text-muted-foreground"
            : "rounded-md border border-border bg-card text-muted-foreground"
      }`}
    >
      {text}
    </div>
  );
}
